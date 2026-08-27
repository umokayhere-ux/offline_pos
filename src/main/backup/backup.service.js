'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const connection = require('../database/connection');
const { seedReferenceData } = require('../database/seed');
const datetime = require('../../shared/datetime');
const { ValidationError, AppError, NotFoundError } = require('../../shared/errors');
const activity = require('../services/activity.service');
const settings = require('../services/settings.service');

/**
 * Backup and restore.
 *
 * Backups use SQLite's own online backup API (better-sqlite3's `db.backup`), so
 * a copy taken while the shop is trading is still internally consistent — unlike
 * copying the file with the filesystem while WAL pages are outstanding.
 *
 * Restoring NEVER overwrites the live database silently: the candidate file is
 * validated first, and a safety copy of the current database is taken before
 * anything is replaced.
 */

let defaultDirectory = null;

function setDefaultDirectory(dir) {
  defaultDirectory = dir;
}

function backupDirectory() {
  const configured = settings.get('backup.directory', '');
  const dir = configured || defaultDirectory;
  if (!dir) throw new AppError('No backup folder has been configured yet.', { code: 'NO_BACKUP_DIR' });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function backupFilename(at = new Date()) {
  return `shop_backup_${datetime.fileStamp(at)}.db`;
}

/** Take a backup. Returns the log row describing it. */
async function createBackup({ kind = 'manual', directory = null, user = null } = {}) {
  const db = connection.getDb();
  const dir = directory || backupDirectory();
  fs.mkdirSync(dir, { recursive: true });

  let target = path.join(dir, backupFilename());
  let counter = 1;
  while (fs.existsSync(target)) {
    target = path.join(dir, backupFilename().replace(/\.db$/, `_${counter}.db`));
    counter += 1;
  }

  try {
    await db.backup(target);
  } catch (error) {
    logBackup({ filename: path.basename(target), filePath: target, size: 0, kind, status: 'failed', message: error.message, user });
    throw new AppError('The backup could not be written. Check that the backup folder exists and has free space.', { code: 'BACKUP_FAILED', cause: error });
  }

  const size = fs.statSync(target).size;
  const row = logBackup({ filename: path.basename(target), filePath: target, size, kind, status: 'ok', user });

  settings.update({ 'backup.last_run_at': datetime.nowIso() }, { user, silent: true });
  activity.log({ user, action: 'backup.created', entityType: 'backup', entityId: row.id, details: { filename: row.filename, kind } });
  return row;
}

function logBackup({ filename, filePath, size, kind, status, message = null, user = null }) {
  const info = connection.getDb().prepare(`
    INSERT INTO backup_logs (filename, path, size_bytes, kind, status, message, user_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(filename, filePath, size, kind, status, message, user ? user.id : null, datetime.nowIso());
  return connection.getDb().prepare('SELECT * FROM backup_logs WHERE id = ?').get(info.lastInsertRowid);
}

/**
 * Check that a file really is one of this application's databases before it is
 * allowed anywhere near the live data.
 */
function validateBackupFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return { valid: false, reason: 'That file could not be found.' };
  }
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size < 4096) {
    return { valid: false, reason: 'That file is too small to be a valid backup.' };
  }

  let probe;
  try {
    probe = new Database(filePath, { readonly: true, fileMustExist: true });
    const integrity = probe.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok') {
      return { valid: false, reason: 'The backup file is damaged and cannot be restored.' };
    }

    const required = ['sales', 'sale_items', 'products', 'users', 'settings', 'schema_migrations'];
    const tables = new Set(probe.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
    const missing = required.filter((t) => !tables.has(t));
    if (missing.length) {
      return { valid: false, reason: 'That file is not an iTtEk POS backup.' };
    }

    const stats = {
      products: probe.prepare('SELECT COUNT(*) AS n FROM products').get().n,
      sales: probe.prepare('SELECT COUNT(*) AS n FROM sales').get().n,
      customers: probe.prepare('SELECT COUNT(*) AS n FROM customers').get().n,
      users: probe.prepare('SELECT COUNT(*) AS n FROM users').get().n,
      migrations: probe.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n,
      shopName: (probe.prepare("SELECT value FROM settings WHERE key = 'shop.name'").get() || {}).value || ''
    };

    if (stats.users === 0) {
      return { valid: false, reason: 'That backup contains no user accounts, so you would not be able to sign in.' };
    }

    return { valid: true, stats, sizeBytes: stat.size, modifiedAt: stat.mtime.toISOString() };
  } catch (error) {
    return { valid: false, reason: 'That file could not be opened as a database.' };
  } finally {
    if (probe) try { probe.close(); } catch { /* ignore */ }
  }
}

/**
 * Replace the live database with a validated backup.
 * The caller MUST have confirmed with the user first — this function assumes
 * consent but still refuses to proceed on an invalid file.
 */
async function restoreBackup(filePath, { user = null } = {}) {
  const check = validateBackupFile(filePath);
  if (!check.valid) throw new ValidationError(check.reason);

  const livePath = connection.getDatabasePath();
  if (!livePath) throw new AppError('The database is not open.', { code: 'NO_DB' });

  // 1. Safety copy of what is about to be replaced.
  const safety = await createBackup({ kind: 'pre_restore', user });

  // 2. Close the live database and swap the files.
  connection.closeDatabase();
  try {
    for (const suffix of ['-wal', '-shm']) {
      const sidecar = `${livePath}${suffix}`;
      if (fs.existsSync(sidecar)) fs.rmSync(sidecar);
    }
    fs.copyFileSync(filePath, livePath);
  } catch (error) {
    // Put the shop back on its feet with the safety copy.
    try { fs.copyFileSync(safety.path, livePath); } catch { /* nothing more we can do */ }
    connection.initDatabase(livePath);
    throw new AppError('The restore failed and your original data has been put back.', { code: 'RESTORE_FAILED', cause: error });
  }

  // 3. Reopen, migrate the restored file forward and re-seed reference data.
  const db = connection.initDatabase(livePath);
  seedReferenceData(db);

  logBackup({
    filename: path.basename(filePath), filePath, size: fs.statSync(filePath).size,
    kind: 'manual', status: 'restored', message: `Restored over the live database. Safety copy: ${safety.filename}`, user
  });
  activity.log({
    user, action: 'backup.restored', entityType: 'backup',
    details: { restoredFrom: path.basename(filePath), safetyCopy: safety.filename, stats: check.stats }
  });

  return { restored: true, safetyBackup: safety, stats: check.stats };
}

function history({ limit = 50 } = {}) {
  return connection.getDb().prepare(`
    SELECT b.*, u.full_name AS user_name FROM backup_logs b
    LEFT JOIN users u ON u.id = b.user_id
    ORDER BY b.created_at DESC LIMIT ?
  `).all(limit).map((row) => ({ ...row, exists: fs.existsSync(row.path) }));
}

function removeBackupFile(id, { user = null } = {}) {
  const row = connection.getDb().prepare('SELECT * FROM backup_logs WHERE id = ?').get(id);
  if (!row) throw new NotFoundError('That backup entry no longer exists.');
  if (fs.existsSync(row.path)) fs.rmSync(row.path);
  connection.getDb().prepare("UPDATE backup_logs SET status = 'failed', message = 'File deleted by user' WHERE id = ?").run(id);
  activity.log({ user, action: 'backup.deleted', entityType: 'backup', entityId: id, details: { filename: row.filename } });
  return history();
}

/** Should an automatic backup run now, given the configured frequency? */
function isAutomaticBackupDue() {
  const frequency = settings.get('backup.frequency', 'daily');
  if (frequency === 'off') return false;
  const last = settings.get('backup.last_run_at', '');
  if (!last) return true;
  const elapsedHours = (Date.now() - new Date(last).getTime()) / 3600000;
  return frequency === 'weekly' ? elapsedHours >= 24 * 7 : elapsedHours >= 24;
}

async function runAutomaticBackupIfDue({ user = null } = {}) {
  try {
    if (!isAutomaticBackupDue()) return null;
    if (!settings.get('backup.directory', '') && !defaultDirectory) return null;
    return await createBackup({ kind: 'automatic', user });
  } catch (error) {
    // An automatic backup must never take the shop down.
    try {
      activity.log({ user, action: 'backup.automatic_failed', details: { message: error.message } });
    } catch { /* ignore */ }
    return null;
  }
}

module.exports = {
  createBackup, restoreBackup, validateBackupFile, history, removeBackupFile,
  backupFilename, backupDirectory, setDefaultDirectory,
  isAutomaticBackupDue, runAutomaticBackupIfDue
};
