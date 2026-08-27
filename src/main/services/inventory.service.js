'use strict';

const { getDb } = require('../database/connection');
const { nowIso } = require('../../shared/datetime');
const { Qty } = require('../../shared/money');
const { ValidationError, NotFoundError } = require('../../shared/errors');
const activity = require('./activity.service');

/**
 * The ONLY place product stock is allowed to change.
 *
 * Every movement writes a stock_movements row alongside the products update, so
 * the ledger and the on-hand figure can never drift apart. Callers must already
 * be inside a transaction when the movement belongs to a larger operation
 * (a sale, a refund, a purchase).
 */

function applyMovement({
  productId,
  changeMilli,
  reason,
  referenceType = null,
  referenceId = null,
  note = null,
  user = null,
  allowNegative = false
}) {
  Qty.assert(changeMilli, 'Stock change');
  if (changeMilli === 0) throw new ValidationError('Stock change cannot be zero.');

  const db = getDb();
  const product = db.prepare('SELECT id, name, stock_milli, allow_negative_stock FROM products WHERE id = ?').get(productId);
  if (!product) throw new NotFoundError('That product no longer exists.');

  const before = product.stock_milli;
  const after = before + changeMilli;

  if (after < 0 && !allowNegative && !product.allow_negative_stock) {
    throw new ValidationError(
      `Not enough stock for "${product.name}". Available: ${Qty.display(before)}, required: ${Qty.display(-changeMilli)}.`
    );
  }

  db.prepare('UPDATE products SET stock_milli = ?, updated_at = ? WHERE id = ?').run(after, nowIso(), productId);
  db.prepare(`
    INSERT INTO stock_movements
      (product_id, change_milli, before_milli, after_milli, reason, reference_type, reference_id, note, user_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(productId, changeMilli, before, after, reason, referenceType, referenceId, note, user ? user.id : null, nowIso());

  return { productId, before, after, changeMilli };
}

/** A deliberate correction by a member of staff. A reason is mandatory. */
function adjustStock({ productId, newQuantityMilli = null, changeMilli = null, reason, user }) {
  const text = String(reason || '').trim();
  if (text.length < 3) throw new ValidationError('Give a reason for this stock adjustment.');

  const db = getDb();
  const product = db.prepare('SELECT id, name, stock_milli FROM products WHERE id = ?').get(productId);
  if (!product) throw new NotFoundError('That product no longer exists.');

  let delta = changeMilli;
  if (delta === null || delta === undefined) {
    if (newQuantityMilli === null || newQuantityMilli === undefined) {
      throw new ValidationError('Enter the new stock quantity.');
    }
    Qty.assert(newQuantityMilli, 'Quantity');
    delta = newQuantityMilli - product.stock_milli;
  }
  if (delta === 0) throw new ValidationError('The new quantity is the same as the current stock.');

  const result = db.transaction(() => {
    const movement = applyMovement({
      productId, changeMilli: delta, reason: 'adjustment',
      referenceType: 'adjustment', note: text, user, allowNegative: false
    });
    activity.log({
      user, action: 'stock.adjusted', entityType: 'product', entityId: productId,
      details: {
        product: product.name,
        from: Qty.display(movement.before),
        to: Qty.display(movement.after),
        reason: text
      }
    });
    return movement;
  })();

  return result;
}

function movements({ productId = null, from = null, to = null, reason = '', page = 1, pageSize = 50 } = {}) {
  const where = [];
  const params = {};
  if (productId) { where.push('m.product_id = @productId'); params.productId = productId; }
  if (from) { where.push('m.created_at >= @from'); params.from = from; }
  if (to) { where.push('m.created_at < @to'); params.to = to; }
  if (reason) { where.push('m.reason = @reason'); params.reason = reason; }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const db = getDb();
  const total = db.prepare(`SELECT COUNT(*) AS n FROM stock_movements m ${clause}`).get(params).n;
  const rows = db.prepare(`
    SELECT m.*, p.name AS product_name, p.unit, u.full_name AS user_name
    FROM stock_movements m
    LEFT JOIN products p ON p.id = m.product_id
    LEFT JOIN users u ON u.id = m.user_id
    ${clause}
    ORDER BY m.created_at DESC, m.id DESC
    LIMIT @limit OFFSET @offset
  `).all({ ...params, limit: pageSize, offset: (page - 1) * pageSize });

  return { rows, total, page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)) };
}

/** Stock health used by the dashboard and the inventory report. */
function stockSummary() {
  return getDb().prepare(`
    SELECT
      COUNT(*)                                                        AS total_products,
      SUM(CASE WHEN stock_milli <= 0 THEN 1 ELSE 0 END)               AS out_of_stock,
      SUM(CASE WHEN stock_milli > 0 AND stock_milli <= min_stock_milli THEN 1 ELSE 0 END) AS low_stock,
      COALESCE(SUM(stock_milli * cost_price_pesewas / 1000), 0)       AS stock_value_pesewas,
      COALESCE(SUM(stock_milli * selling_price_pesewas / 1000), 0)    AS retail_value_pesewas
    FROM products WHERE status = 'active'
  `).get();
}

function lowStockProducts(limit = 50) {
  return getDb().prepare(`
    SELECT p.id, p.name, p.sku, p.barcode, p.unit, p.stock_milli, p.min_stock_milli,
           p.selling_price_pesewas, c.name AS category_name
    FROM products p
    LEFT JOIN categories c ON c.id = p.category_id
    WHERE p.status = 'active' AND p.stock_milli <= p.min_stock_milli
    ORDER BY (p.stock_milli - p.min_stock_milli), p.name
    LIMIT ?
  `).all(limit);
}

module.exports = { applyMovement, adjustStock, movements, stockSummary, lowStockProducts };
