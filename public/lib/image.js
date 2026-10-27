// Photo privacy helpers.
//
// Every photo goes through two independent safeguards before it leaves the
// phone:
//   1. It is decoded and redrawn onto a <canvas> at a reduced size, then
//      re-encoded as JPEG. A canvas carries pixels only, so EXIF (GPS, camera
//      serial, timestamps), XMP and ICC payloads from the original file do not
//      survive the round trip.
//   2. The resulting JPEG bytes are then walked segment by segment and any
//      APPn (except the bare JFIF APP0 header) and COM segments are dropped,
//      in case a browser ever decides to add its own metadata.
// The pure functions below (computeTargetSize, stripJpegMetadata,
// listJpegSegments, pixelateRegion) run in Node too and are unit tested.

export const MAX_EDGE = 1600;
export const JPEG_QUALITY = 0.82;

/** Scale (width, height) so the longest edge is at most maxEdge. Never upscales. */
export function computeTargetSize(width, height, maxEdge = MAX_EDGE) {
  if (!(width > 0) || !(height > 0)) throw new RangeError('Image has no size');
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return { width: Math.round(width), height: Math.round(height) };
  const scale = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function isJpeg(bytes) {
  return bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8;
}

/**
 * List the marker segments of a JPEG up to Start-Of-Scan.
 * Returns [{ marker, offset, length }] where length includes the 2 marker bytes.
 */
export function listJpegSegments(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (!isJpeg(bytes)) throw new TypeError('Not a JPEG file');
  const segments = [];
  let i = 2;
  while (i < bytes.length) {
    if (bytes[i] !== 0xff) throw new TypeError(`Corrupt JPEG at byte ${i}`);
    let marker = bytes[i + 1];
    // Skip fill bytes (0xFF padding).
    while (marker === 0xff && i + 2 < bytes.length) { i += 1; marker = bytes[i + 1]; }
    if (marker === 0xd9) { segments.push({ marker, offset: i, length: 2 }); break; }
    if (marker >= 0xd0 && marker <= 0xd7) { segments.push({ marker, offset: i, length: 2 }); i += 2; continue; }
    if (i + 3 >= bytes.length) throw new TypeError('Truncated JPEG');
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    if (len < 2 || i + 2 + len > bytes.length) throw new TypeError('Truncated JPEG segment');
    segments.push({ marker, offset: i, length: len + 2 });
    if (marker === 0xda) break; // Start of Scan: entropy-coded data follows
    i += 2 + len;
  }
  return segments;
}

function isJfifApp0(bytes, seg) {
  // "JFIF\0" identifier right after the length field.
  const s = seg.offset + 4;
  return seg.marker === 0xe0 &&
    bytes[s] === 0x4a && bytes[s + 1] === 0x46 && bytes[s + 2] === 0x49 &&
    bytes[s + 3] === 0x46 && bytes[s + 4] === 0x00;
}

/**
 * Remove metadata segments (APP1–APP15, non-JFIF APP0, COM) from a JPEG.
 * Image data is copied byte for byte, so this is lossless.
 * Note: dropping APP1 also drops the EXIF orientation tag; callers should
 * apply orientation to the pixels first (the canvas path does this).
 */
export function stripJpegMetadata(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const segments = listJpegSegments(bytes);
  const keep = [bytes.subarray(0, 2)]; // SOI
  let tailStart = bytes.length;
  for (const seg of segments) {
    const isAppN = seg.marker >= 0xe0 && seg.marker <= 0xef;
    const isComment = seg.marker === 0xfe;
    const drop = isComment || (isAppN && !isJfifApp0(bytes, seg));
    if (seg.marker === 0xda) {
      tailStart = seg.offset; // keep SOS and everything after it verbatim
      break;
    }
    if (!drop) keep.push(bytes.subarray(seg.offset, seg.offset + seg.length));
    if (seg.marker === 0xd9) tailStart = bytes.length;
  }
  if (tailStart < bytes.length) keep.push(bytes.subarray(tailStart));
  const out = new Uint8Array(keep.reduce((n, part) => n + part.length, 0));
  let o = 0;
  for (const part of keep) { out.set(part, o); o += part.length; }
  return out;
}

/** True if the JPEG still contains any APP1 (EXIF/XMP) or COM segment. */
export function hasJpegMetadata(input) {
  return listJpegSegments(input).some((s) => s.marker === 0xfe || (s.marker >= 0xe1 && s.marker <= 0xef));
}

/**
 * Pixelate a rectangle of an RGBA buffer in place (for blurring a face or a
 * number plate that sneaked into shot). `image` is ImageData-shaped:
 * { data: Uint8ClampedArray, width, height }.
 */
export function pixelateRegion(image, x, y, w, h, block = 12) {
  const { data, width, height } = image;
  const x0 = Math.max(0, Math.floor(x));
  const y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(width, Math.ceil(x + w));
  const y1 = Math.min(height, Math.ceil(y + h));
  const size = Math.max(1, Math.floor(block));
  for (let by = y0; by < y1; by += size) {
    for (let bx = x0; bx < x1; bx += size) {
      const ex = Math.min(bx + size, x1);
      const ey = Math.min(by + size, y1);
      let r = 0; let g = 0; let b = 0; let a = 0; let n = 0;
      for (let py = by; py < ey; py++) {
        for (let px = bx; px < ex; px++) {
          const k = (py * width + px) * 4;
          r += data[k]; g += data[k + 1]; b += data[k + 2]; a += data[k + 3]; n++;
        }
      }
      r = Math.round(r / n); g = Math.round(g / n); b = Math.round(b / n); a = Math.round(a / n);
      for (let py = by; py < ey; py++) {
        for (let px = bx; px < ex; px++) {
          const k = (py * width + px) * 4;
          data[k] = r; data[k + 1] = g; data[k + 2] = b; data[k + 3] = a;
        }
      }
    }
  }
  return image;
}

// ---------------------------------------------------------------------------
// Browser-only helpers (need canvas / createImageBitmap).

/** Draw a video frame, ImageBitmap or <img> onto a fresh, downscaled canvas. */
export function drawToCanvas(source, srcWidth, srcHeight, maxEdge = MAX_EDGE) {
  const { width, height } = computeTargetSize(srcWidth, srcHeight, maxEdge);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, width, height);
  return canvas;
}

/** Decode a File from <input type=file>, honouring EXIF orientation, into a canvas. */
export async function fileToCanvas(file, maxEdge = MAX_EDGE) {
  if ('createImageBitmap' in globalThis) {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      const canvas = drawToCanvas(bmp, bmp.width, bmp.height, maxEdge);
      bmp.close?.();
      return canvas;
    } catch { /* fall through to <img> decode */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return drawToCanvas(img, img.naturalWidth, img.naturalHeight, maxEdge);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Re-encode a canvas to a metadata-free JPEG Blob. */
export async function canvasToCleanJpeg(canvas, quality = JPEG_QUALITY) {
  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode photo'))), 'image/jpeg', quality);
  });
  const clean = stripJpegMetadata(new Uint8Array(await blob.arrayBuffer()));
  return new Blob([clean], { type: 'image/jpeg' });
}
