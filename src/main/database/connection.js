'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { nowIso } = require('../../shared/datetime');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

let instance = null;
let instancePath = null;

/**
 * Open (or create) a database file, apply pending migrations and seed the
 * reference data. Safe to call repeatedly for the same path.
 */
function openDatabase(filePath, { verbose = null } = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new Database(filePath, { verbose });

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = FULL');   // a shop PC can lose power mid-sale
  db.pragma('busy_timeout = 5000');

  migrate(db);
  return db;
}

function migrate(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name       TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`);

  const applied = new Set(db.prepare('SELECT name FROM schema_migrations').all().map((r) => r.name));
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    const run = db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(file, nowIso());
    });
    run();
  }
}

/** Initialise the process-wide database handle. */
function initDatabase(filePath, options) {
  if (instance && instancePath === filePath) return instance;
  if (instance) closeDatabase();
  instance = openDatabase(filePath, options);
  instancePath = filePath;
  return instance;
}

function getDb() {
  if (!instance) throw new Error('Database has not been initialised');
  return instance;
}

function getDatabasePath() {
  return instancePath;
}

function closeDatabase() {
  if (instance) {
    try { instance.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* best effort */ }
    instance.close();
  }
  instance = null;
  instancePath = null;
}

/** Run `fn` inside a transaction; nested calls join the outer transaction. */
function transaction(fn) {
  return getDb().transaction(fn);
}

module.exports = {
  openDatabase,
  initDatabase,
  getDb,
  getDatabasePath,
  closeDatabase,
  transaction,
  MIGRATIONS_DIR
};
