'use strict';

const { getDb } = require('../database/connection');
const Money = require('../../shared/money');
const { Qty } = Money;
const { UNITS } = require('../../shared/constants');
const datetime = require('../../shared/datetime');
const { ValidationError } = require('../../shared/errors');
const productService = require('./product.service');
const inventory = require('./inventory.service');
const activity = require('./activity.service');

/**
 * CSV import and export.
 *
 * Import is a two-step process on purpose: `analyseProductCsv` validates the
 * WHOLE file and reports every problem before anything is written, and
 * `importProducts` then applies the accepted rows inside a single transaction.
 * A bad CSV therefore either imports completely or not at all — it can never
 * leave the catalogue half-updated.
 */

// ------------------------------- CSV plumbing ------------------------------

/** RFC 4180-style parser: handles quoted fields, embedded commas and newlines. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const input = String(text).replace(/^﻿/, ''); // strip a Windows BOM

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    if (inQuotes) {
      if (char === '"') {
        if (input[i + 1] === '"') { field += '"'; i += 1; } else { inQuotes = false; }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') { inQuotes = true; continue; }
    if (char === ',') { row.push(field); field = ''; continue; }
    if (char === '\r') continue;
    if (char === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += char;
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((cell) => String(cell).trim() !== ''));
}

function toCsv(headers, rows) {
  const escape = (value) => {
    const text = value === null || value === undefined ? '' : String(value);
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [headers.map(escape).join(',')];
  for (const row of rows) lines.push(row.map(escape).join(','));
  return `﻿${lines.join('\r\n')}\r\n`; // BOM so Excel reads UTF-8 correctly
}

// ------------------------------ Product import -----------------------------

const IMPORT_COLUMNS = {
  name: ['product name', 'name', 'product'],
  barcode: ['barcode', 'bar code'],
  sku: ['sku', 'code'],
  category: ['category'],
  costPrice: ['cost price', 'cost'],
  sellingPrice: ['selling price', 'price', 'sell price'],
  stock: ['stock', 'quantity', 'qty'],
  minStock: ['minimum stock', 'min stock', 'reorder level'],
  unit: ['unit']
};

const TEMPLATE_HEADERS = [
  'Product Name', 'Barcode', 'SKU', 'Category', 'Cost Price',
  'Selling Price', 'Stock', 'Minimum Stock', 'Unit'
];

function mapHeaders(headerRow) {
  const normalised = headerRow.map((h) => String(h).trim().toLowerCase());
  const map = {};
  for (const [field, aliases] of Object.entries(IMPORT_COLUMNS)) {
    const index = normalised.findIndex((h) => aliases.includes(h));
    if (index >= 0) map[field] = index;
  }
  return map;
}

/**
 * Validate an entire CSV without writing anything.
 * Returns { valid, invalid, headers, summary } so the UI can show the problems
 * and let the user correct the file before importing.
 */
