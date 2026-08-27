'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const connection = require('../../src/main/database/connection');
const { seedReferenceData } = require('../../src/main/database/seed');

/**
 * Spin up a real, isolated SQLite database on disk for integration tests —
 * the same migrations, the same triggers, the same foreign keys as production.
 */
function createTestDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ittek-pos-test-'));
  const file = path.join(dir, 'shop.db');
  const db = connection.initDatabase(file);
  seedReferenceData(db);

  const users = require('../../src/main/services/user.service');
  const owner = users.create(
    { username: 'owner', fullName: 'Shop Owner', password: 'owner123', role: 'owner' },
    { user: null }
  );

  return {
    db,
    file,
    dir,
    owner,
    cleanup() {
      connection.closeDatabase();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

module.exports = { createTestDb };
