'use strict';

const fs = require('fs');
const path = require('path');
const { ipcMain, dialog, app, BrowserWindow } = require('electron');

const { CHANNELS } = require('../../shared/channels');
const { toUserFacingError, ValidationError } = require('../../shared/errors');
const logger = require('../logger');
const session = require('../security/session');

const setup = require('../services/setup.service');
const users = require('../services/user.service');
const settings = require('../services/settings.service');
const products = require('../services/product.service');
const categories = require('../services/category.service');
const customers = require('../services/customer.service');
const suppliers = require('../services/supplier.service');
const purchases = require('../services/purchase.service');
const sales = require('../services/sale.service');
const refunds = require('../services/refund.service');
const debts = require('../services/debt.service');
const expenses = require('../services/expense.service');
const inventory = require('../services/inventory.service');
const reports = require('../services/report.service');
const activity = require('../services/activity.service');
const barcode = require('../services/barcode.service');
const io = require('../services/importexport.service');
const backup = require('../backup/backup.service');
const printing = require('../printers/print.service');

/**
 * IPC handlers.
 *
 * Every entry declares the permission it needs. The permission is checked in the
 * MAIN process against the session held here — the renderer's copy of the user
 * is for display only and is never trusted. Errors are translated into messages
 * a shopkeeper can act on; the technical detail goes to the log file.
 *
 *   null            no session required (login, setup, app info)
 *   'authenticated' any signed-in user
 *   '<permission>'  that specific permission
 */

