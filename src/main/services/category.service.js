'use strict';

const { getDb } = require('../database/connection');
const { nowIso } = require('../../shared/datetime');
const { ValidationError, NotFoundError } = require('../../shared/errors');
const activity = require('./activity.service');

function list({ search = '' } = {}) {
  const params = {};
  let clause = '';
  if (search) { clause = 'WHERE c.name LIKE @search'; params.search = `%${search}%`; }
  return getDb().prepare(`
    SELECT c.*, (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id) AS product_count
    FROM categories c ${clause} ORDER BY c.name
  `).all(params);
}

function get(id) {
  const row = getDb().prepare('SELECT * FROM categories WHERE id = ?').get(id);
  if (!row) throw new NotFoundError('That category no longer exists.');
  return row;
}

function create(input, { user = null } = {}) {
  const name = String(input.name || '').trim();
  if (name.length < 2) throw new ValidationError('Enter a category name of at least 2 characters.');
  const at = nowIso();
  const info = getDb().prepare(`
    INSERT INTO categories (name, description, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)
  `).run(name, String(input.description || '').trim() || null, at, at);
  activity.log({ user, action: 'category.created', entityType: 'category', entityId: info.lastInsertRowid, details: { name } });
  return get(info.lastInsertRowid);
}

function update(id, input, { user = null } = {}) {
  get(id);
  const name = String(input.name || '').trim();
  if (name.length < 2) throw new ValidationError('Enter a category name of at least 2 characters.');
  getDb().prepare('UPDATE categories SET name = ?, description = ?, updated_at = ? WHERE id = ?')
    .run(name, String(input.description || '').trim() || null, nowIso(), id);
  activity.log({ user, action: 'category.updated', entityType: 'category', entityId: id, details: { name } });
  return get(id);
}

/**
 * A category holding products cannot simply vanish. The caller must say what
 * happens to those products: move them to another category, or leave them
 * uncategorised.
 */
function remove(id, { reassignTo = null, force = false, user = null } = {}) {
  const db = getDb();
  const category = get(id);
  const count = db.prepare('SELECT COUNT(*) AS n FROM products WHERE category_id = ?').get(id).n;

  if (count > 0 && !force && !reassignTo) {
    throw new ValidationError(
      `"${category.name}" still contains ${count} product${count === 1 ? '' : 's'}. Choose a category to move them to, or confirm leaving them uncategorised.`,
      { productCount: count }
    );
  }
  if (reassignTo) {
    if (Number(reassignTo) === Number(id)) throw new ValidationError('Choose a different category to move the products to.');
    get(reassignTo);
  }

  db.transaction(() => {
    db.prepare('UPDATE products SET category_id = ?, updated_at = ? WHERE category_id = ?')
      .run(reassignTo || null, nowIso(), id);
    db.prepare('DELETE FROM categories WHERE id = ?').run(id);
    activity.log({
      user, action: 'category.deleted', entityType: 'category', entityId: id,
      details: { name: category.name, productsMoved: count, reassignedTo: reassignTo || 'uncategorised' }
    });
  })();

  return { deleted: true, productsMoved: count };
}

module.exports = { list, get, create, update, remove };
