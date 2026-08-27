'use strict';

const { TIMEZONE } = require('./constants');

/**
 * Date/time handling.
 *
 * Rule: timestamps are STORED as ISO-8601 UTC strings and DISPLAYED in the
 * shop's timezone (Africa/Accra by default). Day boundaries for reports are
 * computed from the shop timezone, never by slicing a UTC string, so the figures
 * stay correct if the shop is ever configured for another zone.
 */

function nowIso() {
  return new Date().toISOString();
}

/** Offset in minutes of `tz` from UTC at the given instant. */
function zoneOffsetMinutes(date, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  const parts = Object.fromEntries(dtf.formatToParts(date).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour) % 24, Number(parts.minute), Number(parts.second)
  );
  return (asUtc - date.getTime()) / 60000;
}

/** "2026-08-27" for the given instant in the shop timezone. */
function localDayKey(input = new Date(), tz = TIMEZONE) {
  const date = input instanceof Date ? input : new Date(input);
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit'
  });
  return dtf.format(date);
}

/**
 * UTC instant boundaries [startIso, endIso) covering local days from
 * `fromDay` to `toDay` inclusive. Both arguments are "YYYY-MM-DD".
 */
function dayRangeToUtc(fromDay, toDay = fromDay, tz = TIMEZONE) {
  const start = localMidnightUtc(fromDay, tz);
  const endDay = addDays(toDay, 1);
  const end = localMidnightUtc(endDay, tz);
  return { start: start.toISOString(), end: end.toISOString(), fromDay, toDay };
}

function localMidnightUtc(day, tz) {
  const [y, m, d] = day.split('-').map(Number);
  const guess = new Date(Date.UTC(y, m - 1, d, 0, 0, 0));
  const offset = zoneOffsetMinutes(guess, tz);
  return new Date(guess.getTime() - offset * 60000);
}

function addDays(day, count) {
  const [y, m, d] = day.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + count);
  return dt.toISOString().slice(0, 10);
}

/** Named ranges used by the dashboard and reports. */
function presetRange(preset, tz = TIMEZONE, today = localDayKey(new Date(), tz)) {
  switch (preset) {
    case 'today':
      return dayRangeToUtc(today, today, tz);
    case 'yesterday': {
      const y = addDays(today, -1);
      return dayRangeToUtc(y, y, tz);
    }
    case 'week':   // rolling 7 days including today
      return dayRangeToUtc(addDays(today, -6), today, tz);
    case 'month':  // rolling 30 days including today
      return dayRangeToUtc(addDays(today, -29), today, tz);
    case 'this_month': {
      const first = `${today.slice(0, 7)}-01`;
      return dayRangeToUtc(first, today, tz);
    }
    case 'year':
      return dayRangeToUtc(`${today.slice(0, 4)}-01-01`, today, tz);
    case 'all':
      return dayRangeToUtc('1970-01-01', today, tz);
    default:
      throw new Error(`Unknown date range preset: ${preset}`);
  }
}

/** Human display, e.g. "27 Aug 2026, 10:30" in the shop timezone. */
function formatDateTime(iso, tz = TIMEZONE) {
  if (!iso) return '';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).format(new Date(iso)).replace(',', ',');
}

function formatDate(iso, tz = TIMEZONE) {
  if (!iso) return '';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, day: '2-digit', month: 'short', year: 'numeric'
  }).format(new Date(iso));
}

/** Compact stamp for backup filenames: 2026-08-27_1030 */
function fileStamp(date = new Date(), tz = TIMEZONE) {
  const dtf = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
  });
  const p = Object.fromEntries(dtf.formatToParts(date).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}_${String(Number(p.hour) % 24).padStart(2, '0')}${p.minute}`;
}

/** Enumerate the local day keys in a range, for chart buckets. */
function eachDay(fromDay, toDay) {
  const days = [];
  let cursor = fromDay;
  let guard = 0;
  while (cursor <= toDay && guard < 4000) {
    days.push(cursor);
    cursor = addDays(cursor, 1);
    guard += 1;
  }
  return days;
}

module.exports = {
  TIMEZONE,
  nowIso,
  localDayKey,
  dayRangeToUtc,
  presetRange,
  addDays,
  eachDay,
  formatDate,
  formatDateTime,
  fileStamp,
  zoneOffsetMinutes
};
