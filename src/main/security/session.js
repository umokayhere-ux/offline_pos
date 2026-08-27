'use strict';

const { PermissionError, AppError } = require('../../shared/errors');

/**
 * The signed-in user lives in the MAIN process only. The renderer receives a
 * sanitised copy for display and can never assert an identity of its own — every
 * IPC handler resolves the caller from here, so a compromised renderer cannot
 * escalate by claiming to be somebody else.
 */

let current = null;          // { user, startedAt, lastActivityAt }
let timeoutMinutes = 30;

function start(user) {
  const at = Date.now();
  current = { user, startedAt: at, lastActivityAt: at };
  return user;
}

function end() {
  const user = current ? current.user : null;
  current = null;
  return user;
}

function setTimeoutMinutes(minutes) {
  const n = Number(minutes);
  timeoutMinutes = Number.isFinite(n) && n > 0 ? n : 30;
}

function isExpired() {
  if (!current) return false;
  return Date.now() - current.lastActivityAt > timeoutMinutes * 60000;
}

function touch() {
  if (current) current.lastActivityAt = Date.now();
}

/** The current user, or null. Does not throw. */
function peek() {
  if (current && isExpired()) end();
  return current ? current.user : null;
}

/** The current user; throws if nobody is signed in or the session has lapsed. */
function requireUser() {
  if (current && isExpired()) {
    end();
    throw new AppError('Your session has timed out. Please sign in again.', { code: 'SESSION_EXPIRED' });
  }
  if (!current) throw new AppError('Please sign in to continue.', { code: 'NOT_AUTHENTICATED' });
  touch();
  return current.user;
}

/** Assert the current user holds a permission. Owners implicitly hold all. */
function requirePermission(code) {
  const user = requireUser();
  if (user.role === 'owner') return user;
  if (!user.permissions || !user.permissions.includes(code)) {
    throw new PermissionError('You do not have permission to perform this action.');
  }
  return user;
}

function can(code) {
  const user = peek();
  if (!user) return false;
  if (user.role === 'owner') return true;
  return Array.isArray(user.permissions) && user.permissions.includes(code);
}

/** Refresh the cached copy after a role/permission change. */
function refresh(user) {
  if (current && user && current.user.id === user.id) current.user = user;
}

function state() {
  const user = peek();
  return {
    authenticated: !!user,
    user,
    timeoutMinutes,
    expiresInSeconds: current ? Math.max(0, Math.round((timeoutMinutes * 60000 - (Date.now() - current.lastActivityAt)) / 1000)) : 0
  };
}

module.exports = { start, end, peek, requireUser, requirePermission, can, refresh, touch, setTimeoutMinutes, state, isExpired };