function analyseProductCsv(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) {
    throw new ValidationError('That file has no data rows. Download the template to see the expected columns.');
  }

  const map = mapHeaders(rows[0]);
  const missing = ['name', 'sellingPrice'].filter((f) => map[f] === undefined);
  if (missing.length) {
    throw new ValidationError('The file must at least contain a "Product Name" column and a "Selling Price" column.');
  }

  const db = getDb();
  const categories = new Map(
    db.prepare('SELECT id, name FROM categories').all().map((c) => [c.name.toLowerCase(), c.id])
  );

  const valid = [];
  const invalid = [];
  const barcodesInFile = new Map();
  const skusInFile = new Map();

  for (let i = 1; i < rows.length; i += 1) {
    const raw = rows[i];
    const lineNumber = i + 1;
    const cell = (field) => (map[field] === undefined ? '' : String(raw[map[field]] ?? '').trim());
    const errors = [];

    const name = cell('name');
    if (name.length < 2) errors.push('Product name is missing or too short.');

    let sellingPrice = 0;
    try { sellingPrice = Money.parsePositive(cell('sellingPrice') || '0', 'Selling price'); }
    catch (e) { errors.push(`Selling price: ${e.message}`); }

    let costPrice = 0;
    try { costPrice = Money.parsePositive(cell('costPrice') || '0', 'Cost price'); }
    catch (e) { errors.push(`Cost price: ${e.message}`); }

    if (costPrice > sellingPrice && sellingPrice > 0) {
      errors.push(`Cost price (${Money.format(costPrice)}) is higher than the selling price (${Money.format(sellingPrice)}).`);
    }

    let stock = 0;
    try {
      stock = Qty.parse(cell('stock') || '0');
      if (stock < 0) errors.push('Stock cannot be negative.');
    } catch (e) { errors.push(`Stock: ${e.message}`); }

    let minStock = 0;
    try {
      minStock = Qty.parse(cell('minStock') || '0');
      if (minStock < 0) errors.push('Minimum stock cannot be negative.');
    } catch (e) { errors.push(`Minimum stock: ${e.message}`); }

    const barcode = cell('barcode') || null;
    if (barcode) {
      if (!/^[A-Za-z0-9\-_.]{4,64}$/.test(barcode)) {
        errors.push('Barcode may only contain 4-64 letters, numbers, dashes, dots or underscores.');
      } else if (barcodesInFile.has(barcode)) {
        errors.push(`Barcode "${barcode}" is also used on line ${barcodesInFile.get(barcode)} of this file.`);
      } else {
        const clash = db.prepare('SELECT name FROM products WHERE barcode = ?').get(barcode);
        if (clash) errors.push(`Barcode "${barcode}" is already assigned to "${clash.name}".`);
        barcodesInFile.set(barcode, lineNumber);
      }
    }

    const sku = cell('sku') || null;
    if (sku) {
      if (skusInFile.has(sku)) {
        errors.push(`SKU "${sku}" is also used on line ${skusInFile.get(sku)} of this file.`);
      } else {
        const clash = db.prepare('SELECT name FROM products WHERE sku = ?').get(sku);
        if (clash) errors.push(`SKU "${sku}" is already assigned to "${clash.name}".`);
        skusInFile.set(sku, lineNumber);
      }
    }

    const unitCell = cell('unit');
    const unit = UNITS.find((u) => u.toLowerCase() === unitCell.toLowerCase()) || 'Piece';
    if (unitCell && !UNITS.find((u) => u.toLowerCase() === unitCell.toLowerCase())) {
      errors.push(`Unknown unit "${unitCell}" — it will be imported as "Piece".`);
    }

    const categoryName = cell('category');
    const record = {
      line: lineNumber, name, barcode, sku, unit,
      categoryName: categoryName || null,
      categoryId: categoryName ? categories.get(categoryName.toLowerCase()) || null : null,
      costPricePesewas: costPrice, sellingPricePesewas: sellingPrice,
      stockMilli: stock, minStockMilli: minStock,
      createCategory: !!categoryName && !categories.has(categoryName.toLowerCase())
    };

    // An unknown unit is a warning, not a blocker.
    const blocking = errors.filter((e) => !e.startsWith('Unknown unit'));
    if (blocking.length) invalid.push({ ...record, errors });
    else valid.push({ ...record, warnings: errors });
  }

  return {
    headers: rows[0],
    valid,
    invalid,
    summary: {
      totalRows: rows.length - 1,
      validCount: valid.length,
      invalidCount: invalid.length,
      newCategories: [...new Set(valid.filter((v) => v.createCategory).map((v) => v.categoryName))]
    }
  };
}

/**
 * Apply a previously analysed CSV. Re-analyses the text so the UI cannot submit
 * rows that were never validated, then writes everything in one transaction.
 */
function importProducts(text, { user, createMissingCategories = true } = {}) {
  const analysis = analyseProductCsv(text);
  if (analysis.valid.length === 0) {
    throw new ValidationError('None of the rows in that file could be imported. Fix the errors listed and try again.');
  }

  const db = getDb();
  const result = db.transaction(() => {
    const at = datetime.nowIso();
    const categoryIds = new Map();

    if (createMissingCategories) {
      for (const name of analysis.summary.newCategories) {
        const info = db.prepare(`
          INSERT INTO categories (name, status, created_at, updated_at) VALUES (?, 'active', ?, ?)
        `).run(name, at, at);
        categoryIds.set(name.toLowerCase(), info.lastInsertRowid);
      }
    }

    let imported = 0;
    for (const row of analysis.valid) {
      const categoryId = row.categoryId
        || (row.categoryName ? categoryIds.get(row.categoryName.toLowerCase()) || null : null);

      const info = db.prepare(`
        INSERT INTO products
          (name, sku, barcode, category_id, cost_price_pesewas, selling_price_pesewas,
           stock_milli, min_stock_milli, unit, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, 'active', ?, ?)
      `).run(row.name, row.sku, row.barcode, categoryId, row.costPricePesewas,
        row.sellingPricePesewas, row.minStockMilli, row.unit, at, at);

      if (row.stockMilli > 0) {
        inventory.applyMovement({
          productId: info.lastInsertRowid, changeMilli: row.stockMilli, reason: 'import',
          referenceType: 'import', note: `Imported from CSV (line ${row.line})`, user
        });
      }
      imported += 1;
    }

    activity.log({
      user, action: 'products.imported', entityType: 'product',
      details: { imported, skipped: analysis.invalid.length, newCategories: analysis.summary.newCategories }
    });

    return { imported, skipped: analysis.invalid.length, invalid: analysis.invalid };
  })();

  return result;
}

