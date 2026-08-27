'use strict';

const { getDb } = require('../database/connection');
const { nowIso } = require('../../shared/datetime');
const Money = require('../../shared/money');
const { Qty } = Money;
const { UNITS } = require('../../shared/constants');
const { ValidationError, NotFoundError } = require('../../shared/errors');
const inventory = require('./inventory.service');
const activity = require('./activity.service');
const settings = require('./settings.service');

const SELECT = `
  SELECT p.*, c.name AS category_name, s.name AS supplier_name,
         CASE
           WHEN p.stock_milli <= 0 THEN 'out'
           WHEN p.stock_milli <= p.min_stock_milli THEN 'low'
           ELSE 'ok'
         END AS stock_state
  FROM products p
  LEFT JOIN categories c ON c.id = p.category_id
  LEFT JOIN suppliers s ON s.id = p.supplier_id
`;

function normaliseBarcode(value) {
  const text = String(value ?? '').trim();
  return text === '' ? null : text;
}

function validate(input, { id = null } = {}) {
  const name = String(input.name || '').trim();
  if (name.length < 2) throw new ValidationError('Enter a product name of at least 2 characters.');

  const unit = UNITS.includes(input.unit) ? input.unit : 'Piece';
  const costPrice = Money.parsePositive(input.costPrice ?? '0', 'Cost price');
  const sellingPrice = Money.parsePositive(input.sellingPrice ?? '0', 'Selling price');
  const wholesalePrice = input.wholesalePrice === '' || input.wholesalePrice === null || input.wholesalePrice === undefined
    ? null
    : Money.parsePositive(input.wholesalePrice, 'Wholesale price');

  const minStock = Qty.parse(input.minStock ?? '0');
  if (minStock < 0) throw new ValidationError('Minimum stock level cannot be negative.');

  const barcode = normaliseBarcode(input.barcode);
  if (barcode && !/^[A-Za-z0-9\-_.]{4,64}$/.test(barcode)) {
    throw new ValidationError('A barcode may only contain 4-64 letters, numbers, dashes, dots or underscores.');
  }
  const sku = String(input.sku ?? '').trim() || null;

  // Explicit duplicate check so the user gets a clear message before SQLite raises.
  if (barcode) {
    const clash = getDb().prepare('SELECT id, name FROM products WHERE barcode = ? AND id IS NOT ?').get(barcode, id);
    if (clash) throw new ValidationError(`This barcode is already assigned to "${clash.name}".`);
  }
  if (sku) {
    const clash = getDb().prepare('SELECT id, name FROM products WHERE sku = ? AND id IS NOT ?').get(sku, id);
    if (clash) throw new ValidationError(`This SKU is already assigned to "${clash.name}".`);
  }

  return {
    name, sku, barcode, unit, costPrice, sellingPrice, wholesalePrice, minStock,
    categoryId: input.categoryId || null,
    supplierId: input.supplierId || null,
    description: String(input.description ?? '').trim() || null,
    imagePath: String(input.imagePath ?? '').trim() || null,
    status: input.status === 'archived' ? 'archived' : 'active',
    allowNegativeStock: input.allowNegativeStock ? 1 : 0
  };
}

function create(input, { user = null } = {}) {
  const data = validate(input);
  const openingStock = Qty.parse(input.stock ?? '0');
  if (openingStock < 0) throw new ValidationError('Opening stock cannot be negative.');
  const at = nowIso();
  const db = getDb();

  return db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO products
        (name, sku, barcode, category_id, supplier_id, cost_price_pesewas, selling_price_pesewas,
         wholesale_price_pesewas, stock_milli, min_stock_milli, unit, allow_negative_stock,
         image_path, description, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      data.name, data.sku, data.barcode, data.categoryId, data.supplierId,
      data.costPrice, data.sellingPrice, data.wholesalePrice,
      data.minStock, data.unit, data.allowNegativeStock,
      data.imagePath, data.description, data.status, at, at
    );
    const id = info.lastInsertRowid;

    if (openingStock > 0) {
      inventory.applyMovement({
        productId: id, changeMilli: openingStock, reason: 'opening',
        referenceType: 'product', referenceId: id, note: 'Opening stock', user
      });
    }

    activity.log({ user, action: 'product.created', entityType: 'product', entityId: id, details: { name: data.name, barcode: data.barcode } });
    return get(id);
  })();
}

function update(id, input, { user = null } = {}) {
  const existing = getDb().prepare('SELECT * FROM products WHERE id = ?').get(id);
  if (!existing) throw new NotFoundError('That product no longer exists.');
  const data = validate(input, { id });

  getDb().prepare(`
    UPDATE products SET
      name = ?, sku = ?, barcode = ?, category_id = ?, supplier_id = ?,
      cost_price_pesewas = ?, selling_price_pesewas = ?, wholesale_price_pesewas = ?,
      min_stock_milli = ?, unit = ?, allow_negative_stock = ?, image_path = ?,
      description = ?, status = ?, updated_at = ?
    WHERE id = ?
  `).run(
    data.name, data.sku, data.barcode, data.categoryId, data.supplierId,
    data.costPrice, data.sellingPrice, data.wholesalePrice, data.minStock,
    data.unit, data.allowNegativeStock, data.imagePath, data.description,
    data.status, nowIso(), id
  );

  // Stock is deliberately NOT editable here: it only moves through inventory.
  activity.log({
    user, action: 'product.updated', entityType: 'product', entityId: id,
    details: {
      name: data.name,
      priceChanged: existing.selling_price_pesewas !== data.sellingPrice
        ? { from: Money.format(existing.selling_price_pesewas), to: Money.format(data.sellingPrice) }
        : undefined
    }
  });
  return get(id);
}

