'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Money = require('../../src/shared/money');
const { Qty, MoneyError } = Money;

test('parses cedi input into integer pesewas', () => {
  assert.equal(Money.parse('10'), 1000);
  assert.equal(Money.parse('10.5'), 1050);
  assert.equal(Money.parse('10.50'), 1050);
  assert.equal(Money.parse('0.01'), 1);
  assert.equal(Money.parse('1,250.75'), 125075);
  assert.equal(Money.parse('₵25.50'), 2550);
  assert.equal(Money.parse(10.5), 1050);
});

test('parse rejects rubbish rather than silently producing zero', () => {
  for (const bad of ['', null, undefined, 'abc', '10.5.5', '1e3', '--5']) {
    assert.throws(() => Money.parse(bad), MoneyError, `expected ${String(bad)} to throw`);
  }
});

test('parse rounds sub-pesewa input half-up', () => {
  assert.equal(Money.parse('10.005'), 1001);
  assert.equal(Money.parse('10.004'), 1000);
});

test('formats with exactly two decimals and thousands separators', () => {
  assert.equal(Money.format(1000), '₵10.00');
  assert.equal(Money.format(550), '₵5.50');
  assert.equal(Money.format(125075), '₵1,250.75');
  assert.equal(Money.format(1000000), '₵10,000.00');
  assert.equal(Money.format(0), '₵0.00');
  assert.equal(Money.format(-1550), '-₵15.50');
  assert.equal(Money.format(1050, { withSymbol: false }), '10.50');
});

test('0.1 + 0.2 is exact in pesewas', () => {
  assert.equal(Money.add(Money.parse('0.1'), Money.parse('0.2')), Money.parse('0.3'));
  assert.equal(Money.format(Money.add(10, 20)), '₵0.30');
});

test('multiplyByQty handles fractional quantities exactly', () => {
  assert.equal(Money.multiplyByQty(1000, Qty.parse('2')), 2000);
  assert.equal(Money.multiplyByQty(1000, Qty.parse('0.5')), 500);
  assert.equal(Money.multiplyByQty(1000, Qty.parse('0.25')), 250);
  assert.equal(Money.multiplyByQty(333, Qty.parse('3')), 999);
  // ₵1.99 x 0.333kg = ₵0.66267 -> ₵0.66
  assert.equal(Money.multiplyByQty(199, Qty.parse('0.333')), 66);
  // half-up at the boundary: ₵0.05 x 1.5 = 7.5p -> 8p
  assert.equal(Money.multiplyByQty(5, Qty.parse('1.5')), 8);
});

test('percentOf is exact and half-up', () => {
  assert.equal(Money.percentOf(10000, 10), 1000);
  assert.equal(Money.percentOf(10000, '7.5'), 750);
  assert.equal(Money.percentOf(333, 50), 167); // 166.5 -> 167
  assert.equal(Money.percentOf(10000, 0), 0);
  assert.throws(() => Money.percentOf(1000, 101), MoneyError);
  assert.throws(() => Money.percentOf(1000, -1), MoneyError);
});

test('quantity parsing supports up to three decimals only', () => {
  assert.equal(Qty.parse('1'), 1000);
  assert.equal(Qty.parse('0.5'), 500);
  assert.equal(Qty.parse('2.75'), 2750);
  assert.equal(Qty.parse('0.001'), 1);
  assert.throws(() => Qty.parse('0.0001'), MoneyError);
  assert.throws(() => Qty.parse('abc'), MoneyError);
  assert.throws(() => Qty.parsePositive('0'), MoneyError);
});

test('quantity formatting honours configured precision', () => {
  assert.equal(Qty.format(500, 3), '0.500');
  assert.equal(Qty.format(500, 2), '0.50');
  assert.equal(Qty.format(2000, 0), '2');
  assert.equal(Qty.display(2500), '2.5');
  assert.equal(Qty.display(3000), '3');
});

test('divideByQty derives a unit cost from a lot cost', () => {
  // ₵100.00 for 8 units -> ₵12.50 each
  assert.equal(Money.divideByQty(10000, Qty.parse('8')), 1250);
  // ₵100.00 for 0.5kg -> ₵200.00 per kg
  assert.equal(Money.divideByQty(10000, Qty.parse('0.5')), 20000);
  assert.throws(() => Money.divideByQty(1000, 0), MoneyError);
});

test('rejects non-integer pesewa values reaching the arithmetic helpers', () => {
  assert.throws(() => Money.add(10.5, 1), MoneyError);
  assert.throws(() => Money.format(10.5), MoneyError);
  assert.throws(() => Money.multiplyByQty(1000, 1.5), MoneyError);
});

test('very large amounts stay exact', () => {
  const tenMillionCedis = Money.parse('10000000.00');
  assert.equal(tenMillionCedis, 1000000000);
  assert.equal(Money.format(tenMillionCedis), '₵10,000,000.00');
  assert.equal(Money.multiplyByQty(tenMillionCedis, Qty.parse('3')), 3000000000);
});
