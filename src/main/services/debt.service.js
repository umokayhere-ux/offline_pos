'use strict';

const { getDb } = require('../database/connection');
const { nowIso } = require('../../shared/datetime');
const Money = require('../../shared/money');
const Calc = require('../../shared/calculation');
const { ValidationError, NotFoundError } = require('../../shared/errors');
const { nextNumber } = require('./sequence.service');
const activity = require('./activity.service');

/**
 * Customer debt.
 *
 * Payments are appended, never edited: a correction is another transaction.
 * Both the debt account and the customer's rolled-up balance move together
 * inside one transaction so they can never disagree.
 */

function list({ search = '', status = 'open', customerId = null, page = 1, pageSize = 25 } = {}) {
  const where = [];
  const params = {};
  if (status && status !== 'all') { where.push('d.status = @status'); params.status = status; }
  if (customerId) { where.push('d.customer_id = @customerId'); params.customerId = customerId; }
  if (search) { where.push('(c.name LIKE @search OR c.phone LIKE @search OR d.invoice_no LIKE @search)'); params.search = `%${search}%`; }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const db = getDb();
  const total = db.prepare(`
    SELECT COUNT(*) AS n FROM debt_accounts d JOIN customers c ON c.id = d.customer_id ${clause}
  `).get(params).n;

  const rows = db.prepare(`
    SELECT d.*, c.name AS customer_name, c.phone AS customer_phone
    FROM debt_accounts d JOIN customers c ON c.id = d.customer_id
    ${clause} ORDER BY d.opened_at DESC LIMIT @limit OFFSET @offset
  `).all({ ...params, limit: pageSize, offset: (page - 1) * pageSize });

  const totals = db.prepare(`
    SELECT COALESCE(SUM(d.outstanding_pesewas), 0) AS outstanding_pesewas,
           COALESCE(SUM(d.original_pesewas), 0) AS original_pesewas,
           COALESCE(SUM(d.paid_pesewas), 0) AS paid_pesewas
    FROM debt_accounts d JOIN customers c ON c.id = d.customer_id ${clause}
  `).get(params);

  return { rows, total, totals, page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)) };
}

function get(id) {
  const db = getDb();
  const account = db.prepare(`
    SELECT d.*, c.name AS customer_name, c.phone AS customer_phone
    FROM debt_accounts d JOIN customers c ON c.id = d.customer_id WHERE d.id = ?
  `).get(id);
  if (!account) throw new NotFoundError('That debt record no longer exists.');
  const payments = db.prepare(`
    SELECT dp.*, u.full_name AS user_name FROM debt_payments dp
    LEFT JOIN users u ON u.id = dp.user_id
    WHERE dp.debt_account_id = ? ORDER BY dp.paid_at
  `).all(id);
  return { account, payments };
}

