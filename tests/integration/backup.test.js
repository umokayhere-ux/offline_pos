'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createTestDb } = require('../helpers/testDb');

const backup = require('../../src/main/backup/backup.service');
const products = require('../../src/main/services/product.service');
const settings = require('../../src/main/services/settings.service');
const connection = require('../../src/main/database/connection');

let ctx; let user; let backupDir;

test.beforeEach(() => {
  ctx = createTestDb();
  user = ctx.owner;
  backupDir = path.join(ctx.dir, 'backups');
  backup.setDefaultDirectory(backupDir);
  settings.update({ 'backup.directory': backupDir }, { user, silent: true });
});
test.afterEach(() => ctx.cleanup());

test('a backup is written, logged and named with a timestamp', async () => {
  products.create({ name: 'Before backup', sellingPrice: '10.00', costPrice: '5.00', stock: '5' }, { user });
  const row = await backup.createBackup({ user });

  assert.match(row.filename, /^shop_backup_\d{4}-\d{2}-\d{2}_\d{4}\.db$/);
  assert.ok(fs.existsSync(row.path));
  assert.ok(row.size_bytes > 4096);
  assert.equal(backup.history()[0].filename, row.filename);
});

test('a backup is validated before it is trusted', async () => {
  const row = await backup.createBackup({ user });
  const check = backup.validateBackupFile(row.path);
  assert.equal(check.valid, true);
  assert.equal(check.stats.users, 1);
});

test('rubbish files are refused as backups', () => {
  const junk = path.join(ctx.dir, 'not-a-database.db');
  fs.writeFileSync(junk, Buffer.alloc(8192, 1));
  assert.equal(backup.validateBackupFile(junk).valid, false);

  assert.equal(backup.validateBackupFile(path.join(ctx.dir, 'missing.db')).valid, false);

  const tiny = path.join(ctx.dir, 'tiny.db');
  fs.writeFileSync(tiny, 'hello');
  assert.match(backup.validateBackupFile(tiny).reason, /too small/);
});

test('an unrelated SQLite database is refused', () => {
  const other = path.join(ctx.dir, 'other.db');
  const Database = require('better-sqlite3');
  const db = new Database(other);
  db.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)');
  for (let i = 0; i < 400; i += 1) db.prepare('INSERT INTO notes (body) VALUES (?)').run('x'.repeat(64));
  db.close();
  assert.match(backup.validateBackupFile(other).reason, /not an iTtEk POS backup/);
});

test('restoring brings back the earlier data and keeps a safety copy first', async () => {
  products.create({ name: 'Original product', sellingPrice: '10.00', costPrice: '5.00', stock: '5' }, { user });
  const snapshot = await backup.createBackup({ user });

  products.create({ name: 'Added after the backup', sellingPrice: '20.00', costPrice: '9.00', stock: '2' }, { user });
  assert.equal(products.list({ search: 'Added after' }).total, 1);

  const result = await backup.restoreBackup(snapshot.path, { user });
  assert.equal(result.restored, true);
  assert.ok(fs.existsSync(result.safetyBackup.path), 'a safety copy of the replaced database exists');

  assert.equal(products.list({ search: 'Added after' }).total, 0, 'post-backup data is gone');
  assert.equal(products.list({ search: 'Original product' }).total, 1, 'pre-backup data is back');
  assert.equal(connection.getDb().prepare('SELECT COUNT(*) AS n FROM users').get().n, 1, 'the database is usable again');
});

test('restoring an invalid file changes nothing', async () => {
  products.create({ name: 'Still here', sellingPrice: '10.00', costPrice: '5.00', stock: '1' }, { user });
  const junk = path.join(ctx.dir, 'junk.db');
  fs.writeFileSync(junk, Buffer.alloc(9000, 7));

  await assert.rejects(() => backup.restoreBackup(junk, { user }), /could not be opened|not an iTtEk POS backup|damaged/);
  assert.equal(products.list({ search: 'Still here' }).total, 1);
});

test('the automatic backup schedule respects the configured frequency', async () => {
  settings.update({ 'backup.frequency': 'off' }, { user, silent: true });
  assert.equal(backup.isAutomaticBackupDue(), false);

  settings.update({ 'backup.frequency': 'daily', 'backup.last_run_at': '' }, { user, silent: true });
  assert.equal(backup.isAutomaticBackupDue(), true);

  await backup.runAutomaticBackupIfDue({ user });
  assert.equal(backup.isAutomaticBackupDue(), false, 'it does not run twice in one day');
  assert.equal(backup.history()[0].kind, 'automatic');
});
