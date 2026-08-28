'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Read a local image into a `data:` URL.
 *
 * Printing and the renderer both need this: a print window is loaded from a
 * `data:` document and the renderer runs under a Content-Security-Policy of
 * `img-src 'self' data:`, so neither can load `C:\Users\…\logo.png` by path.
 * Inlining the bytes is what actually gets the shop's logo onto the receipt.
 *
 * Returns '' for a missing, unreadable or oversized file — a logo problem must
 * never stop a receipt printing.
 */

const MAX_BYTES = 2 * 1024 * 1024;

const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml'
};

function fileToDataUrl(filePath) {
  try {
    if (!filePath) return '';
    if (String(filePath).startsWith('data:')) return filePath;   // already inlined
    if (!fs.existsSync(filePath)) return '';

    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_BYTES) return '';

    const mime = MIME_BY_EXT[path.extname(filePath).toLowerCase()];
    if (!mime) return '';

    return `data:${mime};base64,${fs.readFileSync(filePath).toString('base64')}`;
  } catch {
    return '';
  }
}

module.exports = { fileToDataUrl, MAX_BYTES };
