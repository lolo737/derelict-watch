import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SupabaseBackend, PermanentError, isConfigured, createBackend, LocalDemoBackend, photoPathFor } from '../public/lib/api.js';
import { missingShellFiles } from '../scripts/check-shell.js';
import { IDBFactory } from 'fake-indexeddb';

const ID = '3f2b8c1e-9a4d-4b7e-8c21-5d6e7f809a1b';
const entry = {
  client_id: ID,
  report: { client_id: ID, street: 'Main Street', county: 'Louth' },
  photo: { bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer, type: 'image/jpeg' },
};

function fakeFetch(responses) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, init });
    const [status, body = ''] = responses.shift();
    return new Response(status === 204 ? null : body, { status });
  };
  fn.calls = calls;
  return fn;
}

const cfg = { url: 'https://abc.supabase.co/', anonKey: 'anon-key-xxxxxxxxxxxxxxxxxxxx' };

test('isConfigured rejects the placeholder config', () => {
  assert.equal(isConfigured(undefined), false);
  assert.equal(isConfigured({ SUPABASE_URL: 'https://YOUR-PROJECT.supabase.co', SUPABASE_ANON_KEY: 'YOUR-ANON-KEY' }), false);
  assert.equal(isConfigured({ SUPABASE_URL: 'https://abc.supabase.co', SUPABASE_ANON_KEY: 'x'.repeat(40) }), true);
  assert.ok(createBackend(undefined, { indexedDB: new IDBFactory() }) instanceof LocalDemoBackend);
});

test('submit uploads the photo then inserts the row with headers', async () => {
  const fetch = fakeFetch([[200, '{}'], [201]]);
  await new SupabaseBackend({ ...cfg, fetch }).submit(entry);
  const [up, ins] = fetch.calls;
  assert.equal(up.url, `https://abc.supabase.co/storage/v1/object/report-photos/${ID}.jpg`);
  assert.equal(up.init.headers['Content-Type'], 'image/jpeg');
  assert.equal(up.init.headers.apikey, cfg.anonKey);
  assert.equal(ins.url, 'https://abc.supabase.co/rest/v1/reports');
  const body = JSON.parse(ins.init.body);
  assert.equal(body.photo_path, photoPathFor(ID));
  assert.equal(body.street, 'Main Street');
});

test('retry after partial success is idempotent (duplicate photo / duplicate row)', async () => {
  const fetch = fakeFetch([[400, '{"error":"Duplicate","message":"The resource already exists"}'], [409, 'duplicate key']]);
  await new SupabaseBackend({ ...cfg, fetch }).submit(entry);
  assert.equal(fetch.calls.length, 2);
});

test('4xx validation errors are permanent; 5xx and 429 are retryable', async () => {
  await assert.rejects(
    new SupabaseBackend({ ...cfg, fetch: fakeFetch([[200], [400, 'violates check constraint']]) }).submit(entry),
    (err) => err instanceof PermanentError,
  );
  await assert.rejects(
    new SupabaseBackend({ ...cfg, fetch: fakeFetch([[503, 'down']]) }).submit(entry),
    (err) => !(err instanceof PermanentError),
  );
  await assert.rejects(
    new SupabaseBackend({ ...cfg, fetch: fakeFetch([[429, 'slow down']]) }).submit(entry),
    (err) => !err.permanent,
  );
});

test('listReports adds public photo URLs', async () => {
  const fetch = fakeFetch([[200, JSON.stringify([{ id: 'r1', photo_path: `${ID}.jpg` }])]]);
  const rows = await new SupabaseBackend({ ...cfg, fetch }).listReports();
  assert.match(fetch.calls[0].url, /\/rest\/v1\/reports\?select=.*order=created_at\.desc/);
  assert.doesNotMatch(fetch.calls[0].url, /client_id|flag_count|moderation/, 'only public columns requested');
  assert.equal(rows[0].photo_url, `https://abc.supabase.co/storage/v1/object/public/report-photos/${ID}.jpg`);
});

test('JWT anon keys are sent as Bearer too; publishable keys only as apikey', () => {
  const jwt = new SupabaseBackend({ ...cfg, anonKey: 'eyJhbGciOi.eyJyb2xlIjoiYW5vbiJ9.sig', fetch: () => {} });
  assert.equal(jwt.headers().Authorization, 'Bearer eyJhbGciOi.eyJyb2xlIjoiYW5vbiJ9.sig');
  const pub = new SupabaseBackend({ ...cfg, anonKey: 'sb_publishable_abcdefghijklmnop', fetch: () => {} });
  assert.equal(pub.headers().apikey, 'sb_publishable_abcdefghijklmnop');
  assert.equal(pub.headers().Authorization, undefined);
});

test('flag calls the flag_report RPC', async () => {
  const fetch = fakeFetch([[204]]);
  await new SupabaseBackend({ ...cfg, fetch }).flag('r1');
  assert.equal(fetch.calls[0].url, 'https://abc.supabase.co/rest/v1/rpc/flag_report');
  assert.deepEqual(JSON.parse(fetch.calls[0].init.body), { report_id: 'r1' });
});

test('demo backend round-trips reports locally', async () => {
  const demo = new LocalDemoBackend({ indexedDB: new IDBFactory() });
  await demo.submit(entry);
  const rows = await demo.listReports();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, ID);
  assert.equal(rows[0].street, 'Main Street');
});

test('every app-shell file listed in the service worker exists', () => {
  assert.deepEqual(missingShellFiles(), []);
});
