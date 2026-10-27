import { isValidBand } from './banding.js';

// The 26 counties of the Republic of Ireland. Dublin is kept whole: people
// say "Dublin", not "Fingal" or "Dún Laoghaire–Rathdown", when asked.
export const COUNTIES = Object.freeze([
  'Carlow', 'Cavan', 'Clare', 'Cork', 'Donegal', 'Dublin', 'Galway', 'Kerry',
  'Kildare', 'Kilkenny', 'Laois', 'Leitrim', 'Limerick', 'Longford', 'Louth',
  'Mayo', 'Meath', 'Monaghan', 'Offaly', 'Roscommon', 'Sligo', 'Tipperary',
  'Waterford', 'Westmeath', 'Wexford', 'Wicklow',
]);

// Generous bounding box around the island of Ireland (incl. offshore islands).
export const IRELAND_BOUNDS = Object.freeze({
  minLat: 51.2, maxLat: 55.6, minLng: -10.9, maxLng: -5.3,
});

export const LIMITS = Object.freeze({
  street: 120,
  houseNumber: 40,
  town: 80,
  notes: 500,
  photoBytes: 5 * 1024 * 1024,
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Trim, strip control characters and collapse runs of spaces. */
export function cleanText(value, { multiline = false } = {}) {
  if (value === undefined || value === null) return '';
  let s = String(value).normalize('NFC');
  // eslint-disable-next-line no-control-regex
  s = multiline ? s.replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, '') : s.replace(/[\u0000-\u001F\u007F]/g, ' ');
  s = multiline
    ? s.split('\n').map((line) => line.replace(/[ \t]+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n')
    : s.replace(/\s+/g, ' ');
  return s.trim();
}

function toBool(v) {
  return v === true || v === 'true' || v === 'on' || v === 1 || v === '1';
}

function toNum(v) {
  if (v === '' || v === null || v === undefined) return NaN;
  return typeof v === 'number' ? v : Number(v);
}

/**
 * Normalise raw form input into the shape stored in the database.
 * Does not judge validity — see validateReport().
 */
export function normaliseReport(raw = {}) {
  const county = cleanText(raw.county);
  const matchedCounty = COUNTIES.find((c) => c.toLowerCase() === county.toLowerCase());
  return {
    client_id: cleanText(raw.client_id).toLowerCase(),
    street: cleanText(raw.street),
    house_number: cleanText(raw.house_number),
    town: cleanText(raw.town),
    county: matchedCounty || county,
    lat: toNum(raw.lat),
    lng: toNum(raw.lng),
    empty_band: cleanText(raw.empty_band) || 'unknown',
    upstairs_empty: toBool(raw.upstairs_empty),
    downstairs_empty: toBool(raw.downstairs_empty),
    notes: cleanText(raw.notes, { multiline: true }),
  };
}

/**
 * Validate a normalised report (plus optional photo Blob-like {size,type}).
 * Returns { valid, errors } where errors maps field name -> human message.
 */
export function validateReport(report, { photo, requirePhoto = true } = {}) {
  const errors = {};
  const r = report || {};

  if (!UUID_RE.test(r.client_id || '')) errors.client_id = 'Internal error: missing report ID.';

  if (!r.street) errors.street = 'Please enter the street name.';
  else if (r.street.length > LIMITS.street) errors.street = `Street name is too long (max ${LIMITS.street}).`;

  if (!r.house_number) errors.house_number = 'Please enter the house number or name.';
  else if (r.house_number.length > LIMITS.houseNumber) errors.house_number = `Too long (max ${LIMITS.houseNumber}).`;

  if (!r.town) errors.town = 'Please enter the town, village or area.';
  else if (r.town.length > LIMITS.town) errors.town = `Too long (max ${LIMITS.town}).`;

  if (!COUNTIES.includes(r.county)) errors.county = 'Please choose a county.';

  const latOk = Number.isFinite(r.lat) && r.lat >= IRELAND_BOUNDS.minLat && r.lat <= IRELAND_BOUNDS.maxLat;
  const lngOk = Number.isFinite(r.lng) && r.lng >= IRELAND_BOUNDS.minLng && r.lng <= IRELAND_BOUNDS.maxLng;
  if (!Number.isFinite(r.lat) || !Number.isFinite(r.lng)) {
    errors.location = 'Please set the location on the map.';
  } else if (!latOk || !lngOk) {
    errors.location = 'That pin is outside Ireland — please move it onto the building.';
  }

  if (!isValidBand(r.empty_band)) errors.empty_band = 'Please choose how long it has been empty.';

  if (!r.upstairs_empty && !r.downstairs_empty) {
    errors.units = 'Tick upstairs, downstairs, or both.';
  }

  if (r.notes && r.notes.length > LIMITS.notes) errors.notes = `Notes are too long (max ${LIMITS.notes} characters).`;

  if (requirePhoto) {
    if (!photo) errors.photo = 'Please take a photo of the building.';
    else if (photo.type !== 'image/jpeg') errors.photo = 'Photo must be processed to JPEG before sending.';
    else if (!(photo.size > 0) || photo.size > LIMITS.photoBytes) errors.photo = 'Photo is empty or too large.';
  }

  return { valid: Object.keys(errors).length === 0, errors };
}

/** Escape text for safe insertion into HTML (used for map popups and lists). */
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[ch]);
}

export function newClientId() {
  return globalThis.crypto.randomUUID();
}
