'use strict';

const Decimal = require('decimal.js');
const { CURRENCY, QTY_SCALE, QTY_DECIMALS } = require('./constants');

/**
 * MoneyService — the single source of truth for monetary arithmetic.
 *
 * Representation rules:
 *   - Money is ALWAYS an integer number of pesewas (₵10.50 -> 1050).
 *   - Quantities are ALWAYS an integer number of milli-units (0.5 -> 500).
 *   - Never perform monetary arithmetic with JavaScript floats outside this
 *     module; every rounding decision is made here, once, explicitly.
 *
 * Rounding policy: ROUND_HALF_UP at every point where a value must become an
 * integer minor unit. Intermediate results stay in Decimal precision.
 */

// A generous precision for intermediate work; rounding is always explicit.
const D = Decimal.clone({ precision: 30, rounding: Decimal.ROUND_HALF_UP });

const MAX_PESEWAS = Number.MAX_SAFE_INTEGER;

class MoneyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MoneyError';
    this.code = 'MONEY_INVALID';
  }
}

function assertInt(value, label) {
  if (typeof value !== 'number' || !Number.isInteger(value) || !Number.isFinite(value)) {
    throw new MoneyError(`${label} must be an integer amount in pesewas, received: ${String(value)}`);
  }
  if (Math.abs(value) > MAX_PESEWAS) {
    throw new MoneyError(`${label} exceeds the maximum representable amount`);
  }
  return value;
}

/** Round a Decimal to an integer number of pesewas (half-up). */
function toPesewas(dec) {
  const rounded = new D(dec).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
  const n = rounded.toNumber();
  if (!Number.isSafeInteger(n)) throw new MoneyError('Amount exceeds the maximum representable amount');
  return n;
}

/**
 * Parse a user-entered cedi amount ("10.5", "1,250.75", 10.5) into pesewas.
 * Returns an integer. Throws MoneyError on invalid input.
 */
function parse(input) {
  if (input === null || input === undefined || input === '') {
    throw new MoneyError('Amount is required');
  }
  let text = String(input).trim().replace(/,/g, '').replace(new RegExp(CURRENCY.symbol, 'g'), '').trim();
  if (text === '') throw new MoneyError('Amount is required');
  if (!/^-?\d+(\.\d+)?$/.test(text)) {
    throw new MoneyError(`"${input}" is not a valid amount`);
  }
  const dec = new D(text).times(CURRENCY.minorPerMajor);
  return toPesewas(dec);
}

/** Parse an amount that must not be negative. */
function parsePositive(input, label = 'Amount') {
  const value = parse(input);
  if (value < 0) throw new MoneyError(`${label} cannot be negative`);
  return value;
}

/** Convert pesewas to a plain "10.50" string (never localised, never a symbol). */
function toCedisString(pesewas) {
  assertInt(pesewas, 'Amount');
  const neg = pesewas < 0;
  const abs = Math.abs(pesewas);
  const major = Math.floor(abs / CURRENCY.minorPerMajor);
  const minor = abs % CURRENCY.minorPerMajor;
  return `${neg ? '-' : ''}${major}.${String(minor).padStart(CURRENCY.decimals, '0')}`;
}

/** Convert pesewas to a Number of cedis. For display/export only — never for maths. */
function toCedisNumber(pesewas) {
  return Number(toCedisString(pesewas));
}

