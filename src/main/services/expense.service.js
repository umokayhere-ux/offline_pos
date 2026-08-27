'use strict';

const { getDb } = require('../database/connection');
const { nowIso } = require('../../shared/datetime');
const Money = require('../../shared/money');
const { ValidationError, NotFoundError } = require('../../shared/errors');
const { nextNumber } = require('./sequence.service');
const activity = require('./activity.service');

function categories() {
  return getDb().prepare(`
    SELECT ec.*, (SELECT COUNT(*) FROM expenses e WHERE e.expense_category_id = ec.id) AS expense_count
    FROM expense_categories ec ORDER BY ec.name
  `).all();
}

function createCategory(name, { user = null } = {}) {
  const text = String(name || '').trim();
  if (text.length < 2) throw new ValidationError('Enter an expense category name.');
  const info = getDb().prepare('INSERT INTO expense_categories (name, is_system, created_at) VALUES (?, 0, ?)')
    .run(text, nowIso());
  activity.log({ user, action: 'expense.category_created', entityType: 'expense_category', entityId: info.lastInsertRowid, details: { name: text } });
  return categories();
}

function deleteCategory(id, { user = null } = {}) {
  const db = getDb();
  const category = db.prepare('SELECT * FROM expense_categories WHERE id = ?').get(id);
  if (!category) throw new NotFoundError('That expense category no longer exists.');
  if (category.is_system) throw new ValidationError('Built-in expense categories cannot be removed.');
  const used = db.prepare('SELECT COUNT(*) AS n FROM expenses WHERE expense_category_id = ?').get(id).n;
  if (used > 0) throw new ValidationError(`"${category.name}" is used by ${used} expense${used === 1 ? '' : 's'} and cannot be removed.`);
  db.prepare('DELETE FROM expense_categories WHERE id = ?').run(id);
  activity.log({ user, action: 'expense.category_deleted', entityType: 'expense_category', entityId: id, details: { name: category.name } });
  return categories();
}

function create(input, { user }) {
  const db = getDb();
  const category = db.prepare('SELECT * FROM expense_categories WHERE id = ?').get(input.categoryId);
  if (!category) throw new ValidationError('Choose an expense category.');

  const description = String(input.description || '').trim();
  if (description.length < 2) throw new ValidationError('Describe what this expense was for.');

  const amountPesewas = Money.parsePositive(input.amount, 'Amount');
  if (amountPesewas <= 0) throw new ValidationError('Enter an amount greater than zero.');

  const method = String(input.paymentMethod || 'cash');
  if (!['cash', 'momo', 'card'].includes(method)) throw new ValidationError('Choose a valid payment method.');

  const spentAt = input.spentAt ? new Date(input.spentAt).toISOString() : nowIso();

  return db.transaction(() => {
    const reference = nextNumber('expense', { at: new Date(spentAt) });
    const info = db.prepare(`
      INSERT INTO expenses (reference_no, expense_category_id, description, amount_pesewas,
                            spent_at, payment_method, user_id, notes, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)
    `).run(reference, category.id, description, amountPesewas, spentAt, method, user.id,
      String(input.notes || '').trim() || null, nowIso());

    activity.log({
      user, action: 'expense.created', entityType: 'expense', entityId: info.lastInsertRowid,
      details: { reference, category: category.name, amount: Money.format(amountPesewas), description }
    });
    return get(info.lastInsertRowid);
  })();
}

