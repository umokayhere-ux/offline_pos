'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { encodeCode128B, barcodeSvg } = require('../../src/main/services/barcode.service');

test('Code 128-B encodes with start, checksum and stop patterns', () => {
  const bits = encodeCode128B('A');
  // start + 1 data + checksum = 3 x 11 modules, plus the 13-module stop pattern
  assert.equal(bits.length, 3 * 11 + 13);
  assert.ok(bits.startsWith('11010010000'), 'starts with START-B');
  assert.ok(bits.endsWith('1100011101011'), 'ends with the stop pattern');
  assert.match(bits, /^[01]+$/);
});

test('encoding is deterministic and length-proportional', () => {
  assert.equal(encodeCode128B('6001234567890'), encodeCode128B('6001234567890'));
  assert.equal(encodeCode128B('6001234567890').length, (2 + 13) * 11 + 13);
});

test('unprintable characters are rejected rather than encoded wrongly', () => {
  const withControlChar = `bad${String.fromCharCode(1)}code`;
  assert.throws(() => encodeCode128B(withControlChar), /cannot be printed/);
});

test('the SVG is self-contained, with no external references', () => {
  const svg = barcodeSvg('6001234567890');
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, /<rect /);
  assert.match(svg, />6001234567890</);
  assert.equal((svg.match(/https?:\/\//g) || []).length, 1, 'only the SVG namespace URI');
});