/**
 * Products are archived rather than deleted once they have any trading history,
 * so past sales, purchases and profit figures stay intact.
 */
function remove(id, { user = null } = {}) {
  const db = getDb();
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
  if (!product) throw new NotFoundError('That product no longer exists.');

  const sold = db.prepare('SELECT COUNT(*) AS n FROM sale_items WHERE product_id = ?').get(id).n;
  const purchased = db.prepare('SELECT COUNT(*) AS n FROM purchase_items WHERE product_id = ?').get(id).n;

  if (sold > 0 || purchased > 0) {
    db.prepare("UPDATE products SET status = 'archived', updated_at = ? WHERE id = ?").run(nowIso(), id);
    activity.log({ user, action: 'product.archived', entityType: 'product', entityId: id, details: { name: product.name, reason: 'has trading history' } });
    return { deleted: false, archived: true, message: `"${product.name}" has sales history, so it was archived instead of deleted.` };
  }

  db.transaction(() => {
    db.prepare('DELETE FROM stock_movements WHERE product_id = ?').run(id);
    db.prepare('DELETE FROM products WHERE id = ?').run(id);
    activity.log({ user, action: 'product.deleted', entityType: 'product', entityId: id, details: { name: product.name } });
  })();
  return { deleted: true, archived: false, message: `"${product.name}" was deleted.` };
}

function get(id) {
  const row = getDb().prepare(`${SELECT} WHERE p.id = ?`).get(id);
  if (!row) throw new NotFoundError('That product no longer exists.');
  return row;
}

function findByBarcode(barcode) {
  const value = normaliseBarcode(barcode);
  if (!value) return null;
  return getDb().prepare(`${SELECT} WHERE p.barcode = ? AND p.status = 'active'`).get(value) || null;
}

/** Paged, indexed search across name, barcode, SKU and category. */
function list({
  search = '', categoryId = null, supplierId = null, stockState = '',
  status = 'active', sort = 'name', direction = 'asc', page = 1, pageSize = 25
} = {}) {
  const where = [];
  const params = {};

  if (status && status !== 'all') { where.push('p.status = @status'); params.status = status; }
  if (search) {
    where.push('(p.name LIKE @search OR p.barcode LIKE @exact OR p.sku LIKE @search OR c.name LIKE @search)');
    params.search = `%${search}%`;
    params.exact = `${search}%`;
  }
  if (categoryId) { where.push('p.category_id = @categoryId'); params.categoryId = categoryId; }
  if (supplierId) { where.push('p.supplier_id = @supplierId'); params.supplierId = supplierId; }
  if (stockState === 'low') where.push('p.stock_milli > 0 AND p.stock_milli <= p.min_stock_milli');
  if (stockState === 'out') where.push('p.stock_milli <= 0');
  if (stockState === 'ok') where.push('p.stock_milli > p.min_stock_milli');

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const sortColumns = {
    name: 'p.name', stock: 'p.stock_milli', price: 'p.selling_price_pesewas',
    cost: 'p.cost_price_pesewas', created: 'p.created_at', category: 'c.name'
  };
  const orderBy = sortColumns[sort] || 'p.name';
  const dir = direction === 'desc' ? 'DESC' : 'ASC';

  const db = getDb();
  const total = db.prepare(`
    SELECT COUNT(*) AS n FROM products p LEFT JOIN categories c ON c.id = p.category_id ${clause}
  `).get(params).n;

  const rows = db.prepare(`${SELECT} ${clause} ORDER BY ${orderBy} ${dir}, p.id LIMIT @limit OFFSET @offset`)
    .all({ ...params, limit: pageSize, offset: (page - 1) * pageSize });

  return { rows, total, page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)) };
}

/** Fast type-ahead used by the POS product search (F2). */
function quickSearch(term, limit = 20) {
  const text = String(term || '').trim();
  if (!text) {
    return getDb().prepare(`${SELECT} WHERE p.status = 'active' ORDER BY p.name LIMIT ?`).all(limit);
  }
  return getDb().prepare(`
    ${SELECT}
    WHERE p.status = 'active' AND (p.name LIKE ? OR p.barcode LIKE ? OR p.sku LIKE ?)
    ORDER BY CASE WHEN p.barcode = ? THEN 0 WHEN p.name LIKE ? THEN 1 ELSE 2 END, p.name
    LIMIT ?
  `).all(`%${text}%`, `${text}%`, `${text}%`, text, `${text}%`, limit);
}

/**
 * Generate an unused internal barcode. Uses a 13-digit EAN-13 style value in the
 * "restricted / in-store" 200-299 prefix range, which is reserved precisely for
 * shop-internal use and will not clash with manufacturer barcodes.
 */
function generateBarcode() {
  const db = getDb();
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const body = `200${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`;
    const barcode = body + ean13CheckDigit(body);
    const taken = db.prepare('SELECT 1 FROM products WHERE barcode = ?').get(barcode);
    if (!taken) return barcode;
  }
  throw new ValidationError('Could not generate a free barcode. Try again.');
}

function ean13CheckDigit(twelveDigits) {
  let sum = 0;
  for (let i = 0; i < 12; i += 1) {
    sum += Number(twelveDigits[i]) * (i % 2 === 0 ? 1 : 3);
  }
  return String((10 - (sum % 10)) % 10);
}

function unitsList() {
  return UNITS.slice();
}

function quantityPrecision() {
  return settings.get('inventory.quantity_precision', 3);
}

module.exports = {
  create, update, remove, get, list, quickSearch, findByBarcode,
  generateBarcode, ean13CheckDigit, unitsList, quantityPrecision, validate
};
