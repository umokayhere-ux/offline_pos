'use strict';

const { BrowserWindow } = require('electron');
const { renderReceiptHtml, renderTestReceiptHtml } = require('./receipt.template');
const { AppError } = require('../../shared/errors');
const settings = require('../services/settings.service');
const saleService = require('../services/sale.service');
const activity = require('../services/activity.service');
const { fileToDataUrl } = require('../utils/file');

/**
 * Printing abstraction.
 *
 * The POS never talks to a printer: it asks this service to print a document.
 * The document is rendered offscreen in an isolated window with no Node access
 * and handed to the operating system's printer driver, which is how a
 * Windows-installed thermal printer (58mm/80mm) or an ordinary A4 printer is
 * driven without any vendor-specific SDK.
 */

function offscreenWindow() {
  return new BrowserWindow({
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      javascript: false
    }
  });
}

async function printHtml(html, { silent = false, printerName = '', copies = 1 } = {}) {
  const win = offscreenWindow();
  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    // Give the layout engine a moment to lay the page out before printing.
    await new Promise((resolve) => setTimeout(resolve, 150));

    const options = {
      silent,
      printBackground: true,
      copies: Math.max(1, Math.min(10, Number(copies) || 1)),
      margins: { marginType: 'none' }
    };
    if (printerName) options.deviceName = printerName;

    const result = await new Promise((resolve) => {
      win.webContents.print(options, (success, failureReason) => resolve({ success, failureReason }));
    });

    if (!result.success) {
      // A user cancelling the print dialog is not an error.
      if (/cancel/i.test(result.failureReason || '')) return { printed: false, cancelled: true };
      throw new AppError(
        `The receipt could not be printed: ${result.failureReason || 'the printer did not respond'}.`,
        { code: 'PRINT_FAILED' }
      );
    }
    return { printed: true, cancelled: false };
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

/** The shop profile with its logo inlined, ready for a print window. */
function printableShop() {
  const shop = settings.shopProfile();
  return { ...shop, logoDataUrl: fileToDataUrl(shop.logoPath) };
}

async function printReceipt(saleId, { user = null, silent = null, copies = 1 } = {}) {
  const { sale, items } = saleService.getSale(saleId);
  const receipt = settings.receiptSettings();
  const shop = printableShop();

  const html = renderReceiptHtml({
    sale, items, shop, receipt,
    customerBalancePesewas: sale.customer_balance_pesewas
  });

  const result = await printHtml(html, {
    silent: silent === null ? receipt.autoPrint : silent,
    printerName: receipt.printerName,
    copies
  });

  if (result.printed) {
    activity.log({ user, action: 'receipt.printed', entityType: 'sale', entityId: saleId, details: { invoice: sale.invoice_no } });
  }
  return result;
}

/** HTML for the on-screen receipt preview in the POS. */
function receiptPreview(saleId) {
  const { sale, items } = saleService.getSale(saleId);
  return renderReceiptHtml({
    sale, items,
    shop: printableShop(),
    receipt: settings.receiptSettings(),
    customerBalancePesewas: sale.customer_balance_pesewas
  });
}

async function printTestReceipt({ user = null, printerName = null, paperWidth = null } = {}) {
  const receipt = settings.receiptSettings();
  const html = renderTestReceiptHtml({
    shop: printableShop(),
    receipt: { ...receipt, paperWidth: paperWidth || receipt.paperWidth }
  });
  const result = await printHtml(html, {
    silent: false,
    printerName: printerName === null ? receipt.printerName : printerName
  });
  activity.log({
    user, action: 'printer.test',
    details: { printerName: printerName || receipt.printerName, paperWidth: paperWidth || receipt.paperWidth }
  });
  return result;
}

/** Printers the operating system knows about, for the settings screen. */
async function listPrinters(webContents) {
  try {
    const printers = await webContents.getPrintersAsync();
    return printers.map((p) => ({
      name: p.name, displayName: p.displayName, description: p.description,
      status: p.status, isDefault: p.isDefault
    }));
  } catch {
    return [];
  }
}

/** Print an arbitrary document (a report, a sheet of barcode labels). */
async function printDocument(html, { silent = false, printerName = '' } = {}) {
  return printHtml(html, { silent, printerName });
}

module.exports = { printReceipt, printTestReceipt, printDocument, receiptPreview, listPrinters, printHtml, printableShop };
