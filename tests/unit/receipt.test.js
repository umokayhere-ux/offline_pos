'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { renderReceiptHtml, renderTestReceiptHtml } = require('../../src/main/printers/receipt.template');

const shop = {
  name: 'Adom Provisions', address: 'Kaneshie Market, Accra', phone: '0244 000 000',
  email: '', tin: '', motto: 'Quality you can trust', timezone: 'Africa/Accra', logoPath: ''
};
const receipt = {
  paperWidth: '80mm', showLogo: false, showCashier: true, showCustomer: true,
  headerNote: '', footerMessage: 'Thank you for shopping with us!'
};
const sale = {
  invoice_no: 'INV-20260827-0001', sold_at: '2026-08-27T10:30:00.000Z',
  subtotal_pesewas: 12100, line_discount_pesewas: 0, sale_discount_pesewas: 1100,
  charges_pesewas: 0, total_pesewas: 11000, paid_pesewas: 11000, change_pesewas: 4000,
  debt_pesewas: 0, payment_method: 'cash', cashier_name: 'Ama', customer_name: 'Kofi'
};
const items = [
  { product_name: 'Rice 5kg', unit: 'Box', quantity_milli: 2000, unit_price_pesewas: 5000, discount_pesewas: 0, line_total_pesewas: 9091 },
  { product_name: 'Sugar', unit: 'Kg', quantity_milli: 500, unit_price_pesewas: 4200, discount_pesewas: 0, line_total_pesewas: 1909 }
];

test('a receipt shows cedi amounts and no other currency', () => {
  const html = renderReceiptHtml({ sale, items, shop, receipt });
  assert.match(html, /₵110\.00/);
  assert.match(html, /₵40\.00/);           // change
  assert.doesNotMatch(html, /[$€£]/);
  assert.doesNotMatch(html, /USD|GBP|EUR/);
});

test('a receipt carries the shop identity, invoice, cashier and customer', () => {
  const html = renderReceiptHtml({ sale, items, shop, receipt });
  assert.match(html, /Adom Provisions/);
  assert.match(html, /Kaneshie Market, Accra/);
  assert.match(html, /INV-20260827-0001/);
  assert.match(html, /Ama/);
  assert.match(html, /Kofi/);
  assert.match(html, /Thank you for shopping with us!/);
  assert.match(html, /27 Aug 2026/);
});

test('the cashier and customer lines can be switched off in settings', () => {
  const html = renderReceiptHtml({ sale, items, shop, receipt: { ...receipt, showCashier: false, showCustomer: false } });
  assert.doesNotMatch(html, /Served by/);
  assert.doesNotMatch(html, /Customer<\/td>/);
});

test('the paper width drives the @page size', () => {
  assert.match(renderReceiptHtml({ sale, items, shop, receipt: { ...receipt, paperWidth: '58mm' } }), /size: 58mm auto/);
  assert.match(renderReceiptHtml({ sale, items, shop, receipt: { ...receipt, paperWidth: '80mm' } }), /size: 80mm auto/);
  assert.match(renderReceiptHtml({ sale, items, shop, receipt: { ...receipt, paperWidth: 'A4' } }), /size: 210mm auto/);
});

test('a credit sale prints the balance still owed', () => {
  const html = renderReceiptHtml({
    sale: { ...sale, debt_pesewas: 30000, paid_pesewas: 20000, change_pesewas: 0, payment_method: 'credit' },
    items, shop, receipt, customerBalancePesewas: 45000
  });
  assert.match(html, /Balance owed/);
  assert.match(html, /₵300\.00/);
  assert.match(html, /₵450\.00/);
});

test('receipt content is HTML-escaped, so a product name cannot inject markup', () => {
  const html = renderReceiptHtml({
    sale, shop, receipt,
    items: [{ ...items[0], product_name: '<script>alert(1)</script>' }]
  });
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;/);
});

test('the test receipt renders without a database', () => {
  const html = renderTestReceiptHtml({ shop, receipt });
  assert.match(html, /TEST-PRINT/);
  assert.match(html, /₵31\.50/);
});