function productImportTemplate() {
  return toCsv(TEMPLATE_HEADERS, [
    ['Perfumed Rice 5kg', '6001234567890', 'RICE-5KG', 'Groceries', '35.00', '50.00', '20', '5', 'Box'],
    ['Sugar', '', 'SUG-1KG', 'Groceries', '8.00', '12.00', '30.5', '5', 'Kg']
  ]);
}

// ------------------------------- Exports -----------------------------------

function exportProducts(filters = {}) {
  const { rows } = productService.list({ ...filters, pageSize: 100000, page: 1 });
  return toCsv(
    [...TEMPLATE_HEADERS, 'Stock Value (GHS)', 'Status'],
    rows.map((p) => [
      p.name, p.barcode || '', p.sku || '', p.category_name || '',
      Money.toCedisString(p.cost_price_pesewas),
      Money.toCedisString(p.selling_price_pesewas),
      Qty.display(p.stock_milli), Qty.display(p.min_stock_milli), p.unit,
      Money.toCedisString(Math.round(p.stock_milli * p.cost_price_pesewas / 1000)),
      p.status
    ])
  );
}

/** Turn any report table into CSV using a column definition. */
function exportRows(columns, rows) {
  return toCsv(columns.map((c) => c.label), rows.map((row) => columns.map((c) => c.value(row))));
}

