import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EMPTY_BANDS, BAND_IDS, bandFromMonths, bandFromDate, monthsBetween, isValidBand, bandLabel } from '../public/lib/banding.js';

test('band ids are unique and include unknown', () => {
  assert.equal(new Set(BAND_IDS).size, BAND_IDS.length);
  assert.ok(BAND_IDS.includes('unknown'));
});

test('numeric bands are contiguous with no gaps or overlaps', () => {
  const numeric = EMPTY_BANDS.filter((b) => b.minMonths !== null);
  assert.equal(numeric[0].minMonths, 0);
  for (let i = 1; i < numeric.length; i++) assert.equal(numeric[i].minMonths, numeric[i - 1].maxMonths);
  assert.equal(numeric.at(-1).maxMonths, Infinity);
});

test('bandFromMonths: boundaries are lower-inclusive, upper-exclusive', () => {
  const cases = [
    [0, 'under_6m'], [5.99, 'under_6m'], [6, '6_12m'], [11, '6_12m'],
    [12, '1_2y'], [23, '1_2y'], [24, '2_5y'], [59, '2_5y'],
    [60, '5_10y'], [119, '5_10y'], [120, 'over_10y'], [600, 'over_10y'],
  ];
  for (const [m, id] of cases) assert.equal(bandFromMonths(m), id, `${m} months`);
});

test('bandFromMonths: junk input is unknown', () => {
  for (const v of [-1, NaN, Infinity, '12', null, undefined, {}]) assert.equal(bandFromMonths(v), 'unknown');
});

test('monthsBetween counts whole calendar months', () => {
  assert.equal(monthsBetween('2024-01-15', '2024-07-15'), 6);
  assert.equal(monthsBetween('2024-01-15', '2024-07-14'), 5);
  assert.equal(monthsBetween('2016-10-27', '2026-10-27'), 120);
  assert.ok(Number.isNaN(monthsBetween('2027-01-01', '2026-01-01')), 'future start is NaN');
  assert.ok(Number.isNaN(monthsBetween('not a date', '2026-01-01')));
});

test('bandFromDate', () => {
  const now = new Date('2026-10-27T12:00:00Z');
  assert.equal(bandFromDate('2026-08-01', now), 'under_6m');
  assert.equal(bandFromDate('2025-10-27', now), '1_2y');
  assert.equal(bandFromDate('2019-03-01', now), '5_10y');
  assert.equal(bandFromDate('2008-05-01', now), 'over_10y');
  assert.equal(bandFromDate('2030-01-01', now), 'unknown');
});

test('isValidBand and bandLabel', () => {
  assert.ok(isValidBand('2_5y'));
  assert.ok(!isValidBand('forever'));
  assert.equal(bandLabel('over_10y'), 'More than 10 years');
  assert.equal(bandLabel('nonsense'), 'Not sure');
});
