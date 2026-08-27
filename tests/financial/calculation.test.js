'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Money = require('../../src/shared/money');
const Calc = require('../../src/shared/calculation');
const { Qty, MoneyError } = Money;

const cedis = Money.parse;
const qty = Qty.parse;

// ---------------------------------------------------------------------------
// The acceptance tests specified for this project (section 45)
// ---------------------------------------------------------------------------

test('Spec 1: ₵10.00 x 2 = ₵20.00', () => {
  const { total } = Calc.lineTotals({ unitPricePesewas: cedis('10.00'), quantityMilli: qty('2') });
  assert.equal(Money.format(total), '₵20.00');
});

test('Spec 2: ₵10.00 x 0.5 = ₵5.00', () => {
  const { total } = Calc.lineTotals({ unitPricePesewas: cedis('10.00'), quantityMilli: qty('0.5') });
  assert.equal(Money.format(total), '₵5.00');
});

test('Spec 3: subtotal ₵100.00 less 10% = discount ₵10.00, total ₵90.00', () => {
  const totals = Calc.cartTotals(
    [{ unitPricePesewas: cedis('100.00'), quantityMilli: qty('1') }],
    { discount: { type: 'percent', value: 10 } }
  );
  assert.equal(Money.format(totals.subtotal), '₵100.00');
  assert.equal(Money.format(totals.saleDiscount), '₵10.00');
  assert.equal(Money.format(totals.total), '₵90.00');
});

test('Spec 4: sell 5 @ ₵20.00 costing ₵12.00 -> revenue ₵100, COGS ₵60, gross ₵40', () => {
  const line = Calc.lineTotals({
    unitPricePesewas: cedis('20.00'),
    quantityMilli: qty('5'),
    costPricePesewas: cedis('12.00')
  });
  assert.equal(Money.format(line.total), '₵100.00');
  assert.equal(Money.format(line.cost), '₵60.00');
  assert.equal(Money.format(Calc.grossProfit(line.total, line.cost)), '₵40.00');
});

test('Spec 5: gross ₵1,000.00 less expenses ₵250.00 = net ₵750.00', () => {
  assert.equal(Money.format(Calc.netProfit(cedis('1000.00'), cedis('250.00'))), '₵750.00');
});

test('Spec 6: debt ₵500.00 less payment ₵200.00 = ₵300.00 remaining', () => {
  const balance = Calc.customerDebtBalance({
    previousBalancePesewas: cedis('500.00'),
    paymentPesewas: cedis('200.00')
  });
  assert.equal(Money.format(balance), '₵300.00');
});

test('Spec 7: total ₵75.50, received ₵100.00 -> change ₵24.50', () => {
  const { change, settled } = Calc.changeDue(cedis('75.50'), cedis('100.00'));
  assert.equal(settled, true);
  assert.equal(Money.format(change), '₵24.50');
});

test('Spec 8: sale ₵100.00 with a ₵30.00 refund recognises ₵70.00', () => {
  assert.equal(Money.format(Calc.netSales(cedis('100.00'), cedis('30.00'))), '₵70.00');
});

// ---------------------------------------------------------------------------
// Line and cart edge cases
// ---------------------------------------------------------------------------

test('line discounts: fixed amount and percentage', () => {
  const fixed = Calc.lineTotals({
    unitPricePesewas: cedis('10.00'), quantityMilli: qty('3'),
    discount: { type: 'amount', value: cedis('5.00') }
  });
  assert.equal(Money.format(fixed.total), '₵25.00');

  const pct = Calc.lineTotals({
    unitPricePesewas: cedis('10.00'), quantityMilli: qty('3'),
    discount: { type: 'percent', value: '12.5' }
  });
  assert.equal(Money.format(pct.discount), '₵3.75');
  assert.equal(Money.format(pct.total), '₵26.25');
});

test('a discount can never exceed the amount it applies to', () => {
  const line = Calc.lineTotals({
    unitPricePesewas: cedis('10.00'), quantityMilli: qty('1'),
    discount: { type: 'amount', value: cedis('50.00') }
  });
  assert.equal(line.total, 0);
  assert.equal(Money.format(line.discount), '₵10.00');
});

test('invalid lines are rejected, not silently coerced', () => {
  assert.throws(() => Calc.lineTotals({ unitPricePesewas: -100, quantityMilli: qty('1') }), MoneyError);
  assert.throws(() => Calc.lineTotals({ unitPricePesewas: 100, quantityMilli: 0 }), MoneyError);
  assert.throws(() => Calc.lineTotals({ unitPricePesewas: 100, quantityMilli: -1000 }), MoneyError);
  assert.throws(() => Calc.lineTotals({
    unitPricePesewas: 100, quantityMilli: qty('1'), discount: { type: 'amount', value: -1 }
  }), MoneyError);
});

