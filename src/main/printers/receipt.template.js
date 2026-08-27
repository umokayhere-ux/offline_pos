'use strict';

const Money = require('../../shared/money');
const { Qty } = Money;
const datetime = require('../../shared/datetime');
const { PAYMENT_METHOD_LABELS } = require('../../shared/constants');

/**
 * Receipt rendering. Pure string building — no Electron, no database — so it can
 * be unit tested and reused for A4, 80mm and 58mm without duplicating layout
 * logic in the POS.
 *
 * Widths are set in millimetres via @page so the printer driver (thermal or
 * laser) receives the correct paper size.
 */

const WIDTHS = {
  '58mm': { page: '58mm', body: '54mm', font: '10px', title: '13px', columns: { qty: 34, price: 46 } },
  '80mm': { page: '80mm', body: '72mm', font: '12px', title: '16px', columns: { qty: 42, price: 56 } },
  A4: { page: '210mm', body: '190mm', font: '13px', title: '22px', columns: { qty: 60, price: 90 } }
};

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * @param {object} data
 * @param {object} data.sale        the sales row
 * @param {Array}  data.items       sale_items rows
 * @param {object} data.shop        shop profile from settings
 * @param {object} data.receipt     receipt settings
 * @param {Array}  [data.payments]
 */
function renderReceiptHtml(data) {
  const { sale, items, shop, receipt } = data;
  const width = WIDTHS[receipt.paperWidth] || WIDTHS['80mm'];
  const zone = shop.timezone || 'Africa/Accra';
  const isNarrow = receipt.paperWidth !== 'A4';

  const rows = items.map((item) => {
    const qty = Qty.display(item.quantity_milli);
    const lineName = escapeHtml(item.product_name);
    if (isNarrow) {
      return `
        <tr class="item">
          <td colspan="3" class="name">${lineName}</td>
        </tr>
        <tr class="item">
          <td class="qty">${qty} ${escapeHtml(item.unit || '')} @ ${Money.format(item.unit_price_pesewas)}</td>
          <td class="disc">${item.discount_pesewas ? `-${Money.format(item.discount_pesewas)}` : ''}</td>
          <td class="amt">${Money.format(item.line_total_pesewas)}</td>
        </tr>`;
    }
    return `
      <tr class="item">
        <td class="name">${lineName}</td>
        <td class="qty">${qty} ${escapeHtml(item.unit || '')}</td>
        <td class="amt">${Money.format(item.unit_price_pesewas)}</td>
        <td class="amt">${item.discount_pesewas ? `-${Money.format(item.discount_pesewas)}` : '—'}</td>
        <td class="amt">${Money.format(item.line_total_pesewas)}</td>
      </tr>`;
  }).join('');

  const totalsRows = [
    ['Subtotal', Money.format(sale.subtotal_pesewas)],
    (sale.line_discount_pesewas + sale.sale_discount_pesewas) > 0
      ? ['Discount', `-${Money.format(sale.line_discount_pesewas + sale.sale_discount_pesewas)}`] : null,
    sale.charges_pesewas > 0 ? ['Charges', Money.format(sale.charges_pesewas)] : null
  ].filter(Boolean).map(([label, value]) => `<tr><td>${label}</td><td class="amt">${value}</td></tr>`).join('');

  const paymentRows = [
    ['Payment', PAYMENT_METHOD_LABELS[sale.payment_method] || sale.payment_method],
    sale.paid_pesewas > 0 ? ['Amount received', Money.format(sale.paid_pesewas + sale.change_pesewas)] : null,
    sale.change_pesewas > 0 ? ['Change', Money.format(sale.change_pesewas)] : null,
    sale.debt_pesewas > 0 ? ['Balance owed', Money.format(sale.debt_pesewas)] : null,
    (sale.debt_pesewas > 0 && data.customerBalancePesewas !== undefined && data.customerBalancePesewas !== null)
      ? ['Total account balance', Money.format(data.customerBalancePesewas)] : null
  ].filter(Boolean).map(([label, value]) => `<tr><td>${label}</td><td class="amt">${escapeHtml(value)}</td></tr>`).join('');

  const logo = receipt.showLogo && shop.logoPath
    ? `<img class="logo" src="${escapeHtml(shop.logoPath)}" alt="" />`
    : '';

  const headerLines = [
    shop.address, shop.phone, shop.email, shop.tin ? `TIN: ${shop.tin}` : ''
  ].filter(Boolean).map((line) => `<div class="shop-line">${escapeHtml(line)}</div>`).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(sale.invoice_no)}</title>
