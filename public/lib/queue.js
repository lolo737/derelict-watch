// Offline report queue, persisted in IndexedDB.
//
// A report written in a dead zone (or a basement, or the back of a bus) is
// stored here with its photo Blob and sent when the connection returns.
// Each record carries a client_id (UUID) which is a UNIQUE column in the
// database, so a retry after a half-finished upload can never create a
// duplicate report.

export const DB_NAME = 'derelict-watch';
export const DB_VERSION = 1;
export const STORE = 'outbox';
export const MAX_ATTEMPTS = 8;

function promisify(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
  });
}

async function toStoredPhoto(photo) {
  if (!photo) return null;
  if (photo instanceof ArrayBuffer) return { bytes: photo.slice(0), type: 'image/jpeg' };
  if (ArrayBuffer.isView(photo)) {
    return { bytes: photo.buffer.slice(photo.byteOffset, photo.byteOffset + photo.byteLength), type: 'image/jpeg' };
  }
  if (typeof photo.arrayBuffer === 'function') {
    return { bytes: await photo.arrayBuffer(), type: photo.type || 'image/jpeg' };
  }
  throw new TypeError('Unsupported photo type');
}

/** Turn a stored photo back into a Blob for upload. */
export function photoBlob(entry) {
  if (!entry?.photo) return null;
  return new Blob([entry.photo.bytes], { type: entry.photo.type });
}

/** Exponential back-off: 5s, 10s, 20s ... capped at 30 minutes. */
export function backoffMs(attempts) {
  if (attempts <= 0) return 0;
  return Math.min(5000 * 2 ** (attempts - 1), 30 * 60 * 1000);
}

export class ReportQueue {
  /** @param {{ indexedDB?: IDBFactory, dbName?: string, now?: () => number }} opts */
  constructor({ indexedDB = globalThis.indexedDB, dbName = DB_NAME, now = () => Date.now() } = {}) {
    if (!indexedDB) throw new Error('IndexedDB is not available');
    this.idb = indexedDB;
    this.dbName = dbName;
    this.now = now;
    this._db = null;
    this._flushing = null;
  }

  async open() {
    if (this._db) return this._db;
    const req = this.idb.open(this.dbName, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'client_id' });
        store.createIndex('created_at', 'created_at');
      }
    };
    this._db = await promisify(req);
    return this._db;
  }

  close() {
    this._db?.close();
    this._db = null;
  }

  async _store(mode) {
    const db = await this.open();
    const tx = db.transaction(STORE, mode);
    return { tx, store: tx.objectStore(STORE) };
  }

  /**
   * Add a validated report (with client_id) and its photo to the queue.
   * The photo (Blob or bytes) is stored as { bytes: ArrayBuffer, type } because
   * ArrayBuffers clone reliably into IndexedDB everywhere, whereas Blob storage
   * has a history of bugs in some mobile browsers.
   */
  async enqueue(report, photo) {
    if (!report || !report.client_id) throw new Error('Report needs a client_id');
    const entry = {
      client_id: report.client_id,
      report,
      photo: await toStoredPhoto(photo),
      created_at: this.now(),
      attempts: 0,
      next_attempt_at: 0,
      last_error: null,
    };
    const { tx, store } = await this._store('readwrite');
    store.put(entry);
    await txDone(tx);
    return entry;
  }

  async get(clientId) {
    const { store } = await this._store('readonly');
    return (await promisify(store.get(clientId))) ?? null;
  }

  /** All queued entries, oldest first. */
  async list() {
    const { store } = await this._store('readonly');
    const all = await promisify(store.index('created_at').getAll());
    return all;
  }

  async count() {
    const { store } = await this._store('readonly');
    return promisify(store.count());
  }

  async remove(clientId) {
    const { tx, store } = await this._store('readwrite');
    store.delete(clientId);
    await txDone(tx);
  }

  async _markFailed(entry, error) {
    const attempts = entry.attempts + 1;
    const updated = {
      ...entry,
      attempts,
      last_error: String(error?.message || error),
      next_attempt_at: this.now() + backoffMs(attempts),
    };
    const { tx, store } = await this._store('readwrite');
    store.put(updated);
    await txDone(tx);
    return updated;
  }

  /**
   * Try to send every due entry with `send(entry)`.
   * - resolves => entry removed from queue
   * - throws an error with .permanent === true => entry removed, reported as rejected
   * - throws anything else => kept, attempts++, retried after back-off
   *   (entries that hit MAX_ATTEMPTS stay in the queue but are no longer retried
   *   automatically; the UI shows them so the person can retry or discard).
   * Concurrent calls share one in-flight flush.
   */
  flush(send, { force = false } = {}) {
    if (this._flushing) return this._flushing;
    this._flushing = this._flush(send, force).finally(() => { this._flushing = null; });
    return this._flushing;
  }

  async _flush(send, force) {
    const result = { sent: [], failed: [], rejected: [], skipped: [] };
    const entries = await this.list();
    for (const entry of entries) {
      const due = force || (entry.attempts < MAX_ATTEMPTS && entry.next_attempt_at <= this.now());
      if (!due) { result.skipped.push(entry.client_id); continue; }
      try {
        await send(entry);
        await this.remove(entry.client_id);
        result.sent.push(entry.client_id);
      } catch (err) {
        if (err && err.permanent) {
          await this.remove(entry.client_id);
          result.rejected.push({ client_id: entry.client_id, error: String(err.message || err) });
        } else {
          await this._markFailed(entry, err);
          result.failed.push({ client_id: entry.client_id, error: String(err?.message || err) });
        }
      }
    }
    return result;
  }
}
