// "How long has it been empty?" — neighbours rarely know the exact date a
// house went dark, so we record a band rather than a false-precision number.

export const EMPTY_BANDS = Object.freeze([
  { id: 'under_6m', label: 'Less than 6 months', minMonths: 0, maxMonths: 6 },
  { id: '6_12m', label: '6 to 12 months', minMonths: 6, maxMonths: 12 },
  { id: '1_2y', label: '1 to 2 years', minMonths: 12, maxMonths: 24 },
  { id: '2_5y', label: '2 to 5 years', minMonths: 24, maxMonths: 60 },
  { id: '5_10y', label: '5 to 10 years', minMonths: 60, maxMonths: 120 },
  { id: 'over_10y', label: 'More than 10 years', minMonths: 120, maxMonths: Infinity },
  { id: 'unknown', label: 'Not sure', minMonths: null, maxMonths: null },
]);

export const BAND_IDS = Object.freeze(EMPTY_BANDS.map((b) => b.id));

/**
 * Map a number of months to a band id. Lower bound inclusive, upper exclusive,
 * so exactly 12 months is "1 to 2 years". Anything non-numeric or negative is
 * "unknown".
 */
export function bandFromMonths(months) {
  if (typeof months !== 'number' || !Number.isFinite(months) || months < 0) {
    return 'unknown';
  }
  const band = EMPTY_BANDS.find(
    (b) => b.minMonths !== null && months >= b.minMonths && months < b.maxMonths,
  );
  return band ? band.id : 'unknown';
}

/** Whole months elapsed between two dates (calendar months, floor). */
export function monthsBetween(since, now = new Date()) {
  const a = since instanceof Date ? since : new Date(since);
  const b = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime()) || a > b) return NaN;
  let months = (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
  if (b.getDate() < a.getDate()) months -= 1;
  return months;
}

/** Band for an "empty since" date, e.g. when the last tenant was seen. */
export function bandFromDate(since, now = new Date()) {
  return bandFromMonths(monthsBetween(since, now));
}

export function isValidBand(id) {
  return BAND_IDS.includes(id);
}

export function bandLabel(id) {
  const band = EMPTY_BANDS.find((b) => b.id === id);
  return band ? band.label : 'Not sure';
}
