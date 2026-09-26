/**
 * What can honestly be read out of an image without OCR.
 *
 * OCR is not viable here. Tesseract's WASM build plus one language model is
 * several megabytes; bundling it would triple the package and invite the
 * "obfuscated code" question at store review, and downloading it on demand
 * would break the one promise this project makes. So a screenshot of a
 * dashboard stays unreadable, and the extension says so rather than implying
 * the file was checked.
 *
 * But an image is not only its pixels. A photograph carries an EXIF block, and
 * that block routinely contains things nobody means to share:
 *
 *   - GPS coordinates, to a few metres
 *   - the device make, model and serial
 *   - the owner's name, in Artist or Copyright
 *   - the software and the original capture time
 *
 * Someone pasting a photo of a whiteboard is also pasting the office's
 * coordinates. That is extractable in a hundred lines, and it is a real leak
 * that no amount of OCR would have found either.
 */

const latin1 = new TextDecoder('latin1');

export function sniffImage(bytes) {
  if (bytes.length < 12) return null;
  const b = bytes;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'gif';
  if (b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'webp';
  const brand = latin1.decode(b.subarray(4, 12));
  if (brand.startsWith('ftyp')) {
    if (/heic|heix|hevc|mif1|msf1/.test(brand)) return 'heic';
    if (/avif/.test(brand)) return 'avif';
  }
  return null;
}

/** EXIF tags worth surfacing; everything else is camera telemetry. */
const TIFF_TAGS = {
  0x010f: 'make', 0x0110: 'model', 0x0131: 'software', 0x013b: 'artist',
  0x8298: 'copyright', 0x010e: 'description', 0x0132: 'dateTime',
  0x9003: 'dateTimeOriginal', 0xa430: 'ownerName', 0xa431: 'bodySerialNumber',
  0xa433: 'lensMake', 0xc62f: 'cameraSerialNumber',
};
const GPS_TAGS = {
  0x0001: 'latRef', 0x0002: 'lat', 0x0003: 'lonRef', 0x0004: 'lon',
  0x0005: 'altRef', 0x0006: 'alt',
};
const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

function readIfd(view, tiffStart, offset, le, tags, out, limit = 64) {
  if (offset < 0 || offset + 2 > view.byteLength) return null;
  const count = Math.min(view.getUint16(offset, le), limit);
  let nextPointer = null;
  for (let i = 0; i < count; i++) {
    const at = offset + 2 + i * 12;
    if (at + 12 > view.byteLength) break;
    const tag = view.getUint16(at, le);
    const type = view.getUint16(at + 2, le);
    const length = view.getUint32(at + 4, le);
    const size = (TYPE_SIZE[type] || 1) * length;
    const valueAt = size > 4 ? tiffStart + view.getUint32(at + 8, le) : at + 8;
    if (valueAt < 0 || valueAt + Math.min(size, 4) > view.byteLength) continue;

    if (tag === 0x8825) { nextPointer = tiffStart + view.getUint32(at + 8, le); continue; }
    const name = tags[tag];
    if (!name) continue;

    if (type === 2) {
      let s = '';
      for (let k = 0; k < Math.min(size, 200); k++) {
        const code = view.getUint8(valueAt + k);
        if (code === 0) break;
        s += String.fromCharCode(code);
      }
      if (s.trim()) out[name] = s.trim();
    } else if (type === 5 && length >= 3) {
      // Rationals: degrees, minutes, seconds.
      const parts = [];
      for (let k = 0; k < 3; k++) {
        const num = view.getUint32(valueAt + k * 8, le);
        const den = view.getUint32(valueAt + k * 8 + 4, le) || 1;
        parts.push(num / den);
      }
      out[name] = parts;
    } else if (type === 3) {
      out[name] = view.getUint16(valueAt, le);
    } else if (type === 4) {
      out[name] = view.getUint32(valueAt, le);
    }
  }
  return nextPointer;
}

function toDecimal(dms, ref) {
  if (!Array.isArray(dms)) return null;
  const [d, m, s] = dms;
  let value = d + m / 60 + s / 3600;
  if (ref === 'S' || ref === 'W') value = -value;
  return Number(value.toFixed(6));
}

/** Parses the TIFF block inside an EXIF APP1 segment. */
function parseExif(bytes, tiffStart) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (tiffStart + 8 > bytes.length) return null;

  // 'MM' is big-endian, 'II' little. DataView's second argument is
  // `littleEndian`, so the flag threaded through every read below is named for
  // what DataView wants rather than for what TIFF calls it — an earlier
  // version passed `isBigEndian` straight in, and every value came back
  // byte-swapped and unreadable.
  const order = view.getUint16(tiffStart, false);
  const le = order === 0x4949;
  if (!le && order !== 0x4d4d) return null;
  if (view.getUint16(tiffStart + 2, le) !== 42) return null;

  const out = {};
  const ifd0 = tiffStart + view.getUint32(tiffStart + 4, le);
  const gpsPointer = readIfd(view, tiffStart, ifd0, le, TIFF_TAGS, out);
  if (gpsPointer) {
    const gps = {};
    readIfd(view, tiffStart, gpsPointer, le, GPS_TAGS, gps);
    const lat = toDecimal(gps.lat, gps.latRef);
    const lon = toDecimal(gps.lon, gps.lonRef);
    if (lat !== null && lon !== null) out.gps = { lat, lon };
  }
  return out;
}

