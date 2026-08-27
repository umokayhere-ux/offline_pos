'use strict';

const { getDb } = require('../database/connection');
const { nowIso } = require('../../shared/datetime');
const Money = require('../../shared/money');
const Calc = require('../../shared/calculation');
const { ValidationError, NotFoundError } = require('../../shared/errors');
const { nextNumber } = require('./sequence.service');
const activity = require('./activity.service');

function validate(input) {
  const name = String(input.name || '').trim();
  if (name.length < 2) throw new ValidationError('Enter the supplier name.');
  const email = String(input.email ?? '').trim();
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new ValidationError('Enter a valid email address.');
  return {
    name,
    company: String(input.company ?? '').trim() || null,
    phone: String(input.phone ?? '').trim() || null,
    email: email || null,
    address: String(input.address ?? '').trim() || null,
    notes: String(input.notes ?? '').trim() || null,
    status: input.status === 'archived' ? 'archived' : 'active'
  };
}

function list({ search = '', status = 'active', withBalanceOnly = false, page = 1, pageSize = 25 } = {}) {
  const where = [];
  const params = {};
  if (status && status !== 'all') { where.push('status = @status'); params.status = status; }
  if (search) { where.push('(name LIKE @search OR phone LIKE @search OR company LIKE @search)'); params.search = `%${search}%`; }
  if (withBalanceOnly) where.push('balance_pesewas > 0');
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const db = getDb();
  const total = db.prepare(`SELECT COUNT(*) AS n FROM suppliers ${clause}`).get(params).n;
  const rows = db.prepare(`SELECT * FROM suppliers ${clause} ORDER BY name LIMIT @limit OFFSET @offset`)
    .all({ ...params, limit: pageSize, offset: (page - 1) * pageSize });
  return { rows, total, page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)) };
}

function get(id) {
  const row = getDb().prepare('SELECT * FROM suppliers WHERE id = ?').get(id);
  if (!row) throw new NotFoundError('That supplier no longer exists.');
  return row;
}

function create(input, { user = null } = {}) {
  const data = validate(input);
  const at = nowIso();
  const info = getDb().prepare(`
    INSERT INTO suppliers (name, company, phone, email, address, notes, balance_pesewas, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
  `).run(data.name, data.company, data.phone, data.email, data.address, data.notes, data.status, at, at);
  activity.log({ user, action: 'supplier.created', entityType: 'supplier', entityId: info.lastInsertRowid, details: { name: data.name } });
  return get(info.lastInsertRowid);
}

function update(id, input, { user = null } = {}) {
  get(id);
  const data = validate(input);
  getDb().prepare(`
    UPDATE suppliers SET name = ?, company = ?, phone = ?, email = ?, address = ?, notes = ?, status = ?, updated_at = ?
    WHERE id = ?
  `).run(data.name, data.company, data.phone, data.email, data.address, data.notes, data.status, nowIso(), id);
  activity.log({ user, action: 'supplier.updated', entityType: 'supplier', entityId: id, details: { name: data.name } });
  return get(id);
}

function remove(id, { user = null } = {}) {
  const db = getDb();
  const supplier = get(id);
  if (supplier.balance_pesewas !== 0) {
    throw new ValidationError(`${supplier.name} has an outstanding balance of ${Money.format(supplier.balance_pesewas)}. Settle it first.`);
  }
  const purchases = db.prepare('SELECT COUNT(*) AS n FROM purchases WHERE supplier_id = ?').get(id).n;
  if (purchases > 0) {
    db.prepare("UPDATE suppliers SET status = 'archived', updated_at = ? WHERE id = ?").run(nowIso(), id);
    activity.log({ user, action: 'supplier.archived', entityType: 'supplier', entityId: id, details: { name: supplier.name } });
    return { deleted: false, archived: true, message: `${supplier.name} has purchase history, so the record was archived.` };
  }
  db.transaction(() => {
    db.prepare('UPDATE products SET supplier_id = NULL WHERE supplier_id = ?').run(id);
    db.prepare('DELETE FROM suppliers WHERE id = ?').run(id);
  })();
  activity.log({ user, action: 'supplier.deleted', entityType: 'supplier', entityId: id, details: { name: supplier.name } });
  return { deleted: true, archived: false, message: `${supplier.name} was deleted.` };
}

/** Record a payment made to a supplier; reduces the outstanding balance. */
function recordPayment({ supplierId, purchaseId = null, amount, method = 'cash', note = '' }, { user }) {
  const db = getDb();
  const supplier = get(supplierId);
  const amountPesewas = Money.parsePositive(amount, 'Payment');
  if (amountPesewas <= 0) throw new ValidationError('Enter a payment amount greater than zero.');
  if (amountPesewas > supplier.balance_pesewas) {
    throw new ValidationError(
      `That is more than the outstanding balance of ${Money.format(supplier.balance_pesewas)}.`
    );
  }
  if (!['cash', 'momo', 'card'].includes(method)) throw new ValidationError('Choose a valid payment method.');

  return db.transaction(() => {
    const reference = nextNumber('supplierPayment');
    const at = nowIso();
    db.prepare(`
      INSERT INTO supplier_payments (reference_no, supplier_id, purchase_id, amount_pesewas, method, paid_at, user_id, note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(reference, supplierId, purchaseId, amountPesewas, method, at, user.id, note || null);

    const newBalance = Calc.supplierBalance({
      previousBalancePesewas: supplier.balance_pesewas, paymentsPesewas: amountPesewas
    });
    db.prepare('UPDATE suppliers SET balance_pesewas = ?, updated_at = ? WHERE id = ?').run(newBalance, at, supplierId);

    if (purchaseId) {
      const purchase = db.prepare('SELECT * FROM purchases WHERE id = ?').get(purchaseId);
      if (purchase) {
        const paid = purchase.paid_pesewas + amountPesewas;
        db.prepare('UPDATE purchases SET paid_pesewas = ?, balance_pesewas = ? WHERE id = ?')
          .run(paid, purchase.total_pesewas - paid, purchaseId);
      }
    }

    activity.log({
      user, action: 'supplier.payment_recorded', entityType: 'supplier', entityId: supplierId,
      details: { reference, supplier: supplier.name, amount: Money.format(amountPesewas), method }
    });
    return { reference, balance: newBalance };
  })();
}

function profile(id) {
  const db = getDb();
  const supplier = get(id);
  const purchases = db.prepare(`
    SELECT p.*, u.full_name AS user_name FROM purchases p
    LEFT JOIN users u ON u.id = p.user_id
    WHERE p.supplier_id = ? ORDER BY p.purchased_at DESC LIMIT 100
  `).all(id);
  const payments = db.prepare(`
    SELECT sp.*, u.full_name AS user_name FROM supplier_payments sp
    LEFT JOIN users u ON u.id = sp.user_id
    WHERE sp.supplier_id = ? ORDER BY sp.paid_at DESC LIMIT 100
  `).all(id);
  const totals = db.prepare(`
    SELECT COALESCE(SUM(total_pesewas), 0) AS purchased_pesewas, COUNT(*) AS purchase_count
    FROM purchases WHERE supplier_id = ? AND status = 'received'
  `).get(id);
  const paidTotal = db.prepare('SELECT COALESCE(SUM(amount_pesewas), 0) AS paid FROM supplier_payments WHERE supplier_id = ?').get(id).paid;
  return { supplier, purchases, payments, totals: { ...totals, paid_pesewas: paidTotal } };
}

module.exports = { list, get, create, update, remove, recordPayment, profile };