/** Format pesewas for display: ₵1,250.75 — always exactly 2 decimal places. */
function format(pesewas, { withSymbol = true } = {}) {
  const plain = toCedisString(pesewas);
  const neg = plain.startsWith('-');
  const [major, minor] = (neg ? plain.slice(1) : plain).split('.');
  const grouped = major.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}${withSymbol ? CURRENCY.symbol : ''}${grouped}.${minor}`;
}

function add(...amounts) {
  return amounts.reduce((acc, a) => acc + assertInt(a, 'Amount'), 0);
}

function subtract(a, b) {
  assertInt(a, 'Amount');
  assertInt(b, 'Amount');
  return a - b;
}

function sum(amounts) {
  return (amounts || []).reduce((acc, a) => acc + assertInt(a, 'Amount'), 0);
}

function negate(pesewas) {
  return -assertInt(pesewas, 'Amount');
}

/**
 * Multiply money by a quantity expressed in milli-units.
 * ₵10.00 (1000p) x 0.5 (500 milli) => 500p (₵5.00)
 */
function multiplyByQty(pesewas, qtyMilli) {
  assertInt(pesewas, 'Unit price');
  Qty.assert(qtyMilli, 'Quantity');
  return toPesewas(new D(pesewas).times(qtyMilli).dividedBy(QTY_SCALE));
}

/** Multiply money by a plain integer factor (no rounding possible). */
function multiplyByInt(pesewas, factor) {
  assertInt(pesewas, 'Amount');
  if (!Number.isInteger(factor)) throw new MoneyError('Factor must be an integer');
  return toPesewas(new D(pesewas).times(factor));
}

/**
 * percentage of an amount. `percent` may be "10", 10, "7.5".
 * ₵100.00 @ 10% => ₵10.00
 */
function percentOf(pesewas, percent) {
  assertInt(pesewas, 'Amount');
  const pct = parsePercent(percent);
  return toPesewas(new D(pesewas).times(pct).dividedBy(100));
}

function parsePercent(percent) {
  const text = String(percent === '' || percent === null || percent === undefined ? 0 : percent).trim();
  if (!/^-?\d+(\.\d+)?$/.test(text)) throw new MoneyError(`"${percent}" is not a valid percentage`);
  const dec = new D(text);
  if (dec.lessThan(0) || dec.greaterThan(100)) {
    throw new MoneyError('Percentage must be between 0 and 100');
  }
  return dec;
}

/** Unit cost of a lot: total cost divided across a quantity, rounded half-up. */
function divideByQty(pesewas, qtyMilli) {
  assertInt(pesewas, 'Amount');
  Qty.assert(qtyMilli, 'Quantity');
  if (qtyMilli === 0) throw new MoneyError('Cannot divide by a zero quantity');
  return toPesewas(new D(pesewas).times(QTY_SCALE).dividedBy(qtyMilli));
}

/** Quantity helpers — integers scaled by QTY_SCALE. */
const Qty = {
  SCALE: QTY_SCALE,

  assert(value, label = 'Quantity') {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      throw new MoneyError(`${label} must be an integer quantity in milli-units, received: ${String(value)}`);
    }
    return value;
  },

  /** Parse "0.5", 1.5, "2" into milli-units. */
  parse(input) {
    if (input === null || input === undefined || input === '') {
      throw new MoneyError('Quantity is required');
    }
    const text = String(input).trim().replace(/,/g, '');
    if (!/^-?\d+(\.\d+)?$/.test(text)) throw new MoneyError(`"${input}" is not a valid quantity`);
    const dec = new D(text).times(QTY_SCALE);
    if (!dec.isInteger()) {
      throw new MoneyError(`Quantity supports at most ${QTY_DECIMALS} decimal places`);
    }
    return dec.toNumber();
  },

  parsePositive(input, label = 'Quantity') {
    const q = Qty.parse(input);
    if (q <= 0) throw new MoneyError(`${label} must be greater than zero`);
    return q;
  },

  add(a, b) { return Qty.assert(a) + Qty.assert(b); },
  subtract(a, b) { return Qty.assert(a) - Qty.assert(b); },
  sum(list) { return (list || []).reduce((acc, q) => acc + Qty.assert(q), 0); },

  /** Format for display honouring the shop's configured precision (0..3). */
  format(qtyMilli, decimals = QTY_DECIMALS) {
    Qty.assert(qtyMilli);
    const d = Math.max(0, Math.min(QTY_DECIMALS, Number(decimals)));
    return new D(qtyMilli).dividedBy(QTY_SCALE).toFixed(d);
  },

  /** Compact display: trims trailing zeros (2.500 -> 2.5, 3.000 -> 3). */
  display(qtyMilli) {
    Qty.assert(qtyMilli);
    return new D(qtyMilli).dividedBy(QTY_SCALE).toString();
  },

  toNumber(qtyMilli) {
    Qty.assert(qtyMilli);
    return new D(qtyMilli).dividedBy(QTY_SCALE).toNumber();
  }
};

module.exports = {
  MoneyError,
  Decimal: D,
  parse,
  parsePositive,
  parsePercent,
  toPesewas,
  toCedisString,
  toCedisNumber,
  format,
  add,
  subtract,
  sum,
  negate,
  multiplyByQty,
  multiplyByInt,
  percentOf,
  divideByQty,
  assertInt,
  Qty
};
