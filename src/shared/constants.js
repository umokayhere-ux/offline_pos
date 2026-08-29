'use strict';

/**
 * Application-wide constants.
 * The application is permanently configured for Ghana Cedis (GHS).
 */

const CURRENCY = Object.freeze({
  code: 'GHS',
  symbol: '₵', // ₵
  name: 'Ghana Cedi',
  minorUnit: 'pesewa',
  decimals: 2,
  minorPerMajor: 100
});

/** Quantities are stored as integers scaled by this factor (3 decimal places). */
const QTY_SCALE = 1000;
const QTY_DECIMALS = 3;

const TIMEZONE = 'Africa/Accra';

const UNITS = Object.freeze(['Piece', 'Pack', 'Box', 'Kg', 'Gram', 'Litre', 'Metre', 'Other']);

const PAYMENT_METHODS = Object.freeze(['cash', 'momo', 'card', 'credit']);
const PAYMENT_METHOD_LABELS = Object.freeze({
  cash: 'Cash',
  momo: 'Mobile Money',
  card: 'Card',
  credit: 'Credit / Debt'
});

const ROLES = Object.freeze(['owner', 'manager', 'attendant']);

/**
 * Every permission the application understands. Roles are mapped to these in
 * the database (role_permissions) so an owner can reconfigure them later.
 */
const PERMISSIONS = Object.freeze([
  'pos.use',
  'pos.discount',
  'products.view', 'products.manage',
  'categories.manage',
  'suppliers.view', 'suppliers.manage',
  'purchases.view', 'purchases.manage',
  'customers.view', 'customers.manage',
  'debts.view', 'debts.manage',
  'expenses.view', 'expenses.manage',
  'refunds.view', 'refunds.manage',
  'reports.view',
  'inventory.adjust',
  'users.manage',
  'settings.manage',
  'backup.manage',
  'activity.view'
]);

const DEFAULT_ROLE_PERMISSIONS = Object.freeze({
  owner: PERMISSIONS.slice(),
  manager: [
    'pos.use', 'pos.discount',
    'products.view', 'products.manage',
    'categories.manage',
    'suppliers.view', 'suppliers.manage',
    'purchases.view', 'purchases.manage',
    'customers.view', 'customers.manage',
    'debts.view', 'debts.manage',
    'expenses.view', 'expenses.manage',
    'refunds.view', 'refunds.manage',
    'reports.view',
    'inventory.adjust',
    'activity.view'
  ],
  attendant: [
    'pos.use',
    'products.view',
    'customers.view', 'customers.manage',
    'debts.view',
    // Petty cash from the till is theirs to record; the IPC layer narrows what
    // they can read back to their own entries for the current day.
    'expenses.view', 'expenses.manage',
    'refunds.view'
  ]
});

const STOCK_MOVEMENT_REASONS = Object.freeze([
  'sale', 'refund', 'purchase', 'adjustment', 'opening', 'import'
]);

const EXPENSE_CATEGORY_SEED = Object.freeze([
  'Electricity', 'Water', 'Transport', 'Salary', 'Rent',
  'Internet', 'Maintenance', 'Supplies', 'Miscellaneous'
]);

module.exports = {
  CURRENCY,
  QTY_SCALE,
  QTY_DECIMALS,
  TIMEZONE,
  UNITS,
  PAYMENT_METHODS,
  PAYMENT_METHOD_LABELS,
  ROLES,
  PERMISSIONS,
  DEFAULT_ROLE_PERMISSIONS,
  STOCK_MOVEMENT_REASONS,
  EXPENSE_CATEGORY_SEED
};
