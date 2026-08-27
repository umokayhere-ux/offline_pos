'use strict';

const { getDb } = require('../database/connection');
const { nowIso } = require('../../shared/datetime');

/**
 * Audit trail. Writes are append-only — the database refuses UPDATE and DELETE
 * on activity_logs (see the triggers in the initial migration).
 */

function log({ user, action, entityType = null, entityId = null, details = null }) {
  getDb().prepare(`
    INSERT INTO activity_logs (user_id, username, action, entity_type, entity_id, details, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    user ? user.id : null,
    user ? user.username : null,
    action,
    entityType,
    entityId,
    details === null || details === undefined
      ? null
      : (typeof details === 'string' ? details : JSON.stringify(details)),
    nowIso()
  );
}

function list({ search = '', action = '', userId = null, from = null, to = null, page = 1, pageSize = 50 } = {}) {
  const where = [];
  const params = {};
  if (search) {
    where.push('(a.username LIKE @search OR a.action LIKE @search OR a.details LIKE @search)');
    params.search = `%${search}%`;
  }
  if (action) { where.push('a.action = @action'); params.action = action; }
  if (userId) { where.push('a.user_id = @userId'); params.userId = userId; }
  if (from) { where.push('a.created_at >= @from'); params.from = from; }
  if (to) { where.push('a.created_at < @to'); params.to = to; }

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const db = getDb();
  const total = db.prepare(`SELECT COUNT(*) AS n FROM activity_logs a ${clause}`).get(params).n;
  const rows = db.prepare(`
    SELECT a.*, u.full_name AS user_full_name
    FROM activity_logs a
    LEFT JOIN users u ON u.id = a.user_id
    ${clause}
    ORDER BY a.created_at DESC, a.id DESC
    LIMIT @limit OFFSET @offset
  `).all({ ...params, limit: pageSize, offset: (page - 1) * pageSize });

  return { rows, total, page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)) };
}

function distinctActions() {
  return getDb().prepare('SELECT DISTINCT action FROM activity_logs ORDER BY action').all().map((r) => r.action);
}

module.exports = { log, list, distinctActions };
