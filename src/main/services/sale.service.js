'use strict';

const { getDb } = require('../database/connection');
const { nowIso } = require('../../shared/datetime');
const Money = require('../../shared/money');
const { Qty } = Money;
const Calc = require('../../shared/calculation');
const { ValidationError, NotFoundError } = require('../../shared/errors');
const { nextNumber } = require('./sequence.service');
const inventory = require('./inventory.service');
const activity = require('./activity.service');
const settings = require('./settings.service');

/**
 * Completing a sale is a single atomic operation. Either all of the following
 * happen, or none of them do:
 *
 *   1. sales row              5. stock_movements rows
 *   2. sale_items rows        6. debt_account (credit sales)
 *   3. payments row           7. activity log
 *   4. products.stock_milli
 *
 * Cost prices are snapshotted onto sale_items so profit stays historically
 * accurate when a product's cost changes later.
 */

/**
 * Price and validate a cart WITHOUT writing anything. The POS calls this on
 * every keystroke so the on-screen figures come from the same code that will
 * later commit the sale.
 */
function priceCart(input) {
  const db = getDb();
  const items = Array.isArray(input.items) ? input.items : [];
  if (items.length === 0) throw new ValidationError('The cart is empty.');

  const lines = items.map((item, index) => {
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(item.productId);
    if (!product) throw new NotFoundError(`Item ${index + 1} is no longer available.`);
    if (product.status !== 'active') throw new ValidationError(`"${product.name}" is archived and cannot be sold.`);

    const quantityMilli = Qty.parsePositive(item.quantity, `Quantity for "${product.name}"`);
    const unitPricePesewas = item.unitPrice === undefined || item.unitPrice === null || item.unitPrice === ''
      ? product.selling_price_pesewas
      : Money.parsePositive(item.unitPrice, `Price for "${product.name}"`);

    return {
      productId: product.id,
      product,
      productName: product.name,
      barcode: product.barcode,
      unit: product.unit,
      quantityMilli,
      unitPricePesewas,
      costPricePesewas: product.cost_price_pesewas,
      discount: item.discount || null,
      stockMilli: product.stock_milli,
      allowNegative: !!product.allow_negative_stock
    };
  });

  const totals = Calc.cartTotals(lines, {
    discount: input.discount || null,
    chargesPesewas: input.chargesPesewas ? Money.parsePositive(input.chargesPesewas, 'Charges') : 0
  });

  // Spread the sale-level discount across the lines so stored items reconcile
  // exactly to the sale total.
  const allocated = Calc.allocateDiscount(totals.lines.map((l) => l.totals.total), totals.saleDiscount);
  totals.lines.forEach((line, i) => {
    line.allocatedDiscount = allocated[i];
    line.netLineTotal = line.totals.total - allocated[i];
  });

  return totals;
}

function assertStockAvailable(totals, { allowNegativeGlobal }) {
  // Aggregate per product: two cart lines of the same product must not each pass
  // a check that they jointly fail.
  const required = new Map();
  for (const line of totals.lines) {
    required.set(line.productId, (required.get(line.productId) || 0) + line.quantityMilli);
  }
  for (const line of totals.lines) {
    if (!required.has(line.productId)) continue;
    const need = required.get(line.productId);
    required.delete(line.productId);
    if (need > line.stockMilli && !line.allowNegative && !allowNegativeGlobal) {
      throw new ValidationError(
        `Not enough stock for "${line.productName}". Available: ${Qty.display(line.stockMilli)} ${line.unit}, required: ${Qty.display(need)}.`
      );
    }
  }
}

