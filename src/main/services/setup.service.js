'use strict';

const { getDb } = require('../database/connection');
const settings = require('./settings.service');
const users = require('./user.service');
const activity = require('./activity.service');
const { ValidationError } = require('../../shared/errors');

/**
 * First-run setup.
 *
 * The application refuses to open the dashboard until a shop name and an owner
 * account exist, because every receipt, report and audit entry depends on them.
 */

function status() {
  const userCount = users.countUsers();
  const complete = settings.get('app.setup_complete', false) === true && userCount > 0;
  return {
    complete,
    hasUsers: userCount > 0,
    shop: settings.shopProfile(),
    receipt: settings.receiptSettings()
  };
}

/**
 * Apply the whole wizard in one transaction: shop details, the owner account,
 * receipt layout, printer and inventory preferences.
 */
function complete(input, { user = null } = {}) {
  const db = getDb();
  const existingUsers = users.countUsers();

  const shopName = String((input.shop && input.shop.name) || '').trim();
  if (shopName.length < 2) throw new ValidationError('Enter the name of your shop.');

  if (existingUsers === 0) {
    const owner = input.owner || {};
    if (!owner.username || !owner.password) {
      throw new ValidationError('Create the owner account with a username and a password.');
    }
    if (owner.password !== owner.confirmPassword) {
      throw new ValidationError('The two passwords do not match.');
    }
  }

  return db.transaction(() => {
    settings.update({
      'shop.name': shopName,
      'shop.address': (input.shop && input.shop.address) || '',
      'shop.phone': (input.shop && input.shop.phone) || '',
      'shop.email': (input.shop && input.shop.email) || '',
      'shop.logo_path': (input.shop && input.shop.logoPath) || '',
      'shop.tin': (input.shop && input.shop.tin) || '',
      'shop.motto': (input.shop && input.shop.motto) || ''
    }, { user, silent: true });

    if (input.inventory) {
      settings.update({
        'inventory.quantity_precision': input.inventory.quantityPrecision ?? 3,
        'inventory.low_stock_default_milli': input.inventory.lowStockDefaultMilli ?? 5000,
        'inventory.allow_negative_stock': !!input.inventory.allowNegativeStock
      }, { user, silent: true });
    }

    if (input.receipt) {
      settings.updateReceiptSettings({
        paperWidth: input.receipt.paperWidth || '80mm',
        showLogo: input.receipt.showLogo !== false,
        showCashier: input.receipt.showCashier !== false,
        showCustomer: input.receipt.showCustomer !== false,
        headerNote: input.receipt.headerNote || '',
        footerMessage: input.receipt.footerMessage || 'Thank you for shopping with us!',
        printerName: input.receipt.printerName || '',
        autoPrint: !!input.receipt.autoPrint
      }, { user });
    }

    let owner = null;
    if (existingUsers === 0) {
      owner = users.create({
        username: input.owner.username,
        fullName: input.owner.fullName || input.owner.username,
        password: input.owner.password,
        phone: input.owner.phone || '',
        email: input.owner.email || '',
        role: 'owner'
      }, { user: null });
    }

    settings.update({ 'app.setup_complete': true }, { user: owner || user, silent: true });
    activity.log({ user: owner || user, action: 'app.setup_completed', details: { shop: shopName } });

    return { ...status(), owner };
  })();
}

module.exports = { status, complete };
