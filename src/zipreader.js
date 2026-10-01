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

/**
 * Three ceilings, because one is not enough.
 *
 * `MAX_ENTRY_BYTES` bounds what a single part may *declare*. That is a cheap
 * check and it is the only one a header can be trusted for, which is why it is
 * also the weakest: a central directory saying `size = 1000` costs nothing to
 * write and says nothing about what the deflate stream actually produces.
 *
 * `MAX_OUTPUT_BYTES` bounds what decompression is allowed to *emit*, measured
 * as it arrives. That is the one a bomb runs into.
 *
 * `MAX_ARCHIVE_BYTES` bounds the sum across every entry in one file, because
 * 4,096 entries of 32 MB each is 128 GB and none of them individually breaks a
 * rule.
 */
const MAX_ENTRY_BYTES = 32 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 96 * 1024 * 1024;
const MAX_ENTRIES = 4096;

/**
 * A shared decompression allowance for one archive.
 *
 * Created per file by the caller and threaded through every `readEntry`, so
 * the budget is spent across the whole document rather than reset per part.
 */
export function archiveBudget(bytes = MAX_ARCHIVE_BYTES) {
  return { remaining: bytes };
}

/**
 * A 64-bit field, or null when it is not a number this code can act on.
 *
 * `Number(getBigUint64(...))` silently loses precision above 2^53, so a
 * crafted ZIP64 header could produce an offset that is *nearly* right and
 * therefore lands somewhere unintended rather than being rejected. Anything
 * past the safe integer range, or past the file itself, is not an offset into
 * this file and is refused rather than approximated.
 */
function safeU64(view, at, limit) {
  const raw = view.getBigUint64(at, true);
  if (raw > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  const n = Number(raw);
  return n >= 0 && n <= limit ? n : null;
}

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
        const at = safeU64(view, i + 8, bytes.length);
        if (at !== null && at + 56 <= bytes.length && view.getUint32(at, true) === EOCD64_SIG) {
          const n = safeU64(view, at + 32, MAX_ENTRIES);
          const offset = safeU64(view, at + 48, bytes.length);
          if (n !== null) count = n;
          if (offset !== null) directoryOffset = offset;
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
          // A ZIP64 field that is out of range leaves the 32-bit sentinel in
          // place, which every check downstream then rejects. Approximating it
          // would be worse than not reading it.
          if (size === 0xffffffff) { size = safeU64(view, p, MAX_ENTRY_BYTES) ?? size; p += 8; }
          if (compressedSize === 0xffffffff) { compressedSize = safeU64(view, p, bytes.length) ?? compressedSize; p += 8; }
          if (localOffset === 0xffffffff) { localOffset = safeU64(view, p, bytes.length) ?? localOffset; }
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

/**
 * Inflates one entry, refusing to produce more than it is allowed to.
 *
 * @param {Uint8Array} bytes the whole archive
 * @param {object} entry from readCentralDirectory()
 * @param {{remaining: number}} [budget] shared across the archive
 * @returns {Promise<Uint8Array|null>}
 */
export async function readEntry(bytes, entry, budget = null) {
  if (!entry || entry.size > MAX_ENTRY_BYTES) return null;
  if (budget && budget.remaining <= 0) return null;
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

  if (entry.method === 0) {                         // stored
    if (budget) {
      if (data.length > budget.remaining) return null;
      budget.remaining -= data.length;
    }
    return data;
  }
  if (entry.method !== 8) return null;              // only deflate is worth supporting

  const limit = Math.min(MAX_OUTPUT_BYTES, budget ? budget.remaining : MAX_OUTPUT_BYTES);
  const out = await inflateBounded(data, 'deflate-raw', limit);
  if (out && budget) budget.remaining -= out.length;
  return out;
}

/**
 * Decompression that stops when it has produced too much.
 *
 * `new Response(stream).arrayBuffer()` reads to completion, so the only thing
 * standing between a crafted archive and an arbitrary allocation was a size
 * field the archive wrote itself. Reading the stream chunk by chunk and
 * cancelling past `limit` bounds the *actual* output, which is the number that
 * matters.
 */
export async function inflateBounded(data, format, limit) {
  let reader;
  try {
    reader = new Blob([data]).stream().pipeThrough(new DecompressionStream(format)).getReader();
  } catch {
    return null;
  }
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > limit) {
        try { await reader.cancel(); } catch { /* already closed */ }
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;                                    // truncated or corrupt stream
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.length; }
  return out;
}

/** Convenience: read one named entry as text. */
export async function readText(bytes, entries, name, budget = null) {
  const entry = entries.find((e) => e.name === name);
  if (!entry) return null;
  const data = await readEntry(bytes, entry, budget);
  return data ? new TextDecoder('utf-8').decode(data) : null;
}

/** True when the bytes begin with a local file header. */
export function looksLikeZip(bytes) {
  return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b
    && (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07);
}