function resolvePayment(input, totalPesewas) {
  const method = String(input.paymentMethod || 'cash');
  if (!['cash', 'momo', 'card', 'credit'].includes(method)) {
    throw new ValidationError('Choose a valid payment method.');
  }

  if (method === 'credit') {
    const deposit = input.amountReceived === undefined || input.amountReceived === null || input.amountReceived === ''
      ? 0
      : Money.parsePositive(input.amountReceived, 'Deposit');
    if (deposit > totalPesewas) throw new ValidationError('A deposit cannot be more than the sale total.');
    if (!input.customerId) throw new ValidationError('Select the customer this credit sale belongs to.');
    return { method, received: deposit, paid: deposit, change: 0, debt: totalPesewas - deposit, depositMethod: input.depositMethod || 'cash' };
  }

  const received = Money.parsePositive(input.amountReceived ?? totalPesewas, 'Amount received');

  if (method === 'cash') {
    const check = Calc.validatePayment({ totalPesewas, amountReceivedPesewas: received });
    if (!check.valid) throw new ValidationError(check.reason);
    return { method, received, paid: totalPesewas, change: check.change, debt: 0 };
  }

  // Mobile Money and Card are transferred for the exact amount — there is no
  // cash drawer to give change from.
  if (received !== totalPesewas) {
    throw new ValidationError(`A ${method === 'momo' ? 'Mobile Money' : 'card'} payment must be for the exact total of ${Money.format(totalPesewas)}.`);
  }
  return { method, received, paid: totalPesewas, change: 0, debt: 0 };
}

function complete(input, { user }) {
  const db = getDb();

  // Idempotency: a double-clicked Complete Sale returns the first sale rather
  // than charging the customer twice.
  const clientRef = input.clientRef ? String(input.clientRef).slice(0, 64) : null;
  if (clientRef) {
    const existing = db.prepare('SELECT id FROM sales WHERE client_ref = ?').get(clientRef);
    if (existing) return { ...getSale(existing.id), duplicate: true };
  }

  const totals = priceCart(input);
  const allowNegativeGlobal = settings.get('inventory.allow_negative_stock', false) === true;
  assertStockAvailable(totals, { allowNegativeGlobal });

  const customerId = input.customerId || null;
  if (customerId) {
    const customer = db.prepare('SELECT id FROM customers WHERE id = ?').get(customerId);
    if (!customer) throw new ValidationError('That customer no longer exists.');
  }

  const payment = resolvePayment({ ...input, customerId }, totals.total);
  const isDemo = settings.get('app.demo_mode', false) === true;

  const run = db.transaction(() => {
    const at = nowIso();
    const invoiceNo = nextNumber('sale', { at: new Date(at) });
    const discount = Calc.normaliseDiscount(input.discount);

    const saleInfo = db.prepare(`
      INSERT INTO sales (
        invoice_no, customer_id, user_id, sold_at,
        subtotal_pesewas, line_discount_pesewas, sale_discount_pesewas, discount_type, discount_value,
        charges_pesewas, total_pesewas, cogs_pesewas, paid_pesewas, change_pesewas, debt_pesewas,
        payment_method, status, is_demo, client_ref, note, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?)
    `).run(
      invoiceNo, customerId, user.id, at,
      totals.subtotal, totals.lineDiscount, totals.saleDiscount,
      discount.type, discount.type === 'none' ? null : String(discount.value),
      totals.charges, totals.total, totals.cost, payment.paid, payment.change, payment.debt,
      payment.method, isDemo ? 1 : 0, clientRef, String(input.note || '').trim() || null, at
    );
    const saleId = saleInfo.lastInsertRowid;

    const insertItem = db.prepare(`
      INSERT INTO sale_items (
        sale_id, product_id, product_name, barcode, unit, quantity_milli,
        unit_price_pesewas, cost_price_pesewas, discount_pesewas, line_total_pesewas
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const line of totals.lines) {
      insertItem.run(
        saleId, line.productId, line.productName, line.barcode, line.unit,
        line.quantityMilli, line.unitPricePesewas, line.costPricePesewas,
        line.totals.discount + line.allocatedDiscount, line.netLineTotal
      );
      inventory.applyMovement({
        productId: line.productId,
        changeMilli: -line.quantityMilli,
        reason: 'sale',
        referenceType: 'sale',
        referenceId: saleId,
        note: invoiceNo,
        user,
        allowNegative: allowNegativeGlobal
      });
    }

    if (payment.paid > 0) {
      db.prepare(`
        INSERT INTO payments (sale_id, customer_id, amount_pesewas, method, paid_at, user_id, note)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        saleId, customerId, payment.paid,
        payment.method === 'credit' ? payment.depositMethod : payment.method,
        at, user.id, payment.method === 'credit' ? 'Deposit on credit sale' : null
      );
    }

    if (payment.debt > 0) {
      db.prepare(`
        INSERT INTO debt_accounts (
          customer_id, sale_id, invoice_no, original_pesewas, paid_pesewas,
          outstanding_pesewas, status, opened_at, user_id
        ) VALUES (?, ?, ?, ?, 0, ?, 'open', ?, ?)
      `).run(customerId, saleId, invoiceNo, payment.debt, payment.debt, at, user.id);

      const customer = db.prepare('SELECT balance_pesewas FROM customers WHERE id = ?').get(customerId);
      const newBalance = Calc.customerDebtBalance({
        previousBalancePesewas: customer.balance_pesewas,
        creditSalePesewas: payment.debt
      });
      db.prepare('UPDATE customers SET balance_pesewas = ?, updated_at = ? WHERE id = ?')
        .run(newBalance, at, customerId);
    }

    activity.log({
      user, action: 'sale.completed', entityType: 'sale', entityId: saleId,
      details: {
        invoice: invoiceNo,
        total: Money.format(totals.total),
        items: totals.lines.length,
        method: payment.method,
        debt: payment.debt ? Money.format(payment.debt) : undefined
      }
    });

    return saleId;
  });

  const saleId = run();
  return { ...getSale(saleId), duplicate: false };
}

