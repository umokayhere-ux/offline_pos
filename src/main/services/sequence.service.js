'use strict';

const { getDb } = require('../database/connection');
const { localDayKey } = require('../../shared/datetime');

/**
 * Collision-free document numbers: INV-20260827-0001.
 *
 * The counter lives in `document_sequences` and is incremented with an UPSERT,
 * so two concurrent callers can never receive the same number. Callers must be
 * inside the enclosing write transaction: if the sale rolls back, the number is
 * released with it.
 */

const PREFIXES = {
  sale: 'INV',
  refund: 'REF',
  purchase: 'PUR',
  expense: 'EXP',
  debtPayment: 'DPY',
  supplierPayment: 'SPY'
};

function nextNumber(kind, { at = new Date() } = {}) {
  const prefix = PREFIXES[kind];
  if (!prefix) throw new Error(`Unknown document kind: ${kind}`);
  const day = localDayKey(at);
  const compactDay = day.replace(/-/g, '');
  const db = getDb();

  const row = db.prepare(`
    INSERT INTO document_sequences (prefix, day, last_number) VALUES (?, ?, 1)
    ON CONFLICT(prefix, day) DO UPDATE SET last_number = last_number + 1
    RETURNING last_number
  `).get(prefix, compactDay);

  return `${prefix}-${compactDay}-${String(row.last_number).padStart(4, '0')}`;
}

module.exports = { nextNumber, PREFIXES };
