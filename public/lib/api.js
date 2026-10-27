// Backends. Two interchangeable implementations with the same interface:
//
//   SupabaseBackend  – talks to Supabase's REST (PostgREST) and Storage APIs
//                      with plain fetch(); no SDK, no build step.
//   LocalDemoBackend – keeps reports in this browser's IndexedDB, so the app
//                      is fully usable (and demonstrable) before a Supabase
//                      project exists.
//
// interface Backend {
//   mode: 'supabase' | 'demo'
//   submit(entry)        // entry = queue entry { client_id, report, photo }
//   listReports()        // -> [{ id, street, ..., photo_url }]
//   flag(id)             // -> void
// }

import { photoBlob } from './queue.js';

export const PHOTO_BUCKET = 'report-photos';
export const PUBLIC_COLUMNS = [
  'id', 'created_at', 'street', 'house_number', 'town', 'county', 'lat', 'lng',
  'empty_band', 'upstairs_empty', 'downstairs_empty', 'notes', 'photo_path',
].join(',');

/** Error that should not be retried (the server rejected the data itself). */
export class PermanentError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PermanentError';
    this.permanent = true;
  }
}

export function photoPathFor(clientId) {
  return `${clientId}.jpg`;
}

export function isConfigured(config) {
  return Boolean(
    config &&
    typeof config.SUPABASE_URL === 'string' && /^https?:\/\//.test(config.SUPABASE_URL) &&
    typeof config.SUPABASE_ANON_KEY === 'string' && config.SUPABASE_ANON_KEY.length > 20 &&
    !config.SUPABASE_URL.includes('YOUR-PROJECT'),
  );
}

export class SupabaseBackend {
  constructor({ url, anonKey, fetch: fetchImpl = globalThis.fetch.bind(globalThis) }) {
    this.mode = 'supabase';
    this.url = url.replace(/\/+$/, '');
    this.anonKey = anonKey;
    this.fetch = fetchImpl;
  }

  headers(extra = {}) {
    // Legacy anon keys are JWTs and go in both headers. The newer
    // sb_publishable_... keys are not JWTs and belong in `apikey` only.
    const isJwt = this.anonKey.split('.').length === 3;
    return { apikey: this.anonKey, ...(isJwt ? { Authorization: `Bearer ${this.anonKey}` } : {}), ...extra };
  }

  publicPhotoUrl(path) {
    return `${this.url}/storage/v1/object/public/${PHOTO_BUCKET}/${encodeURIComponent(path)}`;
  }

  async _fail(res, what) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 300); } catch { /* ignore */ }
    const msg = `${what} failed (${res.status})${detail ? `: ${detail}` : ''}`;
    // 4xx other than 408/429 means the request itself is unacceptable: don't retry forever.
    if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
      throw new PermanentError(msg);
    }
    throw new Error(msg);
  }

  async submit(entry) {
    const path = photoPathFor(entry.client_id);
    const blob = photoBlob(entry);
    if (!blob) throw new PermanentError('Report has no photo');

    // 1. Photo. Object names are the client_id, so a retry after a partial
    //    success hits "already exists" — which we treat as done.
    const up = await this.fetch(`${this.url}/storage/v1/object/${PHOTO_BUCKET}/${path}`, {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'image/jpeg', 'x-upsert': 'false', 'cache-control': 'max-age=31536000' }),
      body: blob,
    });
    if (!up.ok) {
      const text = await up.clone().text().catch(() => '');
      const duplicate = up.status === 409 || /duplicate|already exists/i.test(text);
      if (!duplicate) await this._fail(up, 'Photo upload');
    }

    // 2. Row. client_id is UNIQUE, so a duplicate insert returns 409: also done.
    const res = await this.fetch(`${this.url}/rest/v1/reports`, {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
      body: JSON.stringify({ ...entry.report, photo_path: path }),
    });
    if (res.status === 409) return;
    if (!res.ok) await this._fail(res, 'Saving report');
  }

  async listReports({ limit = 1000 } = {}) {
    const q = `select=${PUBLIC_COLUMNS}&order=created_at.desc&limit=${limit}`;
    const res = await this.fetch(`${this.url}/rest/v1/reports?${q}`, { headers: this.headers() });
    if (!res.ok) await this._fail(res, 'Loading reports');
    const rows = await res.json();
    return rows.map((r) => ({ ...r, photo_url: r.photo_path ? this.publicPhotoUrl(r.photo_path) : null }));
  }

  async flag(id) {
    const res = await this.fetch(`${this.url}/rest/v1/rpc/flag_report`, {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ report_id: id }),
    });
    if (!res.ok) await this._fail(res, 'Flagging report');
  }
}

const DEMO_DB = 'derelict-watch-demo';

export class LocalDemoBackend {
  constructor({ indexedDB = globalThis.indexedDB } = {}) {
    this.mode = 'demo';
    this.idb = indexedDB;
    this._db = null;
    this._urls = new Map();
  }

  async _open() {
    if (this._db) return this._db;
    this._db = await new Promise((resolve, reject) => {
      const req = this.idb.open(DEMO_DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('reports', { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this._db;
  }

  async submit(entry) {
    const db = await this._open();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('reports', 'readwrite');
      tx.objectStore('reports').put({
        ...entry.report,
        id: entry.client_id,
        created_at: new Date().toISOString(),
        photo: entry.photo,
      });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }

  async listReports() {
    const db = await this._open();
    const rows = await new Promise((resolve, reject) => {
      const req = db.transaction('reports').objectStore('reports').getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return rows
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .map(({ photo, ...r }) => {
        let photo_url = null;
        if (photo && typeof URL !== 'undefined' && URL.createObjectURL) {
          if (!this._urls.has(r.id)) this._urls.set(r.id, URL.createObjectURL(new Blob([photo.bytes], { type: photo.type })));
          photo_url = this._urls.get(r.id);
        }
        return { ...r, photo_url };
      });
  }

  async flag() { /* nothing to moderate on your own device */ }
}

export function createBackend(config, deps = {}) {
  if (isConfigured(config)) {
    return new SupabaseBackend({ url: config.SUPABASE_URL, anonKey: config.SUPABASE_ANON_KEY, ...deps });
  }
  return new LocalDemoBackend(deps);
}