test('cart combines line discounts, a sale discount and charges', () => {
  const totals = Calc.cartTotals([
    { unitPricePesewas: cedis('12.50'), quantityMilli: qty('2'), costPricePesewas: cedis('8.00') },
    { unitPricePesewas: cedis('3.20'), quantityMilli: qty('0.75'), costPricePesewas: cedis('2.00'),
      discount: { type: 'amount', value: cedis('0.40') } }
  ], { discount: { type: 'percent', value: 5 }, chargesPesewas: cedis('2.00') });

  // 25.00 + 2.40 = 27.40 gross; line discount 0.40 -> subtotal 27.00
  assert.equal(Money.format(totals.grossSubtotal), '₵27.40');
  assert.equal(Money.format(totals.lineDiscount), '₵0.40');
  assert.equal(Money.format(totals.subtotal), '₵27.00');
  assert.equal(Money.format(totals.saleDiscount), '₵1.35');
  assert.equal(Money.format(totals.total), '₵27.65');
  // COGS: 16.00 + 1.50 = 17.50
  assert.equal(Money.format(totals.cost), '₵17.50');
  assert.equal(Money.format(totals.grossProfit), '₵8.15');
});

test('an empty cart totals to zero without throwing', () => {
  const totals = Calc.cartTotals([]);
  assert.equal(totals.total, 0);
  assert.equal(totals.subtotal, 0);
  assert.equal(totals.grossProfit, 0);
});

test('allocateDiscount distributes to the pesewa with no drift', () => {
  const shares = Calc.allocateDiscount([1000, 1000, 1000], 100);
  assert.equal(Money.sum(shares), 100);

  // An amount that cannot divide evenly must still reconcile exactly.
  const odd = Calc.allocateDiscount([333, 333, 334], 100);
  assert.equal(Money.sum(odd), 100);

  const single = Calc.allocateDiscount([5000], 1234);
  assert.deepEqual(single, [1234]);
  assert.deepEqual(Calc.allocateDiscount([100, 200], 0), [0, 0]);
});

test('allocated line discounts always reconcile to the sale total', () => {
  const lines = [
    { unitPricePesewas: cedis('19.99'), quantityMilli: qty('3') },
    { unitPricePesewas: cedis('4.55'), quantityMilli: qty('1') },
    { unitPricePesewas: cedis('7.77'), quantityMilli: qty('2.5') }
  ];
  const totals = Calc.cartTotals(lines, { discount: { type: 'percent', value: '7.5' } });
  const shares = Calc.allocateDiscount(totals.lines.map((l) => l.totals.total), totals.saleDiscount);
  const netLines = totals.lines.map((l, i) => l.totals.total - shares[i]);
  assert.equal(Money.sum(netLines), totals.total);
  assert.ok(netLines.every((n) => n >= 0));
});

// ---------------------------------------------------------------------------
// Payment
// ---------------------------------------------------------------------------

test('exact tender leaves no change and is settled', () => {
  const r = Calc.changeDue(cedis('35.00'), cedis('35.00'));
  assert.deepEqual(r, { change: 0, shortfall: 0, settled: true });
});

test('a shortfall is never reported as change', () => {
  const r = Calc.changeDue(cedis('35.00'), cedis('20.00'));
  assert.equal(r.change, 0);
  assert.equal(Money.format(r.shortfall), '₵15.00');
  assert.equal(r.settled, false);
});

test('cash sales cannot complete when underpaid', () => {
  const r = Calc.validatePayment({ totalPesewas: cedis('35.00'), amountReceivedPesewas: cedis('20.00') });
  assert.equal(r.valid, false);
  assert.match(r.reason, /less than the total/);
});

test('an underpayment is valid only as credit against a named customer', () => {
  const noCustomer = Calc.validatePayment({
    totalPesewas: cedis('500.00'), amountReceivedPesewas: cedis('200.00'), allowCredit: true
  });
  assert.equal(noCustomer.valid, false);

  const withCustomer = Calc.validatePayment({
    totalPesewas: cedis('500.00'), amountReceivedPesewas: cedis('200.00'),
    allowCredit: true, customerId: 7
  });
  assert.equal(withCustomer.valid, true);
  assert.equal(Money.format(withCustomer.debt), '₵300.00');
  assert.equal(withCustomer.change, 0);
});

test('₵50.00 tendered against ₵35.00 gives ₵15.00 change', () => {
  const r = Calc.validatePayment({ totalPesewas: cedis('35.00'), amountReceivedPesewas: cedis('50.00') });
  assert.equal(Money.format(r.change), '₵15.00');
});