<style>
  @page { size: ${width.page} auto; margin: ${receipt.paperWidth === 'A4' ? '12mm' : '3mm'}; }
  * { box-sizing: border-box; }
  body {
    width: ${width.body};
    margin: 0 auto;
    font-family: "Segoe UI", Tahoma, Arial, sans-serif;
    font-size: ${width.font};
    color: #000;
    background: #fff;
    -webkit-print-color-adjust: exact;
  }
  .center { text-align: center; }
  .logo { max-width: 40mm; max-height: 20mm; margin-bottom: 4px; }
  .shop-name { font-size: ${width.title}; font-weight: 700; letter-spacing: .3px; }
  .shop-line, .motto { font-size: ${isNarrow ? '9px' : '12px'}; }
  .motto { font-style: italic; margin-top: 2px; }
  hr { border: none; border-top: 1px dashed #000; margin: 6px 0; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 1px 0; vertical-align: top; }
  .amt { text-align: right; white-space: nowrap; }
  .qty { font-size: ${isNarrow ? '9px' : '11px'}; }
  .disc { text-align: right; font-size: 9px; }
  .name { font-weight: 600; }
  .meta td { font-size: ${isNarrow ? '9px' : '12px'}; }
  .total-row td { font-size: ${isNarrow ? '13px' : '18px'}; font-weight: 700; padding-top: 4px; }
  .footer { margin-top: 8px; font-size: ${isNarrow ? '9px' : '11px'}; }
  thead td { font-weight: 700; border-bottom: 1px solid #000; }
</style>
</head>
<body>
  <div class="center">
    ${logo}
    <div class="shop-name">${escapeHtml(shop.name)}</div>
    ${headerLines}
    ${shop.motto ? `<div class="motto">${escapeHtml(shop.motto)}</div>` : ''}
    ${receipt.headerNote ? `<div class="shop-line">${escapeHtml(receipt.headerNote)}</div>` : ''}
  </div>
  <hr />
  <table class="meta">
    <tr><td>Invoice</td><td class="amt">${escapeHtml(sale.invoice_no)}</td></tr>
    <tr><td>Date</td><td class="amt">${escapeHtml(datetime.formatDateTime(sale.sold_at, zone))}</td></tr>
    ${receipt.showCashier && sale.cashier_name ? `<tr><td>Served by</td><td class="amt">${escapeHtml(sale.cashier_name)}</td></tr>` : ''}
    ${receipt.showCustomer && sale.customer_name ? `<tr><td>Customer</td><td class="amt">${escapeHtml(sale.customer_name)}</td></tr>` : ''}
  </table>
  <hr />
  <table>
    ${isNarrow ? '' : `<thead><tr><td>Item</td><td>Qty</td><td class="amt">Price</td><td class="amt">Disc.</td><td class="amt">Total</td></tr></thead>`}
    <tbody>${rows}</tbody>
  </table>
  <hr />
  <table>
    ${totalsRows}
    <tr class="total-row"><td>TOTAL</td><td class="amt">${Money.format(sale.total_pesewas)}</td></tr>
  </table>
  <hr />
  <table class="meta">${paymentRows}</table>
  <hr />
  <div class="center footer">
    ${receipt.footerMessage ? `<div>${escapeHtml(receipt.footerMessage)}</div>` : ''}
    <div>Goods sold are subject to the shop's return policy.</div>
    <div>Powered by iTtEk POS</div>
  </div>
</body>
</html>`;
}

/** A self-contained test receipt for the printer setup screen. */
function renderTestReceiptHtml({ shop, receipt }) {
  const now = new Date().toISOString();
  return renderReceiptHtml({
    shop,
    receipt,
    sale: {
      invoice_no: 'TEST-PRINT',
      sold_at: now,
      subtotal_pesewas: 3500,
      line_discount_pesewas: 0,
      sale_discount_pesewas: 350,
      charges_pesewas: 0,
      total_pesewas: 3150,
      paid_pesewas: 3150,
      change_pesewas: 850,
      debt_pesewas: 0,
      payment_method: 'cash',
      cashier_name: 'Test Cashier',
      customer_name: 'Walk-in Customer'
    },
    items: [
      { product_name: 'Test Item A', unit: 'Piece', quantity_milli: 2000, unit_price_pesewas: 1000, discount_pesewas: 0, line_total_pesewas: 1800 },
      { product_name: 'Test Item B (weighed)', unit: 'Kg', quantity_milli: 500, unit_price_pesewas: 3000, discount_pesewas: 0, line_total_pesewas: 1350 }
    ]
  });
}

module.exports = { renderReceiptHtml, renderTestReceiptHtml, escapeHtml, WIDTHS };