/** PNG text chunks: tEXt, iTXt and zTXt carry author and software fields. */
function parsePngText(bytes) {
  const out = {};
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  let guard = 0;
  while (at + 8 < bytes.length && guard++ < 200) {
    const length = view.getUint32(at, false);
    const type = latin1.decode(bytes.subarray(at + 4, at + 8));
    if (type === 'IEND') break;
    if ((type === 'tEXt' || type === 'iTXt') && length < 20000) {
      const body = bytes.subarray(at + 8, at + 8 + length);
      const nul = body.indexOf(0);
      if (nul > 0) {
        const key = latin1.decode(body.subarray(0, nul)).trim();
        const value = latin1.decode(body.subarray(nul + 1)).replace(/\u0000/g, ' ').trim();
        if (key && value) out[key] = value.slice(0, 300);
      }
    }
    if (type === 'IHDR' && length >= 8) {
      out.width = view.getUint32(at + 8, false);
      out.height = view.getUint32(at + 12, false);
    }
    at += 12 + length;
  }
  return out;
}

/**
 * @param {Uint8Array} bytes
 * @returns {{format, metadata, gps, width, height}|null}
 */
export function readImageMetadata(bytes) {
  const format = sniffImage(bytes);
  if (!format) return null;

  if (format === 'png') {
    const meta = parsePngText(bytes);
    const { width, height, ...rest } = meta;
    return { format, metadata: rest, gps: null, width, height };
  }

  if (format === 'jpeg' || format === 'heic' || format === 'avif') {
    // Walk JPEG segments for APP1; for HEIF the EXIF block is inside a box,
    // so fall back to locating the marker directly.
    let tiffStart = -1;
    if (format === 'jpeg') {
      let at = 2;
      let guard = 0;
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      while (at + 4 < bytes.length && guard++ < 64) {
        if (bytes[at] !== 0xff) break;
        const marker = bytes[at + 1];
        if (marker === 0xda || marker === 0xd9) break; // scan data
        const size = view.getUint16(at + 2, false);
        if (marker === 0xe1 && latin1.decode(bytes.subarray(at + 4, at + 10)) === 'Exif\u0000\u0000') {
          tiffStart = at + 10;
          break;
        }
        at += 2 + size;
      }
    }
    if (tiffStart < 0) {
      const head = latin1.decode(bytes.subarray(0, Math.min(bytes.length, 262144)));
      const found = head.indexOf('Exif\u0000\u0000');
      if (found >= 0) tiffStart = found + 6;
    }
    if (tiffStart < 0) return { format, metadata: {}, gps: null };

    const exif = parseExif(bytes, tiffStart);
    if (!exif) return { format, metadata: {}, gps: null };
    const { gps, ...rest } = exif;
    return { format, metadata: rest, gps: gps || null };
  }

  return { format, metadata: {}, gps: null };
}

