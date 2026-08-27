'use strict';

const Money = require('./money');
const { Qty, MoneyError } = Money;

/**
 * CalculationService — every business calculation in the application.
 *
 * Nothing here touches the database or the DOM; it is pure, deterministic and
 * exhaustively covered by tests/financial. UI and services call into this
 * module rather than doing arithmetic of their own.
 *
 * Discount shape used throughout:
 *   { type: 'none' }
 *   { type: 'amount', value: <pesewas integer> }
 *   { type: 'percent', value: <'10' | 10 | '7.5'> }
 */

const NO_DISCOUNT = Object.freeze({ type: 'none', value: 0 });

function normaliseDiscount(discount) {
  if (!discount || !discount.type || discount.type === 'none') return NO_DISCOUNT;
  if (discount.type === 'amount') {
    return { type: 'amount', value: Money.assertInt(discount.value, 'Discount') };
  }
  if (discount.type === 'percent') {
    Money.parsePercent(discount.value);
    return { type: 'percent', value: discount.value };
  }
  throw new MoneyError(`Unknown discount type: ${discount.type}`);
}

/**
 * Resolve a discount against a base amount, clamped so a discount can never
 * exceed the amount it applies to (which would create a negative line/total).
 */
function resolveDiscount(basePesewas, discount) {
  Money.assertInt(basePesewas, 'Amount');
  const d = normaliseDiscount(discount);
  if (d.type === 'none') return 0;
  const raw = d.type === 'percent' ? Money.percentOf(basePesewas, d.value) : d.value;
  if (raw < 0) throw new MoneyError('Discount cannot be negative');
  return Math.min(raw, basePesewas);
}

/**
 * A single cart/sale line.
 * @param {object} line
 * @param {number} line.unitPricePesewas
 * @param {number} line.quantityMilli
 * @param {object} [line.discount]
 * @param {number} [line.costPricePesewas] cost at the time of sale
 */
function lineTotals(line) {
  const unitPrice = Money.assertInt(line.unitPricePesewas, 'Unit price');
  if (unitPrice < 0) throw new MoneyError('Unit price cannot be negative');
  const quantity = Qty.assert(line.quantityMilli, 'Quantity');
  if (quantity <= 0) throw new MoneyError('Quantity must be greater than zero');

  const gross = Money.multiplyByQty(unitPrice, quantity);
  const discount = resolveDiscount(gross, line.discount);
  const total = gross - discount;
  const cost = line.costPricePesewas === undefined || line.costPricePesewas === null
    ? 0
    : Money.multiplyByQty(Money.assertInt(line.costPricePesewas, 'Cost price'), quantity);

  return { gross, discount, total, cost, profit: total - cost };
}

/**
 * Totals for a whole cart.
 * @param {Array} lines
 * @param {object} [options]
 * @param {object} [options.discount] sale-level discount applied to the subtotal
 * @param {number} [options.chargesPesewas] delivery/service charges added after discount
 */
function cartTotals(lines, options = {}) {
  const computed = (lines || []).map((line) => ({ ...line, totals: lineTotals(line) }));
  const grossSubtotal = Money.sum(computed.map((l) => l.totals.gross));
  const lineDiscount = Money.sum(computed.map((l) => l.totals.discount));
  const subtotal = grossSubtotal - lineDiscount;

  const saleDiscount = resolveDiscount(subtotal, options.discount);
  const charges = options.chargesPesewas ? Money.assertInt(options.chargesPesewas, 'Charges') : 0;
  if (charges < 0) throw new MoneyError('Charges cannot be negative');

  const total = subtotal - saleDiscount + charges;
  const cost = Money.sum(computed.map((l) => l.totals.cost));

  return {
    lines: computed,
    grossSubtotal,
    lineDiscount,
    subtotal,
    saleDiscount,
    totalDiscount: lineDiscount + saleDiscount,
    charges,
    total,
    cost,
    grossProfit: total - charges - cost,
    itemCount: computed.length,
    totalQuantityMilli: Qty.sum(computed.map((l) => l.quantityMilli))
  };
}

/**
 * Allocate a sale-level discount back onto individual lines, proportionally to
 * each line's contribution. Used so that stored sale_items reconcile exactly to
 * the sale total (the remainder is given to the largest line).
 */
function allocateDiscount(lineTotalsList, discountPesewas) {
  const totals = lineTotalsList.map((t) => Money.assertInt(t, 'Line total'));
  const discount = Money.assertInt(discountPesewas, 'Discount');
  if (discount === 0) return totals.map(() => 0);
  const base = Money.sum(totals);
  if (base <= 0) return totals.map(() => 0);

  const shares = totals.map((t) => Money.toPesewas(new Money.Decimal(t).times(discount).dividedBy(base)));
  let allocated = Money.sum(shares);
  let drift = discount - allocated;

  // Hand any rounding drift to the largest line, one pesewa at a time.
  const order = totals.map((t, i) => i).sort((a, b) => totals[b] - totals[a]);
  let cursor = 0;
  while (drift !== 0 && order.length > 0) {
    const idx = order[cursor % order.length];
    const step = drift > 0 ? 1 : -1;
    const next = shares[idx] + step;
    if (next >= 0 && next <= totals[idx]) {
      shares[idx] = next;
      drift -= step;
    }
    cursor += 1;
    if (cursor > order.length * 200) break; // safety
  }
  return shares;
}

