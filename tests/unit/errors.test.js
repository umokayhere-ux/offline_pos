'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { toUserFacingError, ValidationError } = require('../../src/shared/errors');

function sqliteError(message) {
  const e = new Error(message);
  e.code = 'SQLITE_CONSTRAINT_UNIQUE';
  return e;
}

test('a duplicate barcode is explained in plain language', () => {
  const e = toUserFacingError(sqliteError('UNIQUE constraint failed: products.barcode'));
  assert.equal(e.message, 'This barcode is already assigned to another product.');
  assert.doesNotMatch(e.message, /SQLITE/);
});

test('unknown database failures never leak raw SQL to the user', () => {
  const e = toUserFacingError(new Error('no such column: xyz'));
  assert.equal(e.code, 'UNEXPECTED');
  assert.doesNotMatch(e.message, /no such column/);
  assert.ok(e.cause, 'technical detail is preserved for the log');
});

test('validation errors pass through untouched', () => {
  const original = new ValidationError('Quantity must be greater than zero');
  assert.equal(toUserFacingError(original), original);
});

test('money errors become validation errors', () => {
  const money = new Error('"abc" is not a valid amount');
  money.name = 'MoneyError';
  assert.equal(toUserFacingError(money).code, 'VALIDATION');
});

test('audit trail tampering is reported clearly', () => {
  const e = toUserFacingError(sqliteError('Activity logs cannot be deleted'));
  assert.match(e.message, /audit trail/);
});
