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
 * Refunds are reversal transactions. The original sale is NEVER deleted or
 * edited away: the sale keeps its own totals, and running refunded_* columns
 * record how much of it has been given back, so reports can always show gross
 * sales, refunds and net revenue separately.
 */

/** What is still refundable on a sale, line by line. */
function refundableLines(saleId) {
  const db = getDb();
  const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(saleId);
  if (!sale) throw new NotFoundError('That sale could not be found.');

  const items = db.prepare('SELECT * FROM sale_items WHERE sale_id = ? ORDER BY id').all(saleId);
  return {
    sale,
    lines: items.map((item) => ({
      saleItemId: item.id,
      productId: item.product_id,
      productName: item.product_name,
      unit: item.unit,
      quantityMilli: item.quantity_milli,
      refundedQtyMilli: item.refunded_qty_milli,
      remainingQtyMilli: item.quantity_milli - item.refunded_qty_milli,
      unitPricePesewas: item.unit_price_pesewas,
      lineTotalPesewas: item.line_total_pesewas,
      refundedPesewas: item.refunded_pesewas,
      remainingPesewas: item.line_total_pesewas - item.refunded_pesewas,
      costPricePesewas: item.cost_price_pesewas
    }))
  };
}

/**
 * @param {object} input
 * @param {number} input.saleId
 * @param {Array<{saleItemId:number, quantity:string|number}>} input.items
 * @param {string} input.reason
 * @param {string} [input.method] how the money is given back
 * @param {boolean} [input.restock] return the goods to inventory
 */