/** One sentence naming what an image gave away, or null. */
export function describeImageMetadata(result) {
  if (!result) return null;
  const parts = [];
  if (result.gps) {
    parts.push(`GPS coordinates ${result.gps.lat}, ${result.gps.lon}`);
  }
  const m = result.metadata || {};
  const person = m.artist || m.ownerName || m.copyright || m.Author || m.author;
  if (person) parts.push(`the name "${String(person).slice(0, 60)}"`);
  const device = [m.make, m.model].filter(Boolean).join(' ');
  if (device) parts.push(`the device ${device}`);
  if (m.bodySerialNumber || m.cameraSerialNumber) parts.push('a camera serial number');
  if (m.software || m.Software) parts.push(`the software ${m.software || m.Software}`);
  if (m.dateTimeOriginal || m.dateTime) parts.push('the original capture time');
  if (!parts.length) return null;
  return `This image carries ${parts.join(', ')} in its metadata.`;
}

// ─────────────────────────────────────────────────────────── stripping
//
// Warning about a photograph's GPS block is half a feature. The other half is
// being able to hand back the same photograph without it, so the answer to
// "this image carries your office coordinates" is a button rather than a
// lecture.
//
// Both formats below are strippable exactly, with no re-encoding and no loss:
// JPEG metadata lives in APPn/COM segments before the scan data, and PNG
// metadata lives in ancillary chunks that any decoder is required to skip.
// Dropping them yields a byte-identical image with a smaller header. WebP,
// HEIC, AVIF and GIF are not attempted — their containers interleave metadata
// with the image data, and a half-correct rewrite is worse than an honest no.

/** JPEG segments that carry metadata rather than image data. */
const JPEG_DROP = new Set([
  0xe1, // APP1  EXIF, XMP
  0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xeb,
  0xec, // APP12 Picture Info / Ducky
  0xed, // APP13 Photoshop IRB, which is where IPTC captions and credits live
  0xee, // APP14 Adobe
  0xef,
  0xfe, // COM   free-text comment
]);

/** PNG chunks that carry metadata rather than image data. */
const PNG_DROP = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME', 'dSIG']);

function stripJpeg(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const keep = [bytes.subarray(0, 2)];
  const removed = [];
  let at = 2;
  let guard = 0;

  while (at + 4 <= bytes.length && guard++ < 256) {
    if (bytes[at] !== 0xff) break;
    const marker = bytes[at + 1];
    // Start of scan, or end of image: everything from here is image data.
    if (marker === 0xda || marker === 0xd9) break;
    // Standalone markers carry no length field.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { at += 2; continue; }
    const size = view.getUint16(at + 2, false);
    if (size < 2 || at + 2 + size > bytes.length) return null; // malformed: do not touch it
    if (JPEG_DROP.has(marker)) removed.push(`APP${(marker & 0x0f).toString()}`);
    else keep.push(bytes.subarray(at, at + 2 + size));
    at += 2 + size;
  }
  if (at >= bytes.length) return null;
  keep.push(bytes.subarray(at));
  if (!removed.length) return null;
  return { parts: keep, removed };
}

function stripPng(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const keep = [bytes.subarray(0, 8)];
  const removed = [];
  let at = 8;
  let guard = 0;

  while (at + 12 <= bytes.length && guard++ < 4096) {
    const length = view.getUint32(at, false);
    const type = latin1.decode(bytes.subarray(at + 4, at + 8));
    const end = at + 12 + length;
    if (length > bytes.length || end > bytes.length) return null; // malformed
    if (PNG_DROP.has(type)) removed.push(type);
    else keep.push(bytes.subarray(at, end));
    at = end;
    if (type === 'IEND') break;
  }
  if (!removed.length) return null;
  return { parts: keep, removed };
}

/**
 * @param {Uint8Array} bytes
 * @returns {{bytes: Uint8Array, removed: string[]}|null} null when the format
 *   cannot be rewritten safely, or when there was no metadata to remove.
 */
export function stripImageMetadata(bytes) {
  const format = sniffImage(bytes);
  let result = null;
  try {
    if (format === 'jpeg') result = stripJpeg(bytes);
    else if (format === 'png') result = stripPng(bytes);
  } catch { return null; }
  if (!result) return null;

  const total = result.parts.reduce((n, part) => n + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of result.parts) { out.set(part, at); at += part.length; }
  return { bytes: out, removed: [...new Set(result.removed)] };
}

/** True when a metadata-carrying image can be handed back without it. */
export function canStripMetadata(bytes) {
  const format = sniffImage(bytes);
  return format === 'jpeg' || format === 'png';
}
