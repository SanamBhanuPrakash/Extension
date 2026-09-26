/**
 * A ZIP reader, in about two hundred lines and no dependencies.
 *
 * Every modern office format — .docx, .xlsx, .pptx, .odt, .ods, .odp — is a
 * ZIP archive of XML. So the difference between "cannot read attachments" and
 * "reads the formats most confidential documents are actually written in" is
 * a ZIP reader and an XML text walk.
 *
 * The decompression is free: `DecompressionStream('deflate-raw')` is native in
 * Chrome, Firefox, Safari and Node. No WASM, no bundled inflate, nothing added
 * to the package, and — importantly for this project — nothing fetched.
 *
 * Only the central directory is parsed, and only the entries a caller asks for
 * are inflated. A 40 MB spreadsheet whose text lives in two parts costs two
 * inflations, not forty megabytes of work.
 */

const EOCD_SIG = 0x06054b50;
const EOCD64_LOCATOR_SIG = 0x07064b50;
const EOCD64_SIG = 0x06064b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

/** Guards against a crafted archive claiming an absurd expansion. */
const MAX_ENTRY_BYTES = 32 * 1024 * 1024;
const MAX_ENTRIES = 4096;

/**
 * @param {Uint8Array} bytes
 * @returns {Array<{name, method, compressedSize, size, localOffset}>|null}
 */
export function readCentralDirectory(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // The end-of-central-directory record sits in the last 64 KB, after a
  // variable-length comment, so it has to be searched for backwards.
  let eocd = -1;
  const from = Math.max(0, bytes.length - 66_000);
  for (let i = bytes.length - 22; i >= from; i--) {
    if (view.getUint32(i, true) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) return null;

  let count = view.getUint16(eocd + 10, true);
  let directoryOffset = view.getUint32(eocd + 16, true);

  // ZIP64, for archives past the 4 GB / 65,535-entry limits. A large export
  // really does reach this.
  if (count === 0xffff || directoryOffset === 0xffffffff) {
    for (let i = eocd - 20; i >= 0 && i > eocd - 100; i--) {
      if (view.getUint32(i, true) === EOCD64_LOCATOR_SIG) {
        const at = Number(view.getBigUint64(i + 8, true));
        if (at >= 0 && at + 56 <= bytes.length && view.getUint32(at, true) === EOCD64_SIG) {
          count = Number(view.getBigUint64(at + 32, true));
          directoryOffset = Number(view.getBigUint64(at + 48, true));
        }
        break;
      }
    }
  }

  const entries = [];
  let at = directoryOffset;
  for (let i = 0; i < Math.min(count, MAX_ENTRIES); i++) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== CENTRAL_SIG) break;
    const method = view.getUint16(at + 10, true);
    let compressedSize = view.getUint32(at + 20, true);
    let size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    let localOffset = view.getUint32(at + 42, true);
    const name = new TextDecoder('utf-8').decode(bytes.subarray(at + 46, at + 46 + nameLength));

    // ZIP64 puts the real sizes in an extra field when the 32-bit ones overflow.
    if (size === 0xffffffff || compressedSize === 0xffffffff || localOffset === 0xffffffff) {
      let ex = at + 46 + nameLength;
      const exEnd = ex + extraLength;
      while (ex + 4 <= exEnd) {
        const headerId = view.getUint16(ex, true);
        const dataSize = view.getUint16(ex + 2, true);
        if (headerId === 0x0001) {
          let p = ex + 4;
          if (size === 0xffffffff) { size = Number(view.getBigUint64(p, true)); p += 8; }
          if (compressedSize === 0xffffffff) { compressedSize = Number(view.getBigUint64(p, true)); p += 8; }
          if (localOffset === 0xffffffff) { localOffset = Number(view.getBigUint64(p, true)); }
          break;
        }
        ex += 4 + dataSize;
      }
    }

    entries.push({ name, method, compressedSize, size, localOffset });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Inflates one entry. Returns its bytes, or null if it cannot be read. */
export async function readEntry(bytes, entry) {
  if (!entry || entry.size > MAX_ENTRY_BYTES) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const at = entry.localOffset;
  if (at + 30 > bytes.length || view.getUint32(at, true) !== LOCAL_SIG) return null;

  // The local header repeats the name and extra lengths, and they can differ
  // from the central directory's, so the data offset must be read from here.
  const nameLength = view.getUint16(at + 26, true);
  const extraLength = view.getUint16(at + 28, true);
  const start = at + 30 + nameLength + extraLength;
  const end = start + entry.compressedSize;
  if (end > bytes.length) return null;
  const data = bytes.subarray(start, end);

  if (entry.method === 0) return data;              // stored
  if (entry.method !== 8) return null;              // only deflate is worth supporting

  try {
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    const out = new Uint8Array(await new Response(stream).arrayBuffer());
    return out;
  } catch {
    return null;
  }
}

/** Convenience: read one named entry as text. */
export async function readText(bytes, entries, name) {
  const entry = entries.find((e) => e.name === name);
  if (!entry) return null;
  const data = await readEntry(bytes, entry);
  return data ? new TextDecoder('utf-8').decode(data) : null;
}

/** True when the bytes begin with a local file header. */
export function looksLikeZip(bytes) {
  return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b
    && (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07);
}
