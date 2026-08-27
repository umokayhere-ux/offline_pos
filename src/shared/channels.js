'use strict';

/**
 * The complete list of IPC channels the renderer may call.
 *
 * This list is the security boundary: the preload script builds the renderer's
 * API from it, and the main process registers a handler for each entry and for
 * nothing else. A channel that is not named here simply does not exist.
 *
 * Naming: "<domain>.<action>" becomes window.api.<domain>.<action>(payload).
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

/** Events the main process pushes to the renderer. */
const EVENTS = ['session.expired', 'app.notice', 'shortcut'];

module.exports = { CHANNELS, EVENTS };