// ---------------------------------------------------------------------------
// Refunds
// ---------------------------------------------------------------------------

test('a full-line refund returns the exact line total', () => {
  const r = Calc.refundLine({
    lineTotalPesewas: cedis('26.25'), lineQuantityMilli: qty('3'),
    refundQuantityMilli: qty('3'), costPricePesewas: cedis('5.00')
  });
  assert.equal(Money.format(r.amount), '₵26.25');
  assert.equal(Money.format(r.cost), '₵15.00');
});

test('a partial refund is proportional to the discounted line total', () => {
  // 3 units sold for ₵26.25 (after discount). Returning 1 refunds ₵8.75.
  const r = Calc.refundLine({
    lineTotalPesewas: cedis('26.25'), lineQuantityMilli: qty('3'),
    refundQuantityMilli: qty('1'), costPricePesewas: cedis('5.00')
  });
  assert.equal(Money.format(r.amount), '₵8.75');
  assert.equal(Money.format(r.cost), '₵5.00');
});

test('a fractional-quantity refund rounds half-up', () => {
  const r = Calc.refundLine({
    lineTotalPesewas: cedis('10.00'), lineQuantityMilli: qty('3'), refundQuantityMilli: qty('1')
  });
  assert.equal(Money.format(r.amount), '₵3.33'); // 3.3333 -> 3.33
});

test('refunds cannot exceed what was sold', () => {
  assert.throws(() => Calc.refundLine({
    lineTotalPesewas: 1000, lineQuantityMilli: qty('1'), refundQuantityMilli: qty('2')
  }), MoneyError);
  assert.throws(() => Calc.refundLine({
    lineTotalPesewas: 1000, lineQuantityMilli: qty('1'), refundQuantityMilli: 0
  }), MoneyError);
});

// ---------------------------------------------------------------------------
// Balances and period profit
// ---------------------------------------------------------------------------

test('customer debt accumulates and settles', () => {
  let balance = Calc.customerDebtBalance({ previousBalancePesewas: 0, creditSalePesewas: cedis('300.00') });
  assert.equal(Money.format(balance), '₵300.00');
  balance = Calc.customerDebtBalance({ previousBalancePesewas: balance, paymentPesewas: cedis('100.00') });
  assert.equal(Money.format(balance), '₵200.00');
  balance = Calc.customerDebtBalance({ previousBalancePesewas: balance, paymentPesewas: cedis('200.00') });
  assert.equal(balance, 0);
});

test('supplier balance rises with purchases and falls with payments', () => {
  const balance = Calc.supplierBalance({
    previousBalancePesewas: cedis('1000.00'),
    purchasesPesewas: cedis('2500.50'),
    paymentsPesewas: cedis('1500.00')
  });
  assert.equal(Money.format(balance), '₵2,000.50');
});

test('periodSummary reverses both revenue and COGS for refunds', () => {
  const s = Calc.periodSummary({
    grossSalesPesewas: cedis('1000.00'),
    cogsPesewas: cedis('600.00'),
    refundsPesewas: cedis('100.00'),
    refundedCogsPesewas: cedis('60.00'),
    expensesPesewas: cedis('250.00')
  });
  assert.equal(Money.format(s.revenue), '₵900.00');
  assert.equal(Money.format(s.cogs), '₵540.00');
  assert.equal(Money.format(s.grossProfit), '₵360.00');
  assert.equal(Money.format(s.netProfit), '₵110.00');
});

test('periodSummary reports a loss rather than clamping at zero', () => {
  const s = Calc.periodSummary({
    grossSalesPesewas: cedis('100.00'), cogsPesewas: cedis('80.00'), expensesPesewas: cedis('250.00')
  });
  assert.equal(Money.format(s.netProfit), '-₵230.00');
});

test('margin percentage', () => {
  assert.equal(Calc.marginPercent(cedis('100.00'), cedis('30.00')), '30.00');
  assert.equal(Calc.marginPercent(0, 0), '0.00');
  assert.equal(Calc.marginPercent(cedis('3.00'), cedis('1.00')), '33.33');
});

test('a long cart of awkward prices sums without drift', () => {
  const lines = Array.from({ length: 250 }, (_, i) => ({
    unitPricePesewas: 1 + (i % 97),
    quantityMilli: qty(String(1 + ((i % 4) * 0.25)))
  }));
  const totals = Calc.cartTotals(lines);
  const manual = Money.sum(totals.lines.map((l) => l.totals.total));
  assert.equal(totals.total, manual);
});
