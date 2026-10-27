import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { computeTargetSize, stripJpegMetadata, listJpegSegments, hasJpegMetadata, pixelateRegion, MAX_EDGE } from '../public/lib/image.js';

// Fixture: a real 64x48 JPEG written by Pillow with an EXIF block containing
// camera make/model and GPS coordinates, plus a COM (comment) segment.
const withGps = new Uint8Array(readFileSync(new URL('./fixtures/with-gps.jpg', import.meta.url)));
const ascii = (bytes) => Buffer.from(bytes).toString('latin1');

test('computeTargetSize caps the longest edge and keeps aspect ratio', () => {
  assert.deepEqual(computeTargetSize(4032, 3024), { width: MAX_EDGE, height: 1200 });
  assert.deepEqual(computeTargetSize(3024, 4032), { width: 1200, height: MAX_EDGE });
  assert.deepEqual(computeTargetSize(800, 600), { width: 800, height: 600 }, 'never upscales');
  assert.deepEqual(computeTargetSize(10000, 10, 1000), { width: 1000, height: 1 }, 'never zero');
  assert.throws(() => computeTargetSize(0, 100), RangeError);
});

test('fixture really does contain GPS EXIF and a comment', () => {
  const text = ascii(withGps);
  assert.ok(text.includes('Exif\0\0'));
  assert.ok(text.includes('SecretPhone 9'));
  assert.ok(text.includes('20 Example Road'));
  assert.ok(hasJpegMetadata(withGps));
});

test('stripJpegMetadata removes EXIF (incl. GPS) and comments', () => {
  const clean = stripJpegMetadata(withGps);
  const text = ascii(clean);
  assert.ok(!text.includes('Exif'), 'no EXIF header');
  assert.ok(!text.includes('SecretPhone'), 'no camera model');
  assert.ok(!text.includes('Example Road'), 'no comment');
  assert.equal(hasJpegMetadata(clean), false);
  assert.ok(clean.length < withGps.length);
});

test('stripped JPEG is still structurally valid and image data is untouched', () => {
  const clean = stripJpegMetadata(withGps);
  assert.equal(clean[0], 0xff); assert.equal(clean[1], 0xd8);
  assert.equal(clean.at(-2), 0xff); assert.equal(clean.at(-1), 0xd9);
  const markers = listJpegSegments(clean).map((s) => s.marker);
  for (const required of [0xdb, 0xc0, 0xc4, 0xda]) assert.ok(markers.includes(required), `marker ${required.toString(16)}`);
  // Everything from Start-Of-Scan onwards is byte-identical.
  const sosOrig = listJpegSegments(withGps).find((s) => s.marker === 0xda).offset;
  const sosClean = listJpegSegments(clean).find((s) => s.marker === 0xda).offset;
  assert.deepEqual(clean.subarray(sosClean), withGps.subarray(sosOrig));
});

test('stripping is idempotent', () => {
  const once = stripJpegMetadata(withGps);
  assert.deepEqual(stripJpegMetadata(once), once);
});

test('JFIF APP0 header is preserved', () => {
  // Hand-built minimal segment sequence: SOI, APP0 JFIF, APP1 junk, SOS, data, EOI
  const jfif = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const app1 = [0xff, 0xe1, 0x00, 0x06, 0x45, 0x78, 0x69, 0x66];
  const sos = [0xff, 0xda, 0x00, 0x02, 0x12, 0x34, 0xff, 0xd9];
  const jpeg = new Uint8Array([0xff, 0xd8, ...jfif, ...app1, ...sos]);
  const out = stripJpegMetadata(jpeg);
  assert.deepEqual([...out], [0xff, 0xd8, ...jfif, ...sos]);
});

test('non-JPEG input is rejected', () => {
  assert.throws(() => stripJpegMetadata(new Uint8Array([0x89, 0x50, 0x4e, 0x47])), /Not a JPEG/);
  assert.throws(() => stripJpegMetadata(new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x00, 0xff])), /Truncated/);
});

test('pixelateRegion averages each block and leaves the rest alone', () => {
  const width = 4; const height = 2;
  const data = new Uint8ClampedArray(width * height * 4);
  // Left 2x2 block: two black, two white pixels. Right half: red.
  const set = (x, y, rgba) => data.set(rgba, (y * width + x) * 4);
  set(0, 0, [0, 0, 0, 255]); set(1, 0, [255, 255, 255, 255]);
  set(0, 1, [255, 255, 255, 255]); set(1, 1, [0, 0, 0, 255]);
  for (const [x, y] of [[2, 0], [3, 0], [2, 1], [3, 1]]) set(x, y, [200, 0, 0, 255]);
  pixelateRegion({ data, width, height }, 0, 0, 2, 2, 2);
  for (const [x, y] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
    assert.deepEqual([...data.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)], [128, 128, 128, 255]);
  }
  assert.deepEqual([...data.subarray(8, 12)], [200, 0, 0, 255], 'outside region untouched');
});

test('pixelateRegion clamps rectangles that hang off the edge', () => {
  const img = { data: new Uint8ClampedArray(3 * 3 * 4).fill(10), width: 3, height: 3 };
  assert.doesNotThrow(() => pixelateRegion(img, -5, -5, 100, 100, 2));
  assert.ok(img.data.every((v) => v === 10));
});
