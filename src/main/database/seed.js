'use strict';

const { nowIso } = require('../../shared/datetime');
const {
  ROLES, PERMISSIONS, DEFAULT_ROLE_PERMISSIONS, EXPENSE_CATEGORY_SEED
} = require('../../shared/constants');

const ROLE_LABELS = { owner: 'CEO / Owner', manager: 'Manager', attendant: 'Sales Attendant' };

const DEFAULT_SETTINGS = {
  'shop.name': 'iTtEk POS',
  'shop.address': '',
  'shop.phone': '',
  'shop.email': '',
  'shop.logo_path': '',
  'shop.tin': '',
  'shop.motto': '',
  'app.timezone': 'Africa/Accra',
  'app.setup_complete': 'false',
  'app.demo_mode': 'false',
  'inventory.quantity_precision': '3',
  'inventory.low_stock_default_milli': '5000',
  'inventory.allow_negative_stock': 'false',
  'pos.scan_behaviour': 'increment',      // increment | prompt
  'pos.require_customer_for_credit': 'true',
  'security.session_timeout_minutes': '30',
  'security.min_password_length': '6',
  'backup.directory': '',
  'backup.frequency': 'daily',            // off | daily | weekly
  'backup.last_run_at': ''
};

/** Insert reference data that must exist in every database. Idempotent. */
function seedReferenceData(db) {
  const at = nowIso();

  const insertPermission = db.prepare(
    'INSERT OR IGNORE INTO permissions (code, label) VALUES (?, ?)'
  );
  for (const code of PERMISSIONS) insertPermission.run(code, humanisePermission(code));

  const insertRole = db.prepare(
    'INSERT OR IGNORE INTO roles (name, label, is_system, created_at) VALUES (?, ?, 1, ?)'
  );
  for (const role of ROLES) insertRole.run(role, ROLE_LABELS[role] || role, at);

  // Default role -> permission mapping, only for roles that have none yet, so an
  // owner's later customisation is never overwritten on restart.
  const roleRow = db.prepare('SELECT id FROM roles WHERE name = ?');
  const permRow = db.prepare('SELECT id FROM permissions WHERE code = ?');
  const countMapped = db.prepare('SELECT COUNT(*) AS n FROM role_permissions WHERE role_id = ?');
  const mapPermission = db.prepare(
    'INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)'
  );
  for (const role of ROLES) {
    const r = roleRow.get(role);
    if (!r) continue;
    if (countMapped.get(r.id).n > 0) continue;
    for (const code of DEFAULT_ROLE_PERMISSIONS[role] || []) {
      const p = permRow.get(code);
      if (p) mapPermission.run(r.id, p.id);
    }
  }

  const insertExpenseCategory = db.prepare(
    'INSERT OR IGNORE INTO expense_categories (name, is_system, created_at) VALUES (?, 1, ?)'
  );
  for (const name of EXPENSE_CATEGORY_SEED) insertExpenseCategory.run(name, at);

  const insertSetting = db.prepare(
    'INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, ?)'
  );
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) insertSetting.run(key, value, at);

  db.prepare(`INSERT OR IGNORE INTO receipt_settings (id, updated_at) VALUES (1, ?)`).run(at);

  db.prepare(`INSERT OR IGNORE INTO categories (name, description, status, created_at, updated_at)
              VALUES ('Uncategorised', 'Default category', 'active', ?, ?)`).run(at, at);
}

function humanisePermission(code) {
  const [group, action] = code.split('.');
  const verb = { view: 'View', manage: 'Manage', use: 'Use', adjust: 'Adjust', discount: 'Apply discounts in' }[action] || action;
  const noun = group.charAt(0).toUpperCase() + group.slice(1);
  return `${verb} ${noun}`;
}

module.exports = { seedReferenceData, DEFAULT_SETTINGS, ROLE_LABELS };
