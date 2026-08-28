'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { fileToDataUrl } = require('../../src/main/utils/file');

/**
 * The shop logo reaches the receipt and the UI as a data: URL. Neither a print
 * window nor the renderer (img-src 'self' data:) can load a path from disk.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ittek-file-'));
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

test('a real image becomes a data URL with the right media type', () => {
  const png = path.join(tmp, 'logo.png');
  fs.writeFileSync(png, PNG);
  assert.match(fileToDataUrl(png), /^data:image\/png;base64,iVBORw0KGgo/);

  const jpg = path.join(tmp, 'logo.jpg');
  fs.writeFileSync(jpg, PNG);
  assert.match(fileToDataUrl(jpg), /^data:image\/jpeg;base64,/);
});

test('a logo problem never stops a receipt printing', () => {
  assert.equal(fileToDataUrl(path.join(tmp, 'missing.png')), '');
  assert.equal(fileToDataUrl(''), '');
  assert.equal(fileToDataUrl(null), '');
  assert.equal(fileToDataUrl(tmp), '', 'a directory is not a logo');

  const empty = path.join(tmp, 'empty.png');
  fs.writeFileSync(empty, '');
  assert.equal(fileToDataUrl(empty), '');

  const exe = path.join(tmp, 'not-an-image.exe');
  fs.writeFileSync(exe, PNG);
  assert.equal(fileToDataUrl(exe), '', 'only known image types are inlined');
});

test('a value that is already a data URL passes straight through', () => {
  const url = 'data:image/png;base64,iVBORw0KGgo=';
  assert.equal(fileToDataUrl(url), url);
});

test('an oversized file is refused rather than bloating every receipt', () => {
  const big = path.join(tmp, 'huge.png');
  fs.writeFileSync(big, Buffer.alloc(3 * 1024 * 1024, 1));
  assert.equal(fileToDataUrl(big), '');
});
