import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { ReportQueue, MAX_ATTEMPTS, backoffMs, photoBlob } from '../public/lib/queue.js';
import { PermanentError } from '../public/lib/api.js';

let clock;
let queue;

function report(n) {
  return { client_id: `00000000-0000-4000-8000-00000000000${n}`, street: `Street ${n}` };
}

beforeEach(() => {
  clock = 1_000_000;
  // A brand-new fake IndexedDB per test keeps tests isolated.
  queue = new ReportQueue({ indexedDB: new IDBFactory(), now: () => clock });
});

test('enqueue persists report and photo bytes, listed oldest first', async () => {
  await queue.enqueue(report(1), new Blob([new Uint8Array([0xff, 0xd8, 1, 2])], { type: 'image/jpeg' }));
  clock += 10;
  await queue.enqueue(report(2), new Uint8Array([9, 9]));
  const items = await queue.list();
  assert.deepEqual(items.map((e) => e.report.street), ['Street 1', 'Street 2']);
  assert.equal(await queue.count(), 2);
  const blob = photoBlob(items[0]);
  assert.equal(blob.type, 'image/jpeg');
  assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())], [0xff, 0xd8, 1, 2]);
});

test('queue survives being closed and reopened (persistence)', async () => {
  const factory = new IDBFactory();
  const q1 = new ReportQueue({ indexedDB: factory });
  await q1.enqueue(report(1), null);
  q1.close();
  const q2 = new ReportQueue({ indexedDB: factory });
  assert.equal(await q2.count(), 1);
});

test('enqueue requires a client_id; same client_id is not duplicated', async () => {
  await assert.rejects(queue.enqueue({}, null), /client_id/);
  await queue.enqueue(report(1), null);
  await queue.enqueue(report(1), null);
  assert.equal(await queue.count(), 1);
});

test('successful sends are removed from the queue', async () => {
  await queue.enqueue(report(1), null);
  await queue.enqueue(report(2), null);
  const seen = [];
  const res = await queue.flush(async (e) => { seen.push(e.client_id); });
  assert.equal(res.sent.length, 2);
  assert.equal(seen.length, 2);
  assert.equal(await queue.count(), 0);
});

test('transient failures stay queued with back-off', async () => {
  await queue.enqueue(report(1), null);
  const res = await queue.flush(async () => { throw new Error('network down'); });
  assert.equal(res.failed.length, 1);
  const [entry] = await queue.list();
  assert.equal(entry.attempts, 1);
  assert.equal(entry.last_error, 'network down');
  assert.equal(entry.next_attempt_at, clock + backoffMs(1));

  // Not due yet: skipped without calling send.
  let calls = 0;
  const res2 = await queue.flush(async () => { calls++; });
  assert.equal(calls, 0);
  assert.equal(res2.skipped.length, 1);

  // After the back-off it is retried and sent.
  clock += backoffMs(1);
  const res3 = await queue.flush(async () => { calls++; });
  assert.equal(calls, 1);
  assert.equal(res3.sent.length, 1);
  assert.equal(await queue.count(), 0);
});

test('force flush ignores back-off', async () => {
  await queue.enqueue(report(1), null);
  await queue.flush(async () => { throw new Error('nope'); });
  const res = await queue.flush(async () => {}, { force: true });
  assert.equal(res.sent.length, 1);
});

test('permanent errors are dropped and reported as rejected', async () => {
  await queue.enqueue(report(1), null);
  const res = await queue.flush(async () => { throw new PermanentError('400 bad county'); });
  assert.equal(res.rejected.length, 1);
  assert.match(res.rejected[0].error, /bad county/);
  assert.equal(await queue.count(), 0);
});

test('one bad entry does not block the others', async () => {
  await queue.enqueue(report(1), null);
  clock += 1;
  await queue.enqueue(report(2), null);
  const res = await queue.flush(async (e) => { if (e.report.street === 'Street 1') throw new Error('flaky'); });
  assert.equal(res.failed.length, 1);
  assert.equal(res.sent.length, 1);
  assert.equal((await queue.list())[0].report.street, 'Street 1');
});

test('entries stop auto-retrying after MAX_ATTEMPTS but are kept', async () => {
  await queue.enqueue(report(1), null);
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    await queue.flush(async () => { throw new Error('still down'); }, { force: true });
  }
  clock += 10 ** 10;
  let calls = 0;
  const res = await queue.flush(async () => { calls++; });
  assert.equal(calls, 0);
  assert.equal(res.skipped.length, 1);
  assert.equal((await queue.get(report(1).client_id)).attempts, MAX_ATTEMPTS);
});

test('concurrent flushes share one run (no double send)', async () => {
  await queue.enqueue(report(1), null);
  let calls = 0;
  const send = async () => { calls++; await new Promise((r) => setTimeout(r, 5)); };
  const [a, b] = await Promise.all([queue.flush(send), queue.flush(send)]);
  assert.equal(calls, 1);
  assert.strictEqual(a, b);
});

test('backoffMs grows exponentially and is capped', () => {
  assert.equal(backoffMs(0), 0);
  assert.equal(backoffMs(1), 5000);
  assert.equal(backoffMs(2), 10000);
  assert.equal(backoffMs(3), 20000);
  assert.equal(backoffMs(50), 30 * 60 * 1000);
});
