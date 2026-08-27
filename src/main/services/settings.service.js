'use strict';

const { getDb } = require('../database/connection');
const { nowIso } = require('../../shared/datetime');
const { ValidationError } = require('../../shared/errors');
const activity = require('./activity.service');

/**
 * Shop / company configuration.
 *
 * Every screen that shows the shop name, address, phone, logo, receipt layout,
 * inventory precision or security policy reads it from here, so a change made in
 * Settings takes effect across the whole system immediately.
 */

const BOOLEAN_KEYS = new Set([
  'app.setup_complete', 'app.demo_mode',
  'inventory.allow_negative_stock'
]);

const NUMBER_KEYS = new Set([
  'inventory.quantity_precision', 'inventory.low_stock_default_milli',
  'security.session_timeout_minutes', 'security.min_password_length'
]);

/** Editable keys, with validation. Anything not listed here cannot be written from the UI. */
const WRITABLE = {
  'shop.name': { label: 'Shop name', required: true, maxLength: 80 },
  'shop.address': { label: 'Address', maxLength: 200 },
  'shop.phone': { label: 'Phone number', maxLength: 40 },
  'shop.email': { label: 'Email', maxLength: 120, email: true },
  'shop.logo_path': { label: 'Logo', maxLength: 400 },
  'shop.tin': { label: 'TIN', maxLength: 40 },
  'shop.motto': { label: 'Slogan', maxLength: 120 },
  'app.timezone': { label: 'Timezone', maxLength: 60 },
  'app.setup_complete': { label: 'Setup complete', boolean: true },
  'app.demo_mode': { label: 'Demo mode', boolean: true },
  'inventory.quantity_precision': { label: 'Quantity precision', number: true, min: 0, max: 3 },
  'inventory.low_stock_default_milli': { label: 'Default low-stock level', number: true, min: 0 },
  'inventory.allow_negative_stock': { label: 'Allow negative stock', boolean: true },
  'pos.scan_behaviour': { label: 'Scan behaviour', oneOf: ['increment', 'prompt'] },
  'security.session_timeout_minutes': { label: 'Session timeout', number: true, min: 1, max: 480 },
  'security.min_password_length': { label: 'Minimum password length', number: true, min: 4, max: 64 },
  'backup.directory': { label: 'Backup folder', maxLength: 400 },
  'backup.frequency': { label: 'Backup frequency', oneOf: ['off', 'daily', 'weekly'] },
  'backup.last_run_at': { label: 'Last backup', maxLength: 40 }
};

function coerce(key, rawValue) {
  if (rawValue === null || rawValue === undefined) return null;
  if (BOOLEAN_KEYS.has(key)) return rawValue === 'true' || rawValue === true;
  if (NUMBER_KEYS.has(key)) return Number(rawValue);
  return rawValue;
}

/** All settings as a typed object keyed by setting key. */
function all() {
  const rows = getDb().prepare('SELECT key, value FROM settings').all();
  const out = {};
  for (const row of rows) out[row.key] = coerce(row.key, row.value);
  return out;
}

function get(key, fallback = null) {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) return fallback;
  const value = coerce(key, row.value);
  return value === null || value === '' ? fallback : value;
}

function validate(key, value) {
  const rule = WRITABLE[key];
  if (!rule) throw new ValidationError(`"${key}" is not a configurable setting.`);
  if (rule.boolean) return value === true || value === 'true' ? 'true' : 'false';

  if (rule.number) {
    const n = Number(value);
    if (!Number.isFinite(n)) throw new ValidationError(`${rule.label} must be a number.`);
    if (rule.min !== undefined && n < rule.min) throw new ValidationError(`${rule.label} must be at least ${rule.min}.`);
    if (rule.max !== undefined && n > rule.max) throw new ValidationError(`${rule.label} must be at most ${rule.max}.`);
    return String(Math.trunc(n));
  }

  const text = value === null || value === undefined ? '' : String(value).trim();
  if (rule.required && text === '') throw new ValidationError(`${rule.label} is required.`);
  if (rule.maxLength && text.length > rule.maxLength) {
    throw new ValidationError(`${rule.label} cannot be longer than ${rule.maxLength} characters.`);
  }
  if (rule.oneOf && text && !rule.oneOf.includes(text)) {
    throw new ValidationError(`${rule.label} must be one of: ${rule.oneOf.join(', ')}.`);
  }
  if (rule.email && text && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(text)) {
    throw new ValidationError('Enter a valid email address.');
  }
  return text;
}

/** Write a batch of settings atomically and record the change in the audit trail. */
function update(values, { user = null, silent = false } = {}) {
  const db = getDb();
  const entries = Object.entries(values || {});
  if (entries.length === 0) return all();

  const prepared = entries.map(([key, value]) => [key, validate(key, value)]);
  const stmt = db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);

  db.transaction(() => {
    const at = nowIso();
    for (const [key, value] of prepared) stmt.run(key, value, at);
    if (!silent) {
      activity.log({
        user,
        action: 'settings.updated',
        entityType: 'settings',
        details: { keys: prepared.map(([k]) => k) }
      });
    }
  })();

  return all();
}

/** Shop identity used by the header, receipts and reports. */
function shopProfile() {
  const s = all();
  return {
    name: s['shop.name'] || 'iTtEk POS',
    address: s['shop.address'] || '',
    phone: s['shop.phone'] || '',
    email: s['shop.email'] || '',
    logoPath: s['shop.logo_path'] || '',
    tin: s['shop.tin'] || '',
    motto: s['shop.motto'] || '',
    timezone: s['app.timezone'] || 'Africa/Accra'
  };
}

// ------------------------------ Receipt settings ---------------------------

function receiptSettings() {
  const row = getDb().prepare('SELECT * FROM receipt_settings WHERE id = 1').get();
  return {
    paperWidth: row.paper_width,
    showLogo: !!row.show_logo,
    showCashier: !!row.show_cashier,
    showCustomer: !!row.show_customer,
    headerNote: row.header_note || '',
    footerMessage: row.footer_message || '',
    printerName: row.printer_name || '',
    autoPrint: !!row.auto_print
  };
}

function updateReceiptSettings(input, { user = null } = {}) {
  const allowedWidths = ['58mm', '80mm', 'A4'];
  const paperWidth = input.paperWidth || '80mm';
  if (!allowedWidths.includes(paperWidth)) {
    throw new ValidationError(`Receipt width must be one of: ${allowedWidths.join(', ')}.`);
  }
  const footer = String(input.footerMessage ?? '').slice(0, 200);
  const header = String(input.headerNote ?? '').slice(0, 200);

  getDb().prepare(`
    UPDATE receipt_settings SET
      paper_width = ?, show_logo = ?, show_cashier = ?, show_customer = ?,
      header_note = ?, footer_message = ?, printer_name = ?, auto_print = ?, updated_at = ?
    WHERE id = 1
  `).run(
    paperWidth,
    input.showLogo ? 1 : 0,
    input.showCashier ? 1 : 0,
    input.showCustomer ? 1 : 0,
    header,
    footer,
    input.printerName || null,
    input.autoPrint ? 1 : 0,
    nowIso()
  );

  activity.log({ user, action: 'settings.receipt_updated', entityType: 'receipt_settings', entityId: 1 });
  return receiptSettings();
}

module.exports = {
  all, get, update, validate, shopProfile,
  receiptSettings, updateReceiptSettings,
  WRITABLE
};