/** change = amount received - total. Never negative: a shortfall is not change. */
function changeDue(totalPesewas, amountReceivedPesewas) {
  const total = Money.assertInt(totalPesewas, 'Total');
  const received = Money.assertInt(amountReceivedPesewas, 'Amount received');
  const diff = received - total;
  return { change: diff > 0 ? diff : 0, shortfall: diff < 0 ? -diff : 0, settled: diff >= 0 };
}

/**
 * Validate a tendered payment against the sale total.
 * A shortfall is only acceptable when the remainder is recorded as customer debt.
 */
function validatePayment({ totalPesewas, amountReceivedPesewas, allowCredit = false, customerId = null }) {
  const { change, shortfall, settled } = changeDue(totalPesewas, amountReceivedPesewas);
  if (!settled && !allowCredit) {
    return { valid: false, change: 0, shortfall, reason: 'Amount received is less than the total due.' };
  }
  if (!settled && allowCredit && !customerId) {
    return { valid: false, change: 0, shortfall, reason: 'A customer is required to record the balance as debt.' };
  }
  return { valid: true, change, shortfall, debt: shortfall };
}

/** revenue - cost of goods sold */
function grossProfit(revenuePesewas, cogsPesewas) {
  return Money.subtract(revenuePesewas, cogsPesewas);
}

/** gross profit - expenses */
function netProfit(grossProfitPesewas, expensesPesewas) {
  return Money.subtract(grossProfitPesewas, expensesPesewas);
}

/** previous balance + new credit sale - payment */
function customerDebtBalance({ previousBalancePesewas = 0, creditSalePesewas = 0, paymentPesewas = 0 }) {
  return Money.assertInt(previousBalancePesewas, 'Balance')
    + Money.assertInt(creditSalePesewas, 'Credit sale')
    - Money.assertInt(paymentPesewas, 'Payment');
}

/** previous supplier balance + purchases - payments */
function supplierBalance({ previousBalancePesewas = 0, purchasesPesewas = 0, paymentsPesewas = 0 }) {
  return Money.assertInt(previousBalancePesewas, 'Balance')
    + Money.assertInt(purchasesPesewas, 'Purchases')
    - Money.assertInt(paymentsPesewas, 'Payments');
}

/**
 * Refund of specific sale lines. Refunds never delete the sale; they produce a
 * reversal whose amounts are derived from the original line's effective unit
 * price (i.e. after the discount that line actually received).
 */
function refundLine({ lineTotalPesewas, lineQuantityMilli, refundQuantityMilli, costPricePesewas = 0 }) {
  const lineTotal = Money.assertInt(lineTotalPesewas, 'Line total');
  const lineQty = Qty.assert(lineQuantityMilli, 'Quantity');
  const refundQty = Qty.assert(refundQuantityMilli, 'Refund quantity');
  if (refundQty <= 0) throw new MoneyError('Refund quantity must be greater than zero');
  if (refundQty > lineQty) throw new MoneyError('Refund quantity exceeds the quantity sold');

  const amount = refundQty === lineQty
    ? lineTotal
    : Money.toPesewas(new Money.Decimal(lineTotal).times(refundQty).dividedBy(lineQty));
  const cost = Money.multiplyByQty(Money.assertInt(costPricePesewas, 'Cost price'), refundQty);
  return { amount, cost, quantityMilli: refundQty };
}

/** Net recognised revenue after refunds. */
function netSales(grossSalesPesewas, refundsPesewas) {
  return Money.subtract(grossSalesPesewas, refundsPesewas);
}

/**
 * Full period summary — the single source of truth shared by the dashboard and
 * every report so the two can never disagree.
 */
function periodSummary({
  grossSalesPesewas = 0,
  cogsPesewas = 0,
  refundsPesewas = 0,
  refundedCogsPesewas = 0,
  expensesPesewas = 0
}) {
  const revenue = netSales(grossSalesPesewas, refundsPesewas);
  const cogs = Money.subtract(cogsPesewas, refundedCogsPesewas);
  const gross = grossProfit(revenue, cogs);
  return {
    grossSales: grossSalesPesewas,
    refunds: refundsPesewas,
    revenue,
    cogs,
    grossProfit: gross,
    expenses: expensesPesewas,
    netProfit: netProfit(gross, expensesPesewas)
  };
}

/** Margin as a percentage string with 2 decimals ("30.00"). Zero revenue -> "0.00". */
function marginPercent(revenuePesewas, profitPesewas) {
  const revenue = Money.assertInt(revenuePesewas, 'Revenue');
  if (revenue === 0) return '0.00';
  return new Money.Decimal(profitPesewas).times(100).dividedBy(revenue).toFixed(2);
}

module.exports = {
  NO_DISCOUNT,
  normaliseDiscount,
  resolveDiscount,
  lineTotals,
  cartTotals,
  allocateDiscount,
  changeDue,
  validatePayment,
  grossProfit,
  netProfit,
  customerDebtBalance,
  supplierBalance,
  refundLine,
  netSales,
  periodSummary,
  marginPercent
};
