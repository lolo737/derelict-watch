import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normaliseReport, validateReport, cleanText, escapeHtml, COUNTIES, LIMITS } from '../public/lib/validation.js';

const ID = '3f2b8c1e-9a4d-4b7e-8c21-5d6e7f809a1b';
const photo = { type: 'image/jpeg', size: 120_000 };

function good(overrides = {}) {
  return normaliseReport({
    client_id: ID,
    street: 'Strand Street',
    house_number: '14',
    town: 'Skerries',
    county: 'Dublin',
    lat: '53.5826',
    lng: '-6.1083',
    empty_band: '2_5y',
    upstairs_empty: 'on',
    downstairs_empty: null,
    notes: '  Boarded up.\n\n\n\nSlates missing.  ',
    ...overrides,
  });
}

test('a complete report is valid', () => {
  const { valid, errors } = validateReport(good(), { photo });
  assert.deepEqual(errors, {});
  assert.equal(valid, true);
});

test('normaliseReport coerces types and tidies text', () => {
  const r = good({ street: '  Strand\tStreet  ', county: 'dublin' });
  assert.equal(r.street, 'Strand Street');
  assert.equal(r.county, 'Dublin', 'county matched case-insensitively');
  assert.equal(r.lat, 53.5826);
  assert.equal(r.upstairs_empty, true);
  assert.equal(r.downstairs_empty, false);
  assert.equal(r.notes, 'Boarded up.\n\nSlates missing.');
  assert.equal(r.empty_band, '2_5y');
});

test('missing band defaults to unknown, which is allowed', () => {
  const r = good({ empty_band: '' });
  assert.equal(r.empty_band, 'unknown');
  assert.equal(validateReport(r, { photo }).valid, true);
});

test('required fields are reported individually', () => {
  const { valid, errors } = validateReport(
    normaliseReport({ client_id: ID }), { photo: null },
  );
  assert.equal(valid, false);
  for (const f of ['street', 'house_number', 'town', 'county', 'location', 'units', 'photo']) {
    assert.ok(errors[f], `expected error for ${f}`);
  }
});

test('location must be inside Ireland', () => {
  assert.match(validateReport(good({ lat: 51.5072, lng: -0.1276 }), { photo }).errors.location, /outside Ireland/);
  assert.match(validateReport(good({ lat: '', lng: '' }), { photo }).errors.location, /set the location/);
  // Malin Head and Mizen Head are in
  assert.equal(validateReport(good({ lat: 55.38, lng: -7.37 }), { photo }).valid, true);
  assert.equal(validateReport(good({ lat: 51.45, lng: -9.82 }), { photo }).valid, true);
});

test('county must be one of the 26', () => {
  assert.equal(COUNTIES.length, 26);
  assert.ok(validateReport(good({ county: 'Atlantis' }), { photo }).errors.county);
});

test('at least one of upstairs/downstairs must be ticked', () => {
  const r = good({ upstairs_empty: false, downstairs_empty: false });
  assert.ok(validateReport(r, { photo }).errors.units);
  assert.equal(validateReport(good({ upstairs_empty: false, downstairs_empty: true }), { photo }).valid, true);
});

test('length limits', () => {
  assert.ok(validateReport(good({ street: 'x'.repeat(LIMITS.street + 1) }), { photo }).errors.street);
  assert.ok(validateReport(good({ notes: 'x'.repeat(LIMITS.notes + 1) }), { photo }).errors.notes);
});

test('invalid band and bad client id are rejected', () => {
  assert.ok(validateReport(good({ empty_band: 'forever' }), { photo }).errors.empty_band);
  assert.ok(validateReport(good({ client_id: 'abc' }), { photo }).errors.client_id);
});

test('photo must be a processed, non-empty JPEG under the size limit', () => {
  assert.ok(validateReport(good(), { photo: { type: 'image/png', size: 10 } }).errors.photo);
  assert.ok(validateReport(good(), { photo: { type: 'image/jpeg', size: 0 } }).errors.photo);
  assert.ok(validateReport(good(), { photo: { type: 'image/jpeg', size: LIMITS.photoBytes + 1 } }).errors.photo);
  assert.equal(validateReport(good(), { requirePhoto: false }).valid, true);
});

test('cleanText strips control characters', () => {
  assert.equal(cleanText('a\u0000b\u0007c'), 'a b c');
  assert.equal(cleanText(null), '');
});

test('escapeHtml neutralises markup', () => {
  assert.equal(escapeHtml('<img src=x onerror="alert(1)">&\''), '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&amp;&#39;');
});
