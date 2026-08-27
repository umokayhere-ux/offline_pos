'use strict';

const { getDb } = require('../database/connection');
const { nowIso } = require('../../shared/datetime');
const Money = require('../../shared/money');
const { ValidationError, NotFoundError } = require('../../shared/errors');
const activity = require('./activity.service');

function normalisePhone(value) {
  const text = String(value ?? '').replace(/[^\d+]/g, '').trim();
  return text === '' ? null : text;
}

function validate(input, id = null) {
  const name = String(input.name || '').trim();
  if (name.length < 2) throw new ValidationError('Enter the customer name.');
  const phone = normalisePhone(input.phone);
  if (phone && !/^\+?\d{6,15}$/.test(phone)) {
    throw new ValidationError('Enter a valid phone number (6-15 digits).');
  }
  if (phone) {
    const clash = getDb().prepare('SELECT id, name FROM customers WHERE phone = ? AND id IS NOT ?').get(phone, id);
    if (clash) throw new ValidationError(`${clash.name} already uses this phone number.`);
  }
  const email = String(input.email ?? '').trim();
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new ValidationError('Enter a valid email address.');

  return {
    name, phone, email: email || null,
    address: String(input.address ?? '').trim() || null,
    notes: String(input.notes ?? '').trim() || null,
    status: input.status === 'archived' ? 'archived' : 'active'
  };
}

function list({ search = '', withDebtOnly = false, status = 'active', page = 1, pageSize = 25 } = {}) {
  const where = [];
  const params = {};
  if (status && status !== 'all') { where.push('status = @status'); params.status = status; }
  if (search) { where.push('(name LIKE @search OR phone LIKE @search)'); params.search = `%${search}%`; }
  if (withDebtOnly) where.push('balance_pesewas > 0');
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const db = getDb();
  const total = db.prepare(`SELECT COUNT(*) AS n FROM customers ${clause}`).get(params).n;
  const rows = db.prepare(`
    SELECT * FROM customers ${clause} ORDER BY name LIMIT @limit OFFSET @offset
  `).all({ ...params, limit: pageSize, offset: (page - 1) * pageSize });
  return { rows, total, page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)) };
}

function quickSearch(term, limit = 15) {
  const text = String(term || '').trim();
  if (!text) return getDb().prepare("SELECT * FROM customers WHERE status = 'active' ORDER BY name LIMIT ?").all(limit);
  return getDb().prepare(`
    SELECT * FROM customers WHERE status = 'active' AND (name LIKE ? OR phone LIKE ?)
    ORDER BY name LIMIT ?
  `).all(`%${text}%`, `%${text}%`, limit);
}

function get(id) {
  const row = getDb().prepare('SELECT * FROM customers WHERE id = ?').get(id);
  if (!row) throw new NotFoundError('That customer no longer exists.');
  return row;
}

function create(input, { user = null } = {}) {
  const data = validate(input);
  const at = nowIso();
  const info = getDb().prepare(`
    INSERT INTO customers (name, phone, email, address, notes, balance_pesewas, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)
  `).run(data.name, data.phone, data.email, data.address, data.notes, data.status, at, at);
  activity.log({ user, action: 'customer.created', entityType: 'customer', entityId: info.lastInsertRowid, details: { name: data.name } });
  return get(info.lastInsertRowid);
}

function update(id, input, { user = null } = {}) {
  get(id);
  const data = validate(input, id);
  getDb().prepare(`
    UPDATE customers SET name = ?, phone = ?, email = ?, address = ?, notes = ?, status = ?, updated_at = ?
    WHERE id = ?
  `).run(data.name, data.phone, data.email, data.address, data.notes, data.status, nowIso(), id);
  activity.log({ user, action: 'customer.updated', entityType: 'customer', entityId: id, details: { name: data.name } });
  return get(id);
}

/** A customer who owes money or has bought before is archived, never deleted. */
function remove(id, { user = null } = {}) {
  const db = getDb();
  const customer = get(id);
  if (customer.balance_pesewas > 0) {
    throw new ValidationError(`${customer.name} still owes ${Money.format(customer.balance_pesewas)}. Settle the debt first.`);
  }
  const sales = db.prepare('SELECT COUNT(*) AS n FROM sales WHERE customer_id = ?').get(id).n;
  if (sales > 0) {
    db.prepare("UPDATE customers SET status = 'archived', updated_at = ? WHERE id = ?").run(nowIso(), id);
    activity.log({ user, action: 'customer.archived', entityType: 'customer', entityId: id, details: { name: customer.name } });
    return { deleted: false, archived: true, message: `${customer.name} has purchase history, so the record was archived.` };
  }
  db.prepare('DELETE FROM customers WHERE id = ?').run(id);
  activity.log({ user, action: 'customer.deleted', entityType: 'customer', entityId: id, details: { name: customer.name } });
  return { deleted: true, archived: false, message: `${customer.name} was deleted.` };
}

/** Everything the customer detail screen needs: purchases, debts and payments. */
function profile(id) {
  const db = getDb();
  const customer = get(id);
  const sales = db.prepare(`
    SELECT s.id, s.invoice_no, s.sold_at, s.total_pesewas, s.paid_pesewas, s.debt_pesewas,
           s.payment_method, s.status, u.full_name AS cashier
    FROM sales s LEFT JOIN users u ON u.id = s.user_id
    WHERE s.customer_id = ? ORDER BY s.sold_at DESC LIMIT 100
  `).all(id);

  const debts = db.prepare(`
    SELECT * FROM debt_accounts WHERE customer_id = ? ORDER BY opened_at DESC
  `).all(id);

  const payments = db.prepare(`
    SELECT dp.*, u.full_name AS user_name FROM debt_payments dp
    LEFT JOIN users u ON u.id = dp.user_id
    WHERE dp.customer_id = ? ORDER BY dp.paid_at DESC LIMIT 100
  `).all(id);

  const totals = db.prepare(`
    SELECT COALESCE(SUM(total_pesewas), 0) AS lifetime_pesewas, COUNT(*) AS purchase_count
    FROM sales WHERE customer_id = ?
  `).get(id);

  return { customer, sales, debts, payments, totals };
}

module.exports = { list, quickSearch, get, create, update, remove, profile, validate };