function update(id, input, { user }) {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM expenses WHERE id = ?').get(id);
  if (!existing) throw new NotFoundError('That expense no longer exists.');
  if (existing.status === 'voided') throw new ValidationError('A voided expense cannot be edited.');

  const category = db.prepare('SELECT * FROM expense_categories WHERE id = ?').get(input.categoryId || existing.expense_category_id);
  if (!category) throw new ValidationError('Choose an expense category.');
  const description = String(input.description ?? existing.description).trim();
  if (description.length < 2) throw new ValidationError('Describe what this expense was for.');
  const amountPesewas = input.amount === undefined ? existing.amount_pesewas : Money.parsePositive(input.amount, 'Amount');
  if (amountPesewas <= 0) throw new ValidationError('Enter an amount greater than zero.');

  db.prepare(`
    UPDATE expenses SET expense_category_id = ?, description = ?, amount_pesewas = ?, payment_method = ?, notes = ?
    WHERE id = ?
  `).run(category.id, description, amountPesewas,
    input.paymentMethod || existing.payment_method, String(input.notes ?? existing.notes ?? '').trim() || null, id);

  activity.log({
    user, action: 'expense.updated', entityType: 'expense', entityId: id,
    details: {
      reference: existing.reference_no,
      amount: existing.amount_pesewas !== amountPesewas
        ? { from: Money.format(existing.amount_pesewas), to: Money.format(amountPesewas) }
        : undefined
    }
  });
  return get(id);
}

/**
 * Expenses are financial records: they are voided with a reason rather than
 * deleted, so an audit can still see what was entered and by whom.
 */
function voidExpense(id, reason, { user }) {
  const db = getDb();
  const expense = db.prepare('SELECT * FROM expenses WHERE id = ?').get(id);
  if (!expense) throw new NotFoundError('That expense no longer exists.');
  if (expense.status === 'voided') throw new ValidationError('This expense has already been voided.');
  const text = String(reason || '').trim();
  if (text.length < 3) throw new ValidationError('Give a reason for voiding this expense.');

  db.prepare("UPDATE expenses SET status = 'voided', voided_reason = ? WHERE id = ?").run(text, id);
  activity.log({
    user, action: 'expense.voided', entityType: 'expense', entityId: id,
    details: { reference: expense.reference_no, amount: Money.format(expense.amount_pesewas), reason: text }
  });
  return get(id);
}

function get(id) {
  const row = getDb().prepare(`
    SELECT e.*, ec.name AS category_name, u.full_name AS user_name
    FROM expenses e JOIN expense_categories ec ON ec.id = e.expense_category_id
    LEFT JOIN users u ON u.id = e.user_id WHERE e.id = ?
  `).get(id);
  if (!row) throw new NotFoundError('That expense no longer exists.');
  return row;
}

function list({ search = '', categoryId = null, from = null, to = null, includeVoided = false, page = 1, pageSize = 25 } = {}) {
  const where = [];
  const params = {};
  if (!includeVoided) where.push("e.status = 'active'");
  if (search) { where.push('(e.description LIKE @search OR e.reference_no LIKE @search OR ec.name LIKE @search)'); params.search = `%${search}%`; }
  if (categoryId) { where.push('e.expense_category_id = @categoryId'); params.categoryId = categoryId; }
  if (from) { where.push('e.spent_at >= @from'); params.from = from; }
  if (to) { where.push('e.spent_at < @to'); params.to = to; }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const db = getDb();
  const total = db.prepare(`
    SELECT COUNT(*) AS n FROM expenses e JOIN expense_categories ec ON ec.id = e.expense_category_id ${clause}
  `).get(params).n;

  const rows = db.prepare(`
    SELECT e.*, ec.name AS category_name, u.full_name AS user_name
    FROM expenses e JOIN expense_categories ec ON ec.id = e.expense_category_id
    LEFT JOIN users u ON u.id = e.user_id
    ${clause} ORDER BY e.spent_at DESC, e.id DESC LIMIT @limit OFFSET @offset
  `).all({ ...params, limit: pageSize, offset: (page - 1) * pageSize });

  const totals = db.prepare(`
    SELECT COALESCE(SUM(e.amount_pesewas), 0) AS amount_pesewas
    FROM expenses e JOIN expense_categories ec ON ec.id = e.expense_category_id ${clause}
  `).get(params);

  return { rows, total, totals, page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)) };
}

/** Total active expenses in a period — the figure net profit is derived from. */
function totalBetween(from, to) {
  return getDb().prepare(`
    SELECT COALESCE(SUM(amount_pesewas), 0) AS total FROM expenses
    WHERE status = 'active' AND spent_at >= ? AND spent_at < ?
  `).get(from, to).total;
}

module.exports = { categories, createCategory, deleteCategory, create, update, voidExpense, get, list, totalBetween };