/** Record a partial or full payment against one debt account. */
function recordPayment({ debtAccountId, amount, method = 'cash', note = '' }, { user }) {
  const db = getDb();
  const account = db.prepare('SELECT * FROM debt_accounts WHERE id = ?').get(debtAccountId);
  if (!account) throw new NotFoundError('That debt record no longer exists.');
  if (account.status !== 'open') throw new ValidationError('This debt has already been settled.');

  const amountPesewas = Money.parsePositive(amount, 'Payment');
  if (amountPesewas <= 0) throw new ValidationError('Enter a payment amount greater than zero.');
  if (amountPesewas > account.outstanding_pesewas) {
    throw new ValidationError(
      `That is more than the outstanding ${Money.format(account.outstanding_pesewas)}. Enter ${Money.format(account.outstanding_pesewas)} or less.`
    );
  }
  if (!['cash', 'momo', 'card'].includes(method)) throw new ValidationError('Choose a valid payment method.');

  return db.transaction(() => {
    const at = nowIso();
    const reference = nextNumber('debtPayment', { at: new Date(at) });

    const info = db.prepare(`
      INSERT INTO debt_payments (debt_account_id, customer_id, reference_no, amount_pesewas, method, paid_at, user_id, note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(debtAccountId, account.customer_id, reference, amountPesewas, method, at, user.id, String(note || '').trim() || null);

    const paid = account.paid_pesewas + amountPesewas;
    const outstanding = Calc.customerDebtBalance({
      previousBalancePesewas: account.outstanding_pesewas, paymentPesewas: amountPesewas
    });
    const settled = outstanding === 0;

    db.prepare(`
      UPDATE debt_accounts SET paid_pesewas = ?, outstanding_pesewas = ?, status = ?, settled_at = ? WHERE id = ?
    `).run(paid, outstanding, settled ? 'settled' : 'open', settled ? at : null, debtAccountId);

    const customer = db.prepare('SELECT balance_pesewas, name FROM customers WHERE id = ?').get(account.customer_id);
    const newBalance = Calc.customerDebtBalance({
      previousBalancePesewas: customer.balance_pesewas, paymentPesewas: amountPesewas
    });
    db.prepare('UPDATE customers SET balance_pesewas = ?, updated_at = ? WHERE id = ?')
      .run(newBalance, at, account.customer_id);

    // The payment is also a cash-book entry so it appears in payment reports.
    db.prepare(`
      INSERT INTO payments (customer_id, debt_payment_id, amount_pesewas, method, reference, paid_at, user_id, note)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'Debt payment')
    `).run(account.customer_id, info.lastInsertRowid, amountPesewas, method, reference, at, user.id);

    activity.log({
      user, action: 'debt.payment_recorded', entityType: 'debt_account', entityId: debtAccountId,
      details: {
        reference, customer: customer.name, amount: Money.format(amountPesewas),
        remaining: Money.format(outstanding), invoice: account.invoice_no
      }
    });

    return {
      reference,
      paymentId: info.lastInsertRowid,
      amountPesewas,
      outstandingPesewas: outstanding,
      customerBalancePesewas: newBalance,
      settled
    };
  })();
}

/**
 * Write off an uncollectable debt. The original sale is untouched — this records
 * a deliberate accounting decision with a reason, attributed to a user.
 */
function writeOff(debtAccountId, reason, { user }) {
  const db = getDb();
  const text = String(reason || '').trim();
  if (text.length < 3) throw new ValidationError('Give a reason for writing off this debt.');

  const account = db.prepare('SELECT * FROM debt_accounts WHERE id = ?').get(debtAccountId);
  if (!account) throw new NotFoundError('That debt record no longer exists.');
  if (account.status !== 'open') throw new ValidationError('This debt is no longer open.');

  return db.transaction(() => {
    const at = nowIso();
    db.prepare(`
      UPDATE debt_accounts SET status = 'written_off', settled_at = ?, outstanding_pesewas = 0, note = ? WHERE id = ?
    `).run(at, text, debtAccountId);

    const customer = db.prepare('SELECT balance_pesewas, name FROM customers WHERE id = ?').get(account.customer_id);
    const newBalance = customer.balance_pesewas - account.outstanding_pesewas;
    db.prepare('UPDATE customers SET balance_pesewas = ?, updated_at = ? WHERE id = ?')
      .run(newBalance, at, account.customer_id);

    activity.log({
      user, action: 'debt.written_off', entityType: 'debt_account', entityId: debtAccountId,
      details: { customer: customer.name, amount: Money.format(account.outstanding_pesewas), reason: text }
    });
    return { writtenOffPesewas: account.outstanding_pesewas, customerBalancePesewas: newBalance };
  })();
}

function paymentsReport({ from, to, page = 1, pageSize = 50 } = {}) {
  const db = getDb();
  const where = [];
  const params = {};
  if (from) { where.push('dp.paid_at >= @from'); params.from = from; }
  if (to) { where.push('dp.paid_at < @to'); params.to = to; }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const rows = db.prepare(`
    SELECT dp.*, c.name AS customer_name, u.full_name AS user_name, d.invoice_no
    FROM debt_payments dp
    JOIN customers c ON c.id = dp.customer_id
    JOIN debt_accounts d ON d.id = dp.debt_account_id
    LEFT JOIN users u ON u.id = dp.user_id
    ${clause} ORDER BY dp.paid_at DESC LIMIT @limit OFFSET @offset
  `).all({ ...params, limit: pageSize, offset: (page - 1) * pageSize });

  const totals = db.prepare(`
    SELECT COALESCE(SUM(dp.amount_pesewas), 0) AS collected_pesewas, COUNT(*) AS n
    FROM debt_payments dp ${clause}
  `).get(params);

  return { rows, totals, page, pageSize };
}

module.exports = { list, get, recordPayment, writeOff, paymentsReport };