function create(input, { user }) {
  const db = getDb();
  const reason = String(input.reason || '').trim();
  if (reason.length < 3) throw new ValidationError('Give a reason for this refund.');

  const method = String(input.method || 'cash');
  if (!['cash', 'momo', 'card', 'credit'].includes(method)) throw new ValidationError('Choose a valid refund method.');

  const { sale, lines } = refundableLines(input.saleId);
  if (sale.status === 'refunded') throw new ValidationError('This sale has already been fully refunded.');

  const requested = Array.isArray(input.items) ? input.items : [];
  if (requested.length === 0) throw new ValidationError('Select at least one item to refund.');

  const byId = new Map(lines.map((l) => [l.saleItemId, l]));
  const prepared = requested.map((req) => {
    const line = byId.get(Number(req.saleItemId));
    if (!line) throw new ValidationError('One of the selected items does not belong to this sale.');
    const quantityMilli = Qty.parsePositive(req.quantity, `Refund quantity for "${line.productName}"`);
    if (quantityMilli > line.remainingQtyMilli) {
      throw new ValidationError(
        `You can refund at most ${Qty.display(line.remainingQtyMilli)} of "${line.productName}" — the rest has already been returned.`
      );
    }
    const computed = Calc.refundLine({
      lineTotalPesewas: line.lineTotalPesewas,
      lineQuantityMilli: line.quantityMilli,
      refundQuantityMilli: quantityMilli,
      costPricePesewas: line.costPricePesewas
    });
    // Never give back more than remains on the line after earlier partial refunds.
    const amount = Math.min(computed.amount, line.remainingPesewas);
    return { line, quantityMilli, amount, cost: computed.cost };
  });

  const totalAmount = Money.sum(prepared.map((p) => p.amount));
  const totalCogs = Money.sum(prepared.map((p) => p.cost));
  if (totalAmount <= 0) throw new ValidationError('This refund would come to ₵0.00.');

  const restock = input.restock === undefined ? true : !!input.restock;

  const run = db.transaction(() => {
    const at = nowIso();
    const reference = nextNumber('refund', { at: new Date(at) });

    const refundInfo = db.prepare(`
      INSERT INTO refunds (reference_no, sale_id, customer_id, user_id, refunded_at,
                           amount_pesewas, cogs_pesewas, method, restock, reason, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(reference, sale.id, sale.customer_id, user.id, at, totalAmount, totalCogs, method, restock ? 1 : 0, reason, at);
    const refundId = refundInfo.lastInsertRowid;

    const insertItem = db.prepare(`
      INSERT INTO refund_items (refund_id, sale_item_id, product_id, product_name, quantity_milli, amount_pesewas, cost_price_pesewas)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    for (const p of prepared) {
      insertItem.run(refundId, p.line.saleItemId, p.line.productId, p.line.productName,
        p.quantityMilli, p.amount, p.line.costPricePesewas);

      db.prepare(`
        UPDATE sale_items SET refunded_qty_milli = refunded_qty_milli + ?, refunded_pesewas = refunded_pesewas + ?
        WHERE id = ?
      `).run(p.quantityMilli, p.amount, p.line.saleItemId);

      if (restock && p.line.productId) {
        inventory.applyMovement({
          productId: p.line.productId, changeMilli: p.quantityMilli, reason: 'refund',
          referenceType: 'refund', referenceId: refundId, note: reference, user, allowNegative: true
        });
      }
    }

    const refundedTotal = sale.refunded_pesewas + totalAmount;
    const fullyRefunded = refundedTotal >= sale.total_pesewas;
    db.prepare(`
      UPDATE sales SET refunded_pesewas = ?, refunded_cogs_pesewas = ?, status = ? WHERE id = ?
    `).run(refundedTotal, sale.refunded_cogs_pesewas + totalCogs, fullyRefunded ? 'refunded' : 'partially_refunded', sale.id);

    // A refund on a credit sale reduces what the customer still owes before any
    // cash changes hands.
    if (method === 'credit' && sale.customer_id) {
      applyRefundToDebt(db, sale, totalAmount, at, user, reference);
    }

    activity.log({
      user, action: 'sale.refunded', entityType: 'refund', entityId: refundId,
      details: {
        reference, invoice: sale.invoice_no, amount: Money.format(totalAmount),
        items: prepared.length, restocked: restock, reason
      }
    });

    return refundId;
  });

  const refundId = run();
  return get(refundId);
}

function applyRefundToDebt(db, sale, amountPesewas, at, user, reference) {
  const accounts = db.prepare(`
    SELECT * FROM debt_accounts WHERE sale_id = ? AND status = 'open' ORDER BY id
  `).all(sale.id);

  let remaining = amountPesewas;
  for (const account of accounts) {
    if (remaining <= 0) break;
    const applied = Math.min(remaining, account.outstanding_pesewas);
    const outstanding = account.outstanding_pesewas - applied;
    db.prepare(`
      UPDATE debt_accounts SET outstanding_pesewas = ?, status = ?, settled_at = ?, note = ? WHERE id = ?
    `).run(outstanding, outstanding === 0 ? 'settled' : 'open', outstanding === 0 ? at : null,
      `Reduced by refund ${reference}`, account.id);

    const customer = db.prepare('SELECT balance_pesewas FROM customers WHERE id = ?').get(account.customer_id);
    db.prepare('UPDATE customers SET balance_pesewas = ?, updated_at = ? WHERE id = ?')
      .run(customer.balance_pesewas - applied, at, account.customer_id);
    remaining -= applied;
  }
}

function get(id) {
  const db = getDb();
  const refund = db.prepare(`
    SELECT r.*, s.invoice_no, c.name AS customer_name, u.full_name AS user_name
    FROM refunds r
    JOIN sales s ON s.id = r.sale_id
    LEFT JOIN customers c ON c.id = r.customer_id
    LEFT JOIN users u ON u.id = r.user_id
    WHERE r.id = ?
  `).get(id);
  if (!refund) throw new NotFoundError('That refund could not be found.');
  const items = db.prepare('SELECT * FROM refund_items WHERE refund_id = ? ORDER BY id').all(id);
  return { refund, items };
}

function list({ search = '', from = null, to = null, page = 1, pageSize = 25 } = {}) {
  const where = [];
  const params = {};
  if (search) { where.push('(r.reference_no LIKE @search OR s.invoice_no LIKE @search OR c.name LIKE @search)'); params.search = `%${search}%`; }
  if (from) { where.push('r.refunded_at >= @from'); params.from = from; }
  if (to) { where.push('r.refunded_at < @to'); params.to = to; }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const db = getDb();
  const total = db.prepare(`
    SELECT COUNT(*) AS n FROM refunds r JOIN sales s ON s.id = r.sale_id
    LEFT JOIN customers c ON c.id = r.customer_id ${clause}
  `).get(params).n;

  const rows = db.prepare(`
    SELECT r.*, s.invoice_no, c.name AS customer_name, u.full_name AS user_name,
           (SELECT COUNT(*) FROM refund_items ri WHERE ri.refund_id = r.id) AS item_count
    FROM refunds r
    JOIN sales s ON s.id = r.sale_id
    LEFT JOIN customers c ON c.id = r.customer_id
    LEFT JOIN users u ON u.id = r.user_id
    ${clause} ORDER BY r.refunded_at DESC LIMIT @limit OFFSET @offset
  `).all({ ...params, limit: pageSize, offset: (page - 1) * pageSize });

  const totals = db.prepare(`
    SELECT COALESCE(SUM(r.amount_pesewas), 0) AS amount_pesewas
    FROM refunds r JOIN sales s ON s.id = r.sale_id LEFT JOIN customers c ON c.id = r.customer_id ${clause}
  `).get(params);

  return { rows, total, totals, page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)) };
}

module.exports = { create, get, list, refundableLines };