const REPORT_COLUMNS = {
  sales: [
    { label: 'Invoice', value: (r) => r.invoice_no },
    { label: 'Date', value: (r) => datetime.formatDateTime(r.sold_at) },
    { label: 'Customer', value: (r) => r.customer_name || 'Walk-in' },
    { label: 'Cashier', value: (r) => r.cashier_name || '' },
    { label: 'Items', value: (r) => r.item_count },
    { label: 'Total (GHS)', value: (r) => Money.toCedisString(r.total_pesewas) },
    { label: 'Refunded (GHS)', value: (r) => Money.toCedisString(r.refunded_pesewas || 0) },
    { label: 'Cost (GHS)', value: (r) => Money.toCedisString(r.cogs_pesewas || 0) },
    { label: 'Payment', value: (r) => r.payment_method },
    { label: 'Status', value: (r) => r.status }
  ],
  inventory: [
    { label: 'Product', value: (r) => r.name },
    { label: 'SKU', value: (r) => r.sku || '' },
    { label: 'Barcode', value: (r) => r.barcode || '' },
    { label: 'Category', value: (r) => r.category_name || '' },
    { label: 'Stock', value: (r) => Qty.display(r.stock_milli) },
    { label: 'Unit', value: (r) => r.unit },
    { label: 'Minimum', value: (r) => Qty.display(r.min_stock_milli) },
    { label: 'Cost (GHS)', value: (r) => Money.toCedisString(r.cost_price_pesewas) },
    { label: 'Price (GHS)', value: (r) => Money.toCedisString(r.selling_price_pesewas) },
    { label: 'Stock Value (GHS)', value: (r) => Money.toCedisString(r.stock_value_pesewas || 0) }
  ],
  expenses: [
    { label: 'Reference', value: (r) => r.reference_no },
    { label: 'Date', value: (r) => datetime.formatDateTime(r.spent_at) },
    { label: 'Category', value: (r) => r.category_name },
    { label: 'Description', value: (r) => r.description },
    { label: 'Amount (GHS)', value: (r) => Money.toCedisString(r.amount_pesewas) },
    { label: 'Method', value: (r) => r.payment_method },
    { label: 'Recorded by', value: (r) => r.user_name || '' },
    { label: 'Status', value: (r) => r.status }
  ],
  debts: [
    { label: 'Customer', value: (r) => r.customer_name },
    { label: 'Phone', value: (r) => r.customer_phone || '' },
    { label: 'Invoice', value: (r) => r.invoice_no || '' },
    { label: 'Opened', value: (r) => datetime.formatDate(r.opened_at) },
    { label: 'Original (GHS)', value: (r) => Money.toCedisString(r.original_pesewas) },
    { label: 'Paid (GHS)', value: (r) => Money.toCedisString(r.paid_pesewas) },
    { label: 'Outstanding (GHS)', value: (r) => Money.toCedisString(r.outstanding_pesewas) },
    { label: 'Status', value: (r) => r.status }
  ],
  customers: [
    { label: 'Customer', value: (r) => r.name },
    { label: 'Phone', value: (r) => r.phone || '' },
    { label: 'Purchases', value: (r) => r.purchase_count },
    { label: 'Spent (GHS)', value: (r) => Money.toCedisString(r.spent_pesewas || 0) },
    { label: 'Outstanding (GHS)', value: (r) => Money.toCedisString(r.balance_pesewas || 0) },
    { label: 'Last purchase', value: (r) => (r.last_purchase_at ? datetime.formatDate(r.last_purchase_at) : '') }
  ],
  suppliers: [
    { label: 'Supplier', value: (r) => r.name },
    { label: 'Company', value: (r) => r.company || '' },
    { label: 'Phone', value: (r) => r.phone || '' },
    { label: 'Purchases', value: (r) => r.purchase_count },
    { label: 'Purchased (GHS)', value: (r) => Money.toCedisString(r.purchased_pesewas || 0) },
    { label: 'Paid (GHS)', value: (r) => Money.toCedisString(r.paid_pesewas || 0) },
    { label: 'Balance (GHS)', value: (r) => Money.toCedisString(r.balance_pesewas || 0) }
  ],
  refunds: [
    { label: 'Reference', value: (r) => r.reference_no },
    { label: 'Invoice', value: (r) => r.invoice_no },
    { label: 'Date', value: (r) => datetime.formatDateTime(r.refunded_at) },
    { label: 'Customer', value: (r) => r.customer_name || 'Walk-in' },
    { label: 'Amount (GHS)', value: (r) => Money.toCedisString(r.amount_pesewas) },
    { label: 'Method', value: (r) => r.method },
    { label: 'Restocked', value: (r) => (r.restock ? 'Yes' : 'No') },
    { label: 'Reason', value: (r) => r.reason },
    { label: 'Staff', value: (r) => r.user_name || '' }
  ],
  cashiers: [
    { label: 'Staff', value: (r) => r.full_name },
    { label: 'Role', value: (r) => r.role_label },
    { label: 'Sales', value: (r) => r.sale_count },
    { label: 'Revenue (GHS)', value: (r) => Money.toCedisString(r.revenue_pesewas) },
    { label: 'Gross profit (GHS)', value: (r) => Money.toCedisString(r.gross_profit_pesewas) },
    { label: 'Credit issued (GHS)', value: (r) => Money.toCedisString(r.credit_pesewas) }
  ],
  purchases: [
    { label: 'Reference', value: (r) => r.reference_no },
    { label: 'Date', value: (r) => datetime.formatDateTime(r.purchased_at) },
    { label: 'Supplier', value: (r) => r.supplier_name },
    { label: 'Items', value: (r) => r.item_count },
    { label: 'Total (GHS)', value: (r) => Money.toCedisString(r.total_pesewas) },
    { label: 'Paid (GHS)', value: (r) => Money.toCedisString(r.paid_pesewas) },
    { label: 'Balance (GHS)', value: (r) => Money.toCedisString(r.balance_pesewas) }
  ],
  activity: [
    { label: 'Date', value: (r) => datetime.formatDateTime(r.created_at) },
    { label: 'User', value: (r) => r.user_full_name || r.username || 'System' },
    { label: 'Action', value: (r) => r.action },
    { label: 'Entity', value: (r) => `${r.entity_type || ''}${r.entity_id ? ` #${r.entity_id}` : ''}` },
    { label: 'Details', value: (r) => r.details || '' }
  ]
};

function exportReport(kind, rows) {
  const columns = REPORT_COLUMNS[kind];
  if (!columns) throw new ValidationError(`There is no export defined for "${kind}".`);
  return exportRows(columns, rows || []);
}

module.exports = {
  parseCsv, toCsv, analyseProductCsv, importProducts,
  productImportTemplate, exportProducts, exportReport, REPORT_COLUMNS
};