function getSale(id) {
  const db = getDb();
  const sale = db.prepare(`
    SELECT s.*, c.name AS customer_name, c.phone AS customer_phone, c.balance_pesewas AS customer_balance_pesewas,
           u.full_name AS cashier_name
    FROM sales s
    LEFT JOIN customers c ON c.id = s.customer_id
    LEFT JOIN users u ON u.id = s.user_id
    WHERE s.id = ?
  `).get(id);
  if (!sale) throw new NotFoundError('That sale could not be found.');

  const items = db.prepare('SELECT * FROM sale_items WHERE sale_id = ? ORDER BY id').all(id);
  const payments = db.prepare(`
    SELECT p.*, u.full_name AS user_name FROM payments p
    LEFT JOIN users u ON u.id = p.user_id WHERE p.sale_id = ? ORDER BY p.id
  `).all(id);
  const refunds = db.prepare('SELECT * FROM refunds WHERE sale_id = ? ORDER BY id').all(id);

  return { sale, items, payments, refunds };
}

function findByInvoice(invoiceNo) {
  const row = getDb().prepare('SELECT id FROM sales WHERE invoice_no = ?').get(String(invoiceNo || '').trim());
  if (!row) throw new NotFoundError(`No sale found with invoice number "${invoiceNo}".`);
  return getSale(row.id);
}

function list({
  search = '', from = null, to = null, customerId = null, userId = null,
  paymentMethod = '', status = '', page = 1, pageSize = 25
} = {}) {
  const where = [];
  const params = {};
  if (search) {
    where.push('(s.invoice_no LIKE @search OR c.name LIKE @search OR c.phone LIKE @search)');
    params.search = `%${search}%`;
  }
  if (from) { where.push('s.sold_at >= @from'); params.from = from; }
  if (to) { where.push('s.sold_at < @to'); params.to = to; }
  if (customerId) { where.push('s.customer_id = @customerId'); params.customerId = customerId; }
  if (userId) { where.push('s.user_id = @userId'); params.userId = userId; }
  if (paymentMethod) { where.push('s.payment_method = @paymentMethod'); params.paymentMethod = paymentMethod; }
  if (status) { where.push('s.status = @status'); params.status = status; }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const db = getDb();
  const total = db.prepare(`
    SELECT COUNT(*) AS n FROM sales s LEFT JOIN customers c ON c.id = s.customer_id ${clause}
  `).get(params).n;

  const rows = db.prepare(`
    SELECT s.*, c.name AS customer_name, u.full_name AS cashier_name,
           (SELECT COUNT(*) FROM sale_items si WHERE si.sale_id = s.id) AS item_count
    FROM sales s
    LEFT JOIN customers c ON c.id = s.customer_id
    LEFT JOIN users u ON u.id = s.user_id
    ${clause}
    ORDER BY s.sold_at DESC, s.id DESC
    LIMIT @limit OFFSET @offset
  `).all({ ...params, limit: pageSize, offset: (page - 1) * pageSize });

  const totals = db.prepare(`
    SELECT COALESCE(SUM(s.total_pesewas), 0) AS total_pesewas,
           COALESCE(SUM(s.refunded_pesewas), 0) AS refunded_pesewas,
           COALESCE(SUM(s.cogs_pesewas), 0) AS cogs_pesewas
    FROM sales s LEFT JOIN customers c ON c.id = s.customer_id ${clause}
  `).get(params);

  return { rows, total, totals, page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)) };
}