const handlers = {
  // ------------------------------- Session ---------------------------------
  'auth.state': [null, () => session.state()],
  'auth.login': [null, ({ username, password }) => {
    const user = users.authenticate(username, password);
    session.setTimeoutMinutes(settings.get('security.session_timeout_minutes', 30));
    session.start(user);
    return session.state();
  }],
  'auth.logout': [null, () => {
    const user = session.peek();
    if (user) activity.log({ user, action: 'auth.logout', entityType: 'user', entityId: user.id });
    session.end();
    return { authenticated: false };
  }],
  'auth.changePassword': ['authenticated', ({ currentPassword, newPassword }, user) =>
    users.changeOwnPassword(user.id, currentPassword, newPassword)],
  'auth.touch': [null, () => { session.touch(); return session.state(); }],

  'setup.status': [null, () => setup.status()],
  'setup.complete': [null, (payload) => {
    const result = setup.complete(payload, { user: session.peek() });
    if (result.owner) session.start(result.owner);
    return { ...result, session: session.state() };
  }],

  // ------------------------------ Dashboard --------------------------------
  'dashboard.load': ['authenticated', () => reports.dashboard()],
  'reports.summary': ['reports.view', (payload) => reports.summary(payload || {})],
  'reports.sales': ['reports.view', (payload) => reports.salesReport(payload || {})],
  'reports.profit': ['reports.view', (payload) => reports.profitReport(payload || {})],
  'reports.inventory': ['reports.view', (payload) => reports.inventoryReport(payload || {})],
  'reports.cashiers': ['reports.view', (payload) => reports.cashierReport(payload || {})],
  'reports.customers': ['reports.view', (payload) => reports.customerReport(payload || {})],
  'reports.suppliers': ['reports.view', () => reports.supplierReport()],
  'reports.debts': ['reports.view', (payload) => reports.debtReport(payload || {})],
  'reports.export': ['reports.view', ({ kind, rows }) => io.exportReport(kind, rows)],

  // -------------------------------- POS ------------------------------------
  'pos.priceCart': ['pos.use', (payload) => sales.priceCart(payload)],
  'pos.completeSale': ['pos.use', (payload, user) => sales.complete(payload, { user })],
  'pos.scanBarcode': ['pos.use', ({ barcode: code }) => {
    const product = products.findByBarcode(code);
    return { found: !!product, product };
  }],
  'pos.hold': ['pos.use', (payload, user) => sales.hold(payload, { user })],
  'pos.listHeld': ['pos.use', (payload, user) => sales.listHeld({ user })],
  'pos.resumeHeld': ['pos.use', ({ id }, user) => sales.resumeHeld(id, { user })],
  'pos.deleteHeld': ['pos.use', ({ id }, user) => sales.deleteHeld(id, { user })],

  'sales.list': ['authenticated', (payload, user) => {
    // An attendant may only look at their own sales.
    const scoped = user.role === 'attendant' ? { ...payload, userId: user.id } : payload;
    return sales.list(scoped || {});
  }],
  'sales.get': ['authenticated', ({ id }) => sales.getSale(id)],
  'sales.findByInvoice': ['authenticated', ({ invoiceNo }) => sales.findByInvoice(invoiceNo)],

  // ------------------------------ Products ---------------------------------
  'products.list': ['products.view', (payload) => products.list(payload || {})],
  'products.quickSearch': ['products.view', ({ term, limit }) => products.quickSearch(term, limit)],
  'products.get': ['products.view', ({ id }) => products.get(id)],
  'products.create': ['products.manage', (payload, user) => products.create(payload, { user })],
  'products.update': ['products.manage', ({ id, ...rest }, user) => products.update(id, rest, { user })],
  'products.delete': ['products.manage', ({ id }, user) => products.remove(id, { user })],
  'products.generateBarcode': ['products.manage', () => ({ barcode: products.generateBarcode() })],
  'products.previewBarcode': ['products.view', ({ value }) => ({ svg: barcode.barcodeSvg(value) })],
  'products.printLabels': ['products.manage', async ({ entries }) => {
    const html = barcode.labelSheetHtml(entries);
    return printing.printDocument(html, { silent: false });
  }],
  'products.importAnalyse': ['products.manage', ({ csv }) => io.analyseProductCsv(csv)],
  'products.import': ['products.manage', ({ csv, createMissingCategories }, user) =>
    io.importProducts(csv, { user, createMissingCategories })],
  'products.importTemplate': ['products.manage', () => io.productImportTemplate()],
  'products.export': ['products.view', (payload) => io.exportProducts(payload || {})],

  // ------------------------------ Inventory --------------------------------
  'inventory.adjust': ['inventory.adjust', (payload, user) => inventory.adjustStock({ ...payload, user })],
  'inventory.movements': ['products.view', (payload) => inventory.movements(payload || {})],
  'inventory.lowStock': ['products.view', ({ limit } = {}) => inventory.lowStockProducts(limit || 50)],

  // ------------------------------ Categories -------------------------------
  'categories.list': ['products.view', (payload) => categories.list(payload || {})],
  'categories.create': ['categories.manage', (payload, user) => categories.create(payload, { user })],
  'categories.update': ['categories.manage', ({ id, ...rest }, user) => categories.update(id, rest, { user })],
  'categories.delete': ['categories.manage', ({ id, reassignTo, force }, user) =>
    categories.remove(id, { reassignTo, force, user })],

  // ------------------------------ Customers --------------------------------
  'customers.list': ['customers.view', (payload) => customers.list(payload || {})],
  'customers.quickSearch': ['customers.view', ({ term, limit }) => customers.quickSearch(term, limit)],
  'customers.get': ['customers.view', ({ id }) => customers.get(id)],
  'customers.profile': ['customers.view', ({ id }) => customers.profile(id)],
  'customers.create': ['customers.manage', (payload, user) => customers.create(payload, { user })],
  'customers.update': ['customers.manage', ({ id, ...rest }, user) => customers.update(id, rest, { user })],
  'customers.delete': ['customers.manage', ({ id }, user) => customers.remove(id, { user })],

  // ------------------------------ Suppliers --------------------------------
  'suppliers.list': ['suppliers.view', (payload) => suppliers.list(payload || {})],
  'suppliers.get': ['suppliers.view', ({ id }) => suppliers.get(id)],
  'suppliers.profile': ['suppliers.view', ({ id }) => suppliers.profile(id)],
  'suppliers.create': ['suppliers.manage', (payload, user) => suppliers.create(payload, { user })],
  'suppliers.update': ['suppliers.manage', ({ id, ...rest }, user) => suppliers.update(id, rest, { user })],
  'suppliers.delete': ['suppliers.manage', ({ id }, user) => suppliers.remove(id, { user })],
  'suppliers.recordPayment': ['suppliers.manage', (payload, user) => suppliers.recordPayment(payload, { user })],

  // ------------------------------ Purchases --------------------------------
  'purchases.list': ['purchases.view', (payload) => purchases.list(payload || {})],
  'purchases.get': ['purchases.view', ({ id }) => purchases.get(id)],
  'purchases.create': ['purchases.manage', (payload, user) => purchases.create(payload, { user })],

  // -------------------------------- Debts ----------------------------------
  'debts.list': ['debts.view', (payload) => debts.list(payload || {})],
  'debts.get': ['debts.view', ({ id }) => debts.get(id)],
  'debts.recordPayment': ['debts.manage', (payload, user) => debts.recordPayment(payload, { user })],
  'debts.writeOff': ['debts.manage', ({ id, reason }, user) => debts.writeOff(id, reason, { user })],

  // ------------------------------- Refunds ---------------------------------
  'refunds.list': ['refunds.view', (payload) => refunds.list(payload || {})],
  'refunds.get': ['refunds.view', ({ id }) => refunds.get(id)],
  'refunds.refundableLines': ['refunds.view', ({ saleId }) => refunds.refundableLines(saleId)],
  'refunds.create': ['refunds.manage', (payload, user) => refunds.create(payload, { user })],

  // ------------------------------- Expenses --------------------------------
  'expenses.list': ['expenses.view', (payload) => expenses.list(payload || {})],
  'expenses.get': ['expenses.view', ({ id }) => expenses.get(id)],
  'expenses.categories': ['expenses.view', () => expenses.categories()],
  'expenses.create': ['expenses.manage', (payload, user) => expenses.create(payload, { user })],
  'expenses.update': ['expenses.manage', ({ id, ...rest }, user) => expenses.update(id, rest, { user })],
  'expenses.void': ['expenses.manage', ({ id, reason }, user) => expenses.voidExpense(id, reason, { user })],
  'expenses.createCategory': ['expenses.manage', ({ name }, user) => expenses.createCategory(name, { user })],
  'expenses.deleteCategory': ['expenses.manage', ({ id }, user) => expenses.deleteCategory(id, { user })],

  // -------------------------------- Users ----------------------------------
  'users.list': ['users.manage', () => users.list()],
  'users.get': ['users.manage', ({ id }) => users.get(id)],
  'users.create': ['users.manage', (payload, user) => users.create(payload, { user })],
  'users.update': ['users.manage', ({ id, ...rest }, user) => {
    const updated = users.update(id, rest, { user });
    session.refresh(updated);
    return updated;
  }],
  'users.setPassword': ['users.manage', ({ id, password }, user) => users.setPassword(id, password, { user })],
  'users.disable': ['users.manage', ({ id }, user) => users.disable(id, { user })],
  'users.roles': ['users.manage', () => users.roles()],
  'users.permissions': ['users.manage', () => users.allPermissions()],
  'users.setRolePermissions': ['users.manage', ({ roleId, permissions }, user) => {
    const role = users.setRolePermissions(roleId, permissions, { user });
    const current = session.peek();
    if (current && current.roleId === roleId) session.refresh(users.get(current.id));
    return role;
  }],

  // ------------------------------- Settings --------------------------------
  'settings.all': ['authenticated', () => settings.all()],
  'settings.shopProfile': ['authenticated', () => settings.shopProfile()],
  'settings.receipt': ['authenticated', () => settings.receiptSettings()],
  'settings.update': ['settings.manage', (payload, user) => {
    const updated = settings.update(payload, { user });
    session.setTimeoutMinutes(updated['security.session_timeout_minutes']);
    return updated;
  }],
  'settings.updateReceipt': ['settings.manage', (payload, user) => settings.updateReceiptSettings(payload, { user })],
  'settings.chooseLogo': ['settings.manage', async (payload, user, event) => {
    const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
      title: 'Choose your shop logo',
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'bmp'] }]
    });
    if (result.canceled || result.filePaths.length === 0) return { cancelled: true };

    // Copy the logo into the application's own data folder so it survives the
    // original file being moved or deleted.
    const source = result.filePaths[0];
    const targetDir = path.join(app.getPath('userData'), 'assets');
    fs.mkdirSync(targetDir, { recursive: true });
    const target = path.join(targetDir, `logo${path.extname(source).toLowerCase()}`);
    fs.copyFileSync(source, target);

    settings.update({ 'shop.logo_path': target }, { user });
    return { cancelled: false, path: target, dataUrl: fileToDataUrl(target) };
  }],

  // ------------------------------- Printing --------------------------------
  'print.receipt': ['pos.use', ({ saleId, silent, copies }, user) =>
    printing.printReceipt(saleId, { user, silent: silent === undefined ? null : silent, copies })],
  'print.previewReceipt': ['pos.use', ({ saleId }) => ({ html: printing.receiptPreview(saleId) })],
  'print.test': ['settings.manage', ({ printerName, paperWidth } = {}, user) =>
    printing.printTestReceipt({ user, printerName, paperWidth })],
  'print.listPrinters': ['authenticated', (payload, user, event) => printing.listPrinters(event.sender)],
  'print.document': ['authenticated', ({ html }) => printing.printDocument(html, { silent: false })],

  // -------------------------------- Backup ---------------------------------
  'backup.create': ['backup.manage', (payload, user) => backup.createBackup({ kind: 'manual', user })],
  'backup.history': ['backup.manage', () => backup.history()],
  'backup.validate': ['backup.manage', ({ path: filePath }) => backup.validateBackupFile(filePath)],
  'backup.delete': ['backup.manage', ({ id }, user) => backup.removeBackupFile(id, { user })],
  'backup.restore': ['backup.manage', async ({ path: filePath, confirmed }, user, event) => {
    if (!confirmed) throw new ValidationError('The restore was not confirmed.');
    const check = backup.validateBackupFile(filePath);
    if (!check.valid) throw new ValidationError(check.reason);

    const answer = await dialog.showMessageBox(BrowserWindow.fromWebContents(event.sender), {
      type: 'warning',
      buttons: ['Restore and replace', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Restore database',
      message: 'Replace all current data with this backup?',
      detail: `The backup holds ${check.stats.products} products, ${check.stats.sales} sales and ${check.stats.customers} customers.\n\n`
        + 'A safety copy of your current database will be taken first. Everything recorded since this backup will be lost.'
    });
    if (answer.response !== 0) return { restored: false, cancelled: true };

    const result = await backup.restoreBackup(filePath, { user });
    session.end();   // the restored database may hold different accounts
    return { ...result, cancelled: false };
  }],
  'backup.chooseDirectory': ['backup.manage', async (payload, user, event) => {
    const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
      title: 'Choose a folder for backups',
      properties: ['openDirectory', 'createDirectory']
    });
    if (result.canceled || result.filePaths.length === 0) return { cancelled: true };
    settings.update({ 'backup.directory': result.filePaths[0] }, { user });
    return { cancelled: false, path: result.filePaths[0] };
  }],
  'backup.chooseFile': ['backup.manage', async (payload, user, event) => {
    const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
      title: 'Choose a backup to restore',
      properties: ['openFile'],
      filters: [{ name: 'Database backup', extensions: ['db', 'sqlite', 'sqlite3'] }]
    });
    if (result.canceled || result.filePaths.length === 0) return { cancelled: true };
    const filePath = result.filePaths[0];
    return { cancelled: false, path: filePath, check: backup.validateBackupFile(filePath) };
  }],

  // ------------------------------- Activity --------------------------------
  'activity.list': ['activity.view', (payload) => activity.list(payload || {})],
  'activity.actions': ['activity.view', () => activity.distinctActions()],

  // -------------------------------- Files ----------------------------------
  'file.saveAs': ['authenticated', async ({ defaultName, content }, user, event) => {
    const result = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender), {
      title: 'Save file',
      defaultPath: path.join(app.getPath('documents'), defaultName || 'export.csv'),
      filters: [{ name: 'CSV file', extensions: ['csv'] }, { name: 'All files', extensions: ['*'] }]
    });
    if (result.canceled || !result.filePath) return { cancelled: true };
    fs.writeFileSync(result.filePath, content, 'utf8');
    return { cancelled: false, path: result.filePath };
  }],
  'file.openCsv': ['authenticated', async (payload, user, event) => {
    const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
      title: 'Choose a CSV file',
      properties: ['openFile'],
      filters: [{ name: 'CSV file', extensions: ['csv', 'txt'] }]
    });
    if (result.canceled || result.filePaths.length === 0) return { cancelled: true };
    const filePath = result.filePaths[0];
    const stat = fs.statSync(filePath);
    if (stat.size > 20 * 1024 * 1024) {
      throw new ValidationError('That file is larger than 20MB. Split it into smaller files first.');
    }
    return { cancelled: false, path: filePath, name: path.basename(filePath), content: fs.readFileSync(filePath, 'utf8') };
  }],

  // --------------------------------- App -----------------------------------
  'app.info': [null, () => ({
    name: 'iTtEk POS',
    version: app.getVersion(),
    shop: settings.get('shop.name', 'iTtEk POS'),
    logoDataUrl: fileToDataUrl(settings.get('shop.logo_path', '')),
    demoMode: settings.get('app.demo_mode', false),
    platform: process.platform,
    offline: true
  })],
  'app.confirm': ['authenticated', async ({ title, message, detail, confirmLabel }, user, event) => {
    const answer = await dialog.showMessageBox(BrowserWindow.fromWebContents(event.sender), {
      type: 'question',
      buttons: [confirmLabel || 'Yes', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: title || 'Please confirm',
      message: message || 'Are you sure?',
      detail: detail || ''
    });
    return { confirmed: answer.response === 0 };
  }]
};

