'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createTestDb } = require('../helpers/testDb');

const products = require('../../src/main/services/product.service');
const sales = require('../../src/main/services/sale.service');
const settings = require('../../src/main/services/settings.service');
const printing = require('../../src/main/printers/print.service');

/**
 * The shop logo has to travel from Settings all the way onto the printed
 * receipt. It used to be written into the receipt as a Windows file path, which
 * a print window can never load — so the logo silently never appeared. These
 * tests follow the whole path.
 */

let ctx;
let user;
let saleId;
let logoPath;

// A minimal but genuinely valid 1x1 PNG.
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

test.beforeEach(() => {
  ctx = createTestDb();
  user = ctx.owner;

  const product = products.create({
    name: 'Rice 5kg', costPrice: '35.00', sellingPrice: '50.00', stock: '10'
  }, { user });
  saleId = sales.complete({
    items: [{ productId: product.id, quantity: '2' }],
    paymentMethod: 'cash', amountReceived: '100.00'
  }, { user }).sale.id;

  logoPath = path.join(ctx.dir, 'shop-logo.png');
  fs.writeFileSync(logoPath, PNG_BYTES);
});

test.afterEach(() => ctx.cleanup());

test('a logo set in Settings is inlined into the printed receipt', () => {
  settings.update({ 'shop.logo_path': logoPath }, { user, silent: true });
  settings.updateReceiptSettings({ ...settings.receiptSettings(), showLogo: true }, { user });

  const html = printing.receiptPreview(saleId);

  assert.match(html, /<img class="logo" src="data:image\/png;base64,iVBORw0KGgo/);
  assert.doesNotMatch(html, new RegExp(logoPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    'the raw file path must never reach the receipt — a print window cannot load it');
});

test('turning the logo off in Settings removes it from the receipt', () => {
  settings.update({ 'shop.logo_path': logoPath }, { user, silent: true });
  settings.updateReceiptSettings({ ...settings.receiptSettings(), showLogo: false }, { user });

  assert.doesNotMatch(printing.receiptPreview(saleId), /<img/);
});

test('a shop with no logo still prints a complete receipt', () => {
  settings.update({ 'shop.logo_path': '' }, { user, silent: true });
  settings.updateReceiptSettings({ ...settings.receiptSettings(), showLogo: true }, { user });

  const html = printing.receiptPreview(saleId);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /₵100\.00/, 'the sale total still prints');
});

test('a logo file that has been deleted does not break printing', () => {
  settings.update({ 'shop.logo_path': logoPath }, { user, silent: true });
  settings.updateReceiptSettings({ ...settings.receiptSettings(), showLogo: true }, { user });
  fs.rmSync(logoPath);

  const html = printing.receiptPreview(saleId);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /₵100\.00/);
});

test('the logo is sized for the configured paper width', () => {
  settings.update({ 'shop.logo_path': logoPath }, { user, silent: true });

  for (const [width, expected] of [['58mm', '32mm'], ['80mm', '44mm'], ['A4', '55mm']]) {
    settings.updateReceiptSettings(
      { ...settings.receiptSettings(), showLogo: true, paperWidth: width }, { user }
    );
    const html = printing.receiptPreview(saleId);
    assert.match(html, new RegExp(`max-width: ${expected}`), `logo width for ${width}`);
  }
});
