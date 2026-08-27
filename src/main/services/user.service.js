'use strict';

const { getDb } = require('../database/connection');
const { nowIso } = require('../../shared/datetime');
const { ValidationError, NotFoundError, AppError } = require('../../shared/errors');
const { hashPassword, verifyPassword, validatePasswordStrength } = require('../security/password');
const { PERMISSIONS } = require('../../shared/constants');
const settings = require('./settings.service');
const activity = require('./activity.service');

const MAX_FAILED_ATTEMPTS = 5;
const LOCK_MINUTES = 5;

function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    fullName: row.full_name,
    role: row.role_name,
    roleId: row.role_id,
    roleLabel: row.role_label,
    phone: row.phone,
    email: row.email,
    status: row.status,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
    permissions: permissionsForRole(row.role_id)
  };
}

const SELECT_USER = `
  SELECT u.*, r.name AS role_name, r.label AS role_label
  FROM users u JOIN roles r ON r.id = u.role_id
`;

function permissionsForRole(roleId) {
  return getDb().prepare(`
    SELECT p.code FROM role_permissions rp
    JOIN permissions p ON p.id = rp.permission_id
    WHERE rp.role_id = ?
  `).all(roleId).map((r) => r.code);
}

function findByUsername(username) {
  return getDb().prepare(`${SELECT_USER} WHERE lower(u.username) = lower(?)`).get(String(username || '').trim());
}

function findById(id) {
  return getDb().prepare(`${SELECT_USER} WHERE u.id = ?`).get(id);
}

function get(id) {
  const row = findById(id);
  if (!row) throw new NotFoundError('That user account no longer exists.');
  return publicUser(row);
}

function list({ includeDisabled = true } = {}) {
  const clause = includeDisabled ? '' : "WHERE u.status = 'active'";
  return getDb().prepare(`${SELECT_USER} ${clause} ORDER BY u.full_name`).all().map(publicUser);
}

function countUsers() {
  return getDb().prepare('SELECT COUNT(*) AS n FROM users').get().n;
}

function roles() {
  return getDb().prepare('SELECT id, name, label, is_system FROM roles ORDER BY id').all().map((r) => ({
    id: r.id, name: r.name, label: r.label, isSystem: !!r.is_system, permissions: permissionsForRole(r.id)
  }));
}

function allPermissions() {
  return getDb().prepare('SELECT code, label FROM permissions ORDER BY code').all();
}

function resolveRoleId(role) {
  const row = typeof role === 'number'
    ? getDb().prepare('SELECT id FROM roles WHERE id = ?').get(role)
    : getDb().prepare('SELECT id FROM roles WHERE name = ?').get(String(role));
  if (!row) throw new ValidationError('Select a valid role for this user.');
  return row.id;
}

function validateUsername(username) {
  const value = String(username || '').trim();
  if (value.length < 3) throw new ValidationError('Username must be at least 3 characters long.');
  if (!/^[a-zA-Z0-9._-]+$/.test(value)) {
    throw new ValidationError('Username may only contain letters, numbers, dots, dashes and underscores.');
  }
  return value;
}

