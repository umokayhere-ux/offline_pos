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

/**
 * Purchases / restocking. Recording a purchase atomically:
 *   - stores the purchase and its lines,
 *   - increases stock (with a movement for every line),
 *   - refreshes each product's cost price so future sales snapshot the new cost,
 *   - increases the supplier balance by whatever is still unpaid.
 */

function create(input, { user }) {
  const db = getDb();
  const supplier = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(input.supplierId);
  if (!supplier) throw new ValidationError('Select the supplier this stock came from.');

  const rawItems = Array.isArray(input.items) ? input.items : [];
  if (rawItems.length === 0) throw new ValidationError('Add at least one product to this purchase.');

  const items = rawItems.map((item, index) => {
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(item.productId);
    if (!product) throw new ValidationError(`Line ${index + 1} refers to a product that no longer exists.`);
    const quantityMilli = Qty.parsePositive(item.quantity, `Quantity for "${product.name}"`);
    const costPricePesewas = Money.parsePositive(item.costPrice, `Cost price for "${product.name}"`);
    return {
      product,
      quantityMilli,
      costPricePesewas,
      lineTotalPesewas: Money.multiplyByQty(costPricePesewas, quantityMilli),
      updateCostPrice: item.updateCostPrice === undefined ? true : !!item.updateCostPrice
    };
  });

  const totalPesewas = Money.sum(items.map((i) => i.lineTotalPesewas));
  const paidPesewas = input.amountPaid === undefined || input.amountPaid === null || input.amountPaid === ''
    ? 0
    : Money.parsePositive(input.amountPaid, 'Amount paid');
  if (paidPesewas > totalPesewas) throw new ValidationError('The amount paid is more than the purchase total.');

  const paymentMethod = String(input.paymentMethod || 'cash');
  if (paidPesewas > 0 && !['cash', 'momo', 'card'].includes(paymentMethod)) {
    throw new ValidationError('Choose a valid payment method.');
  }

  const run = db.transaction(() => {
    const at = input.purchasedAt || nowIso();
    const reference = nextNumber('purchase', { at: new Date(at) });
    const balance = totalPesewas - paidPesewas;

    const info = db.prepare(`
      INSERT INTO purchases (reference_no, supplier_id, user_id, purchased_at, total_pesewas,
                             paid_pesewas, balance_pesewas, status, note, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'received', ?, ?)
    `).run(reference, supplier.id, user.id, at, totalPesewas, paidPesewas, balance,
      String(input.note || '').trim() || null, nowIso());
    const purchaseId = info.lastInsertRowid;

    const insertItem = db.prepare(`
      INSERT INTO purchase_items (purchase_id, product_id, product_name, quantity_milli, cost_price_pesewas, line_total_pesewas)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    for (const item of items) {
      insertItem.run(purchaseId, item.product.id, item.product.name, item.quantityMilli,
        item.costPricePesewas, item.lineTotalPesewas);

      inventory.applyMovement({
        productId: item.product.id, changeMilli: item.quantityMilli, reason: 'purchase',
        referenceType: 'purchase', referenceId: purchaseId, note: reference, user, allowNegative: true
      });

      if (item.updateCostPrice && item.costPricePesewas !== item.product.cost_price_pesewas) {
        db.prepare('UPDATE products SET cost_price_pesewas = ?, updated_at = ? WHERE id = ?')
          .run(item.costPricePesewas, nowIso(), item.product.id);
      }
    }

    if (paidPesewas > 0) {
      db.prepare(`
        INSERT INTO supplier_payments (reference_no, supplier_id, purchase_id, amount_pesewas, method, paid_at, user_id, note)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(nextNumber('supplierPayment', { at: new Date(at) }), supplier.id, purchaseId,
        paidPesewas, paymentMethod, at, user.id, `Payment on ${reference}`);
    }

    const newSupplierBalance = Calc.supplierBalance({
      previousBalancePesewas: supplier.balance_pesewas,
      purchasesPesewas: totalPesewas,
      paymentsPesewas: paidPesewas
    });
    db.prepare('UPDATE suppliers SET balance_pesewas = ?, updated_at = ? WHERE id = ?')
      .run(newSupplierBalance, nowIso(), supplier.id);

    activity.log({
      user, action: 'purchase.recorded', entityType: 'purchase', entityId: purchaseId,
      details: {
        reference, supplier: supplier.name, total: Money.format(totalPesewas),
        paid: Money.format(paidPesewas), balance: Money.format(balance), items: items.length
      }
    });

    return purchaseId;
  });

  return get(run());
}

function get(id) {
  const db = getDb();
  const purchase = db.prepare(`
    SELECT p.*, s.name AS supplier_name, s.phone AS supplier_phone, u.full_name AS user_name
    FROM purchases p JOIN suppliers s ON s.id = p.supplier_id
    LEFT JOIN users u ON u.id = p.user_id WHERE p.id = ?
  `).get(id);
  if (!purchase) throw new NotFoundError('That purchase could not be found.');
  const items = db.prepare('SELECT * FROM purchase_items WHERE purchase_id = ? ORDER BY id').all(id);
  const payments = db.prepare('SELECT * FROM supplier_payments WHERE purchase_id = ? ORDER BY id').all(id);
  return { purchase, items, payments };
}

function list({ search = '', supplierId = null, from = null, to = null, unpaidOnly = false, page = 1, pageSize = 25 } = {}) {
  const where = [];
  const params = {};
  if (search) { where.push('(p.reference_no LIKE @search OR s.name LIKE @search)'); params.search = `%${search}%`; }
  if (supplierId) { where.push('p.supplier_id = @supplierId'); params.supplierId = supplierId; }
  if (from) { where.push('p.purchased_at >= @from'); params.from = from; }
  if (to) { where.push('p.purchased_at < @to'); params.to = to; }
  if (unpaidOnly) where.push('p.balance_pesewas > 0');
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const db = getDb();
  const total = db.prepare(`
    SELECT COUNT(*) AS n FROM purchases p JOIN suppliers s ON s.id = p.supplier_id ${clause}
  `).get(params).n;

  const rows = db.prepare(`
    SELECT p.*, s.name AS supplier_name, u.full_name AS user_name,
           (SELECT COUNT(*) FROM purchase_items pi WHERE pi.purchase_id = p.id) AS item_count
    FROM purchases p JOIN suppliers s ON s.id = p.supplier_id
    LEFT JOIN users u ON u.id = p.user_id
    ${clause} ORDER BY p.purchased_at DESC LIMIT @limit OFFSET @offset
  `).all({ ...params, limit: pageSize, offset: (page - 1) * pageSize });

  const totals = db.prepare(`
    SELECT COALESCE(SUM(p.total_pesewas), 0) AS total_pesewas,
           COALESCE(SUM(p.paid_pesewas), 0) AS paid_pesewas,
           COALESCE(SUM(p.balance_pesewas), 0) AS balance_pesewas
    FROM purchases p JOIN suppliers s ON s.id = p.supplier_id ${clause}
  `).get(params);

  return { rows, total, totals, page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)) };
}

module.exports = { create, get, list };