/** Read a local image into a data: URL so the renderer never touches the disk. */
function fileToDataUrl(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return '';
    const ext = path.extname(filePath).toLowerCase().replace('.', '') || 'png';
    const mime = ext === 'jpg' ? 'jpeg' : ext;
    return `data:image/${mime};base64,${fs.readFileSync(filePath).toString('base64')}`;
  } catch {
    return '';
  }
}

function registerIpcHandlers() {
  const missing = CHANNELS.filter((channel) => !handlers[channel]);
  if (missing.length) {
    throw new Error(`No IPC handler registered for: ${missing.join(', ')}`);
  }
  const extra = Object.keys(handlers).filter((channel) => !CHANNELS.includes(channel));
  if (extra.length) {
    throw new Error(`IPC handler registered for an unlisted channel: ${extra.join(', ')}`);
  }

  for (const [channel, [permission, handler]] of Object.entries(handlers)) {
    ipcMain.handle(channel, async (event, payload) => {
      try {
        let user = null;
        if (permission === 'authenticated') user = session.requireUser();
        else if (permission) user = session.requirePermission(permission);
        else session.touch();

        const data = await handler(payload || {}, user, event);
        return { ok: true, data };
      } catch (error) {
        const friendly = toUserFacingError(error);
        logger.error(`IPC ${channel} failed`, friendly.cause || error);
        return {
          ok: false,
          error: { message: friendly.message, code: friendly.code, details: friendly.details || null }
        };
      }
    });
  }

  logger.info(`Registered ${CHANNELS.length} IPC channels`);
}

module.exports = { registerIpcHandlers, handlers, fileToDataUrl };
