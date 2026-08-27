'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * The security bridge.
 *
 * The renderer gets exactly one thing: a set of async functions, one per
 * whitelisted channel. It has no `require`, no `fs`, no database handle and no
 * way to reach a channel that is not in the list. Every call is answered by a
 * main-process handler that re-checks the caller's permissions.
 *
 * This file runs in a SANDBOXED preload context, which cannot require project
 * modules — so the channel list is repeated here rather than imported. It must
 * stay identical to src/shared/channels.js and the reference data in
 * src/shared/constants.js; tests/unit/preload.test.js fails the build if the two
 * ever drift apart.
 */

const CHANNELS = [
  // Session and setup
  'auth.state', 'auth.login', 'auth.logout', 'auth.changePassword', 'auth.touch',
  'setup.status', 'setup.complete',

  // Dashboard and reports
  'dashboard.load',
  'reports.summary', 'reports.sales', 'reports.profit', 'reports.inventory',
  'reports.cashiers', 'reports.customers', 'reports.suppliers', 'reports.debts',
  'reports.export',

  // Point of sale
  'pos.priceCart', 'pos.completeSale', 'pos.scanBarcode',
  'pos.hold', 'pos.listHeld', 'pos.resumeHeld', 'pos.deleteHeld',

  // Sales
  'sales.list', 'sales.get', 'sales.findByInvoice',

  // Products
  'products.list', 'products.quickSearch', 'products.get', 'products.create',
  'products.update', 'products.delete', 'products.generateBarcode',
  'products.printLabels', 'products.previewBarcode',
  'products.importAnalyse', 'products.import', 'products.importTemplate', 'products.export',

  // Inventory
  'inventory.adjust', 'inventory.movements', 'inventory.lowStock',

  // Categories
  'categories.list', 'categories.create', 'categories.update', 'categories.delete',

  // Customers
  'customers.list', 'customers.quickSearch', 'customers.get', 'customers.create',
  'customers.update', 'customers.delete', 'customers.profile',

  // Suppliers
  'suppliers.list', 'suppliers.get', 'suppliers.create', 'suppliers.update',
  'suppliers.delete', 'suppliers.profile', 'suppliers.recordPayment',

  // Purchases
  'purchases.list', 'purchases.get', 'purchases.create',

  // Debts
  'debts.list', 'debts.get', 'debts.recordPayment', 'debts.writeOff',

  // Refunds
  'refunds.list', 'refunds.get', 'refunds.create', 'refunds.refundableLines',

  // Expenses
  'expenses.list', 'expenses.get', 'expenses.create', 'expenses.update', 'expenses.void',
  'expenses.categories', 'expenses.createCategory', 'expenses.deleteCategory',

  // Users and permissions
  'users.list', 'users.get', 'users.create', 'users.update', 'users.setPassword',
  'users.disable', 'users.roles', 'users.permissions', 'users.setRolePermissions',

  // Settings
  'settings.all', 'settings.update', 'settings.shopProfile',
  'settings.receipt', 'settings.updateReceipt', 'settings.chooseLogo',

  // Printing
  'print.receipt', 'print.previewReceipt', 'print.test', 'print.listPrinters', 'print.document',

  // Backup
  'backup.create', 'backup.restore', 'backup.history', 'backup.validate',
  'backup.chooseDirectory', 'backup.chooseFile', 'backup.delete',

  // Activity log
  'activity.list', 'activity.actions',

  // Files and app
  'file.saveAs', 'file.openCsv',
  'app.info', 'app.confirm'
];

const EVENTS = ['session.expired', 'app.notice', 'shortcut'];

const CURRENCY = { code: 'GHS', symbol: '₵', name: 'Ghana Cedi', decimals: 2, minorPerMajor: 100 };
const UNITS = ['Piece', 'Pack', 'Box', 'Kg', 'Gram', 'Litre', 'Metre', 'Other'];
const PAYMENT_METHODS = ['cash', 'momo', 'card', 'credit'];
const PAYMENT_METHOD_LABELS = {
  cash: 'Cash', momo: 'Mobile Money', card: 'Card', credit: 'Credit / Debt'
};

function buildApi() {
  const api = {};
  for (const channel of CHANNELS) {
    const [domain, action] = channel.split('.');
    if (!api[domain]) api[domain] = {};
    api[domain][action] = (payload) => ipcRenderer.invoke(channel, payload);
  }
  return api;
}

const listeners = new Map();

contextBridge.exposeInMainWorld('api', {
  ...buildApi(),

  /** Subscribe to a main-process event. Returns an unsubscribe function. */
  on(event, callback) {
    if (!EVENTS.includes(event)) throw new Error(`Unknown event: ${event}`);
    if (typeof callback !== 'function') throw new Error('A callback function is required');
    const wrapped = (_event, payload) => callback(payload);
    ipcRenderer.on(event, wrapped);
    listeners.set(callback, { event, wrapped });
    return () => {
      ipcRenderer.removeListener(event, wrapped);
      listeners.delete(callback);
    };
  }
});

/**
 * Read-only reference data the UI needs for labels and dropdowns. Exposing it
 * here avoids a round trip for values that can never change at runtime.
 */
contextBridge.exposeInMainWorld('appConstants', {
  currency: CURRENCY,
  units: UNITS,
  paymentMethods: PAYMENT_METHODS,
  paymentMethodLabels: PAYMENT_METHOD_LABELS
});
