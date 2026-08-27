'use strict';

const { escapeHtml } = require('../printers/receipt.template');
const Money = require('../../shared/money');
const settings = require('./settings.service');
const productService = require('./product.service');
const { ValidationError } = require('../../shared/errors');

/**
 * Barcode label rendering.
 *
 * Code 128-B is drawn as inline SVG bars computed here — no external library and
 * no CDN, so labels print with the network unplugged. Code 128 is chosen because
 * it encodes the full printable ASCII range, so it prints both codes generated
 * in-store and manufacturer codes.
 */

const CODE128_PATTERNS = [
  '11011001100', '11001101100', '11001100110', '10010011000', '10010001100', '10001001100',
  '10011001000', '10011000100', '10001100100', '11001001000', '11001000100', '11000100100',
  '10110011100', '10011011100', '10011001110', '10111001100', '10011101100', '10011100110',
  '11001110010', '11001011100', '11001001110', '11011100100', '11001110100', '11101101110',
  '11101001100', '11100101100', '11100100110', '11101100100', '11100110100', '11100110010',
  '11011011000', '11011000110', '11000110110', '10100011000', '10001011000', '10001000110',
  '10110001000', '10001101000', '10001100010', '11010001000', '11000101000', '11000100010',
  '10110111000', '10110001110', '10001101110', '10111011000', '10111000110', '10001110110',
  '11101110110', '11010001110', '11000101110', '11011101000', '11011100010', '11011101110',
  '11101011000', '11101000110', '11100010110', '11101101000', '11101100010', '11100011010',
  '11101111010', '11001000010', '11110001010', '10100110000', '10100001100', '10010110000',
  '10010000110', '10000101100', '10000100110', '10110010000', '10110000100', '10011010000',
  '10011000010', '10000110100', '10000110010', '11000010010', '11001010000', '11110111010',
  '11000010100', '10001111010', '10100111100', '10010111100', '10010011110', '10111100100',
  '10011110100', '10011110010', '11110100100', '11110010100', '11110010010', '11011011110',
  '11011110110', '11110110110', '10101111000', '10100011110', '10001011110', '10111101000',
  '10111100010', '11110101000', '11110100010', '10111011110', '10111101110', '11101011110',
  '11110101110', '11010000100', '11010010000', '11010011100', '11000111010'
];
const STOP_PATTERN = '1100011101011';
const START_B = 104;

const PRINTABLE_ASCII = /^[ -~]+$/; // space (32) through tilde (126)

/** Encode text as a Code 128-B bar pattern (a string of 1s and 0s). */
function encodeCode128B(text) {
  const value = String(text);
  if (!PRINTABLE_ASCII.test(value)) {
    throw new ValidationError('This barcode contains characters that cannot be printed as Code 128.');
  }
  const codes = [START_B];
  for (const char of value) codes.push(char.charCodeAt(0) - 32);

  let checksum = START_B;
  for (let i = 1; i < codes.length; i += 1) checksum += codes[i] * i;
  codes.push(checksum % 103);

  return codes.map((c) => CODE128_PATTERNS[c]).join('') + STOP_PATTERN;
}

function barcodeSvg(text, { height = 40, moduleWidth = 1.4, showText = true } = {}) {
  const bits = encodeCode128B(text);
  const width = bits.length * moduleWidth;
  const totalHeight = height + (showText ? 14 : 0);

  let x = 0;
  const bars = [];
  for (let i = 0; i < bits.length; i += 1) {
    if (bits[i] === '1') {
      let run = 1;
      while (bits[i + run] === '1') run += 1;
      bars.push(`<rect x="${x.toFixed(2)}" y="0" width="${(run * moduleWidth).toFixed(2)}" height="${height}" fill="#000"/>`);
      x += run * moduleWidth;
      i += run - 1;
    } else {
      x += moduleWidth;
    }
  }

  const label = showText
    ? `<text x="${(width / 2).toFixed(2)}" y="${height + 11}" font-family="monospace" font-size="10" text-anchor="middle" fill="#000">${escapeHtml(text)}</text>`
    : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width.toFixed(2)}" height="${totalHeight}" viewBox="0 0 ${width.toFixed(2)} ${totalHeight}">${bars.join('')}${label}</svg>`;
}

/** A printable A4 sheet of shelf/price labels. */
function labelSheetHtml(entries) {
  const shop = settings.shopProfile();
  const labels = [];

  for (const entry of entries || []) {
    const product = productService.get(entry.productId);
    if (!product.barcode) {
      throw new ValidationError(`"${product.name}" has no barcode yet. Generate or enter one first.`);
    }
    const copies = Math.max(1, Math.min(200, Number(entry.copies) || 1));
    for (let i = 0; i < copies; i += 1) {
      labels.push(`
        <div class="label">
          <div class="shop">${escapeHtml(shop.name)}</div>
          <div class="name">${escapeHtml(product.name)}</div>
          <div class="code">${barcodeSvg(product.barcode, { height: 34, moduleWidth: 1.1 })}</div>
          <div class="price">${Money.format(product.selling_price_pesewas)}</div>
        </div>`);
    }
  }

  if (labels.length === 0) throw new ValidationError('Select at least one product to print labels for.');

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8" /><title>Barcode labels</title>
<style>
  @page { size: A4; margin: 8mm; }
  body { font-family: "Segoe UI", Arial, sans-serif; margin: 0; display: flex; flex-wrap: wrap; gap: 3mm; }
  .label {
    width: 45mm; height: 30mm; border: 1px dashed #bbb; padding: 1.5mm;
    display: flex; flex-direction: column; align-items: center; justify-content: space-between;
    page-break-inside: avoid; overflow: hidden;
  }
  .shop { font-size: 6pt; color: #444; }
  .name { font-size: 7.5pt; font-weight: 600; text-align: center; line-height: 1.1; max-height: 7mm; overflow: hidden; }
  .price { font-size: 10pt; font-weight: 700; }
  svg { display: block; }
</style></head>
<body>${labels.join('')}</body></html>`;
}

module.exports = { encodeCode128B, barcodeSvg, labelSheetHtml };
