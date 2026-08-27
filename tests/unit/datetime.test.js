'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const dt = require('../../src/shared/datetime');

test('Africa/Accra day keys derive from the instant, not string slicing', () => {
  assert.equal(dt.localDayKey('2026-08-27T10:30:00.000Z'), '2026-08-27');
  assert.equal(dt.localDayKey('2026-08-27T23:59:59.000Z'), '2026-08-27');
});

test('a day range covers exactly 24 hours and is half-open', () => {
  const r = dt.dayRangeToUtc('2026-08-27');
  assert.equal(r.start, '2026-08-27T00:00:00.000Z');
  assert.equal(r.end, '2026-08-28T00:00:00.000Z');
});

test('day ranges are correct in a zone with an offset', () => {
  const r = dt.dayRangeToUtc('2026-08-27', '2026-08-27', 'Africa/Lagos'); // UTC+1
  assert.equal(r.start, '2026-08-26T23:00:00.000Z');
  assert.equal(r.end, '2026-08-27T23:00:00.000Z');
});

test('presets span the expected number of days', () => {
  const week = dt.presetRange('week', dt.TIMEZONE, '2026-08-27');
  assert.equal(week.fromDay, '2026-08-21');
  assert.equal(week.toDay, '2026-08-27');
  assert.equal(dt.eachDay(week.fromDay, week.toDay).length, 7);

  const month = dt.presetRange('this_month', dt.TIMEZONE, '2026-08-27');
  assert.equal(month.fromDay, '2026-08-01');
});

test('date arithmetic crosses month and year boundaries', () => {
  assert.equal(dt.addDays('2026-08-31', 1), '2026-09-01');
  assert.equal(dt.addDays('2026-01-01', -1), '2025-12-31');
  assert.equal(dt.addDays('2024-02-28', 1), '2024-02-29');
});

test('backup file stamps are filesystem safe', () => {
  const stamp = dt.fileStamp(new Date('2026-08-27T10:30:00.000Z'));
  assert.equal(stamp, '2026-08-27_1030');
  assert.match(`shop_backup_${stamp}.db`, /^shop_backup_\d{4}-\d{2}-\d{2}_\d{4}\.db$/);
});