function create(input, { user = null } = {}) {
  const username = validateUsername(input.username);
  const fullName = String(input.fullName || '').trim();
  if (fullName.length < 2) throw new ValidationError('Enter the full name of this user.');

  const minLength = settings.get('security.min_password_length', 6);
  const strength = validatePasswordStrength(input.password, minLength);
  if (!strength.valid) throw new ValidationError(strength.errors.join(' '));

  const roleId = resolveRoleId(input.role);
  const { hash, salt } = hashPassword(input.password);
  const at = nowIso();

  const info = getDb().prepare(`
    INSERT INTO users (username, full_name, password_hash, password_salt, role_id, phone, email, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    username, fullName, hash, salt, roleId,
    input.phone || null, input.email || null,
    input.status === 'disabled' ? 'disabled' : 'active', at, at
  );

  activity.log({ user, action: 'user.created', entityType: 'user', entityId: info.lastInsertRowid, details: { username, role: input.role } });
  return get(info.lastInsertRowid);
}

function update(id, input, { user = null } = {}) {
  const existing = findById(id);
  if (!existing) throw new NotFoundError('That user account no longer exists.');

  const fullName = String(input.fullName ?? existing.full_name).trim();
  if (fullName.length < 2) throw new ValidationError('Enter the full name of this user.');
  const roleId = input.role ? resolveRoleId(input.role) : existing.role_id;
  const status = input.status === 'disabled' ? 'disabled' : 'active';

  // The last active owner must never be locked out of their own shop.
  if ((status === 'disabled' || roleId !== existing.role_id) && existing.role_name === 'owner') {
    const owners = getDb().prepare(`
      SELECT COUNT(*) AS n FROM users u JOIN roles r ON r.id = u.role_id
      WHERE r.name = 'owner' AND u.status = 'active' AND u.id <> ?
    `).get(id).n;
    if (owners === 0) {
      throw new ValidationError('This is the only active owner account — create another owner first.');
    }
  }

  getDb().prepare(`
    UPDATE users SET full_name = ?, role_id = ?, phone = ?, email = ?, status = ?, updated_at = ?
    WHERE id = ?
  `).run(fullName, roleId, input.phone || null, input.email || null, status, nowIso(), id);

  activity.log({ user, action: 'user.updated', entityType: 'user', entityId: id, details: { fullName, status } });
  return get(id);
}

/** An owner/manager resetting somebody else's password. */
function setPassword(id, newPassword, { user = null } = {}) {
  const existing = findById(id);
  if (!existing) throw new NotFoundError('That user account no longer exists.');
  const minLength = settings.get('security.min_password_length', 6);
  const strength = validatePasswordStrength(newPassword, minLength);
  if (!strength.valid) throw new ValidationError(strength.errors.join(' '));

  const { hash, salt } = hashPassword(newPassword);
  getDb().prepare(`
    UPDATE users SET password_hash = ?, password_salt = ?, failed_attempts = 0, locked_until = NULL, updated_at = ?
    WHERE id = ?
  `).run(hash, salt, nowIso(), id);

  activity.log({ user, action: 'user.password_reset', entityType: 'user', entityId: id });
  return true;
}

/** A user changing their own password — the current one must be supplied. */
function changeOwnPassword(id, currentPassword, newPassword) {
  const row = findById(id);
  if (!row) throw new NotFoundError('That user account no longer exists.');
  if (!verifyPassword(currentPassword, row.password_hash, row.password_salt)) {
    throw new ValidationError('Your current password is not correct.');
  }
  const minLength = settings.get('security.min_password_length', 6);
  const strength = validatePasswordStrength(newPassword, minLength);
  if (!strength.valid) throw new ValidationError(strength.errors.join(' '));

  const { hash, salt } = hashPassword(newPassword);
  getDb().prepare('UPDATE users SET password_hash = ?, password_salt = ?, updated_at = ? WHERE id = ?')
    .run(hash, salt, nowIso(), id);
  activity.log({ user: publicUser(row), action: 'user.password_changed', entityType: 'user', entityId: id });
  return true;
}

/**
 * User accounts are never deleted (their sales, refunds and audit entries must
 * remain attributable); they are disabled instead.
 */
function disable(id, { user = null } = {}) {
  return update(id, { status: 'disabled' }, { user });
}

function setRolePermissions(roleId, codes, { user = null } = {}) {
  const db = getDb();
  const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(roleId);
  if (!role) throw new NotFoundError('That role no longer exists.');
  if (role.name === 'owner') {
    throw new ValidationError('The owner role always keeps full access and cannot be restricted.');
  }
  const valid = (codes || []).filter((c) => PERMISSIONS.includes(c));

  db.transaction(() => {
    db.prepare('DELETE FROM role_permissions WHERE role_id = ?').run(roleId);
    const stmt = db.prepare(`
      INSERT INTO role_permissions (role_id, permission_id)
      SELECT ?, id FROM permissions WHERE code = ?
    `);
    for (const code of valid) stmt.run(roleId, code);
    activity.log({ user, action: 'user.permissions_changed', entityType: 'role', entityId: roleId, details: { role: role.name, permissions: valid } });
  })();

  return roles().find((r) => r.id === roleId);
}

// ------------------------------- Authentication ----------------------------

function authenticate(username, password) {
  const row = findByUsername(username);
  const generic = 'Incorrect username or password.';

  if (!row) throw new AppError(generic, { code: 'AUTH_FAILED' });
  if (row.status !== 'active') throw new AppError('This account has been disabled. Contact the shop owner.', { code: 'AUTH_DISABLED' });

  if (row.locked_until && row.locked_until > nowIso()) {
    throw new AppError('Too many failed attempts. Try again in a few minutes.', { code: 'AUTH_LOCKED' });
  }

  if (!verifyPassword(password, row.password_hash, row.password_salt)) {
    const attempts = row.failed_attempts + 1;
    const lockedUntil = attempts >= MAX_FAILED_ATTEMPTS
      ? new Date(Date.now() + LOCK_MINUTES * 60000).toISOString()
      : null;
    getDb().prepare('UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?')
      .run(lockedUntil ? 0 : attempts, lockedUntil, row.id);
    activity.log({ user: null, action: 'auth.failed', entityType: 'user', entityId: row.id, details: { username: row.username } });
    if (lockedUntil) throw new AppError('Too many failed attempts. Try again in a few minutes.', { code: 'AUTH_LOCKED' });
    throw new AppError(generic, { code: 'AUTH_FAILED' });
  }

  getDb().prepare('UPDATE users SET last_login_at = ?, failed_attempts = 0, locked_until = NULL WHERE id = ?')
    .run(nowIso(), row.id);

  const user = publicUser(findById(row.id));
  activity.log({ user, action: 'auth.login', entityType: 'user', entityId: user.id });
  return user;
}

module.exports = {
  publicUser, get, list, countUsers, roles, allPermissions, permissionsForRole,
  create, update, setPassword, changeOwnPassword, disable, setRolePermissions,
  authenticate, findById
};