// ------------------------------- Held sales --------------------------------

function hold({ label, customerId = null, cart }, { user }) {
  const db = getDb();
  const payload = JSON.stringify(cart || {});
  if (payload.length > 200000) throw new ValidationError('This cart is too large to hold.');
  const items = Array.isArray(cart && cart.items) ? cart.items : [];
  if (items.length === 0) throw new ValidationError('There is nothing in the cart to hold.');

  let totalPesewas = 0;
  try {
    totalPesewas = priceCart(cart).total;
  } catch {
    totalPesewas = 0; // a held cart may reference a since-changed product; hold it anyway
  }

  const info = db.prepare(`
    INSERT INTO held_sales (label, customer_id, user_id, payload, total_pesewas, item_count, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    String(label || '').trim() || `Held ${new Date().toLocaleTimeString('en-GB')}`,
    customerId, user.id, payload, totalPesewas, items.length, nowIso()
  );

  activity.log({ user, action: 'sale.held', entityType: 'held_sale', entityId: info.lastInsertRowid });
  return listHeld({ user });
}

function listHeld({ user, all = false } = {}) {
  const db = getDb();
  const rows = all || (user && user.role !== 'attendant')
    ? db.prepare(`
        SELECT h.*, c.name AS customer_name, u.full_name AS user_name FROM held_sales h
        LEFT JOIN customers c ON c.id = h.customer_id
        LEFT JOIN users u ON u.id = h.user_id ORDER BY h.created_at DESC
      `).all()
    : db.prepare(`
        SELECT h.*, c.name AS customer_name, u.full_name AS user_name FROM held_sales h
        LEFT JOIN customers c ON c.id = h.customer_id
        LEFT JOIN users u ON u.id = h.user_id WHERE h.user_id = ? ORDER BY h.created_at DESC
      `).all(user.id);

  return rows.map((r) => ({ ...r, payload: safeParse(r.payload) }));
}

function resumeHeld(id, { user }) {
  const row = getDb().prepare('SELECT * FROM held_sales WHERE id = ?').get(id);
  if (!row) throw new NotFoundError('That held sale is no longer available.');
  getDb().prepare('DELETE FROM held_sales WHERE id = ?').run(id);
  activity.log({ user, action: 'sale.resumed', entityType: 'held_sale', entityId: id });
  return { cart: safeParse(row.payload), customerId: row.customer_id, label: row.label };
}

function deleteHeld(id, { user }) {
  const row = getDb().prepare('SELECT * FROM held_sales WHERE id = ?').get(id);
  if (!row) throw new NotFoundError('That held sale is no longer available.');
  getDb().prepare('DELETE FROM held_sales WHERE id = ?').run(id);
  activity.log({ user, action: 'sale.held_deleted', entityType: 'held_sale', entityId: id, details: { label: row.label } });
  return listHeld({ user });
}

function safeParse(text) {
  try { return JSON.parse(text); } catch { return { items: [] }; }
}

module.exports = {
  priceCart, complete, getSale, findByInvoice, list,
  hold, listHeld, resumeHeld, deleteHeld, resolvePayment
};
