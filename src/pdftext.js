/**
 * Text out of a PDF, with no dependencies.
 *
 * PDF is not a text format. Characters live inside content streams, usually
 * Flate-compressed, addressed by glyph index rather than by character, and the
 * mapping back to Unicode lives in a separate stream somewhere else in the
 * file. That is why "just read the PDF" is not a one-liner, and why most
 * browser tools either ship a megabyte of library or give up.
 *
 * `DecompressionStream('deflate')` is native, so the compression is free. What
 * is left is the format itself, and that is what this file is.
 *
 * ── Deliberately not a full PDF parser ──────────────────────────────────
 *
 * The cross-reference table is ignored. Real-world PDFs are linearised,
 * incrementally updated, damaged by mail gateways, and written by tools that
 * disagree about the spec; an xref walk fails on all of those. Instead every
 * `stream ... endstream` block is found by scanning, which cannot fail on a
 * broken table and finds text in revisions an xref walk would skip.
 *
 * The cost is that content is not ordered by page. For finding a credential or
 * a customer record in a document, order does not matter.
 *
 * ── What it cannot do ───────────────────────────────────────────────────
 *
 * A scanned PDF is a photograph of text. There is nothing to extract, and this
 * reports `scanned: true` so the caller can say so rather than implying the
 * document was checked.
 */

const MAX_PDF_BYTES = 24 * 1024 * 1024;
const MAX_STREAMS = 600;

const latin1 = new TextDecoder('latin1');

export function looksLikePdf(bytes) {
  // The header is usually at offset 0 but the spec allows junk before it.
  const head = latin1.decode(bytes.subarray(0, 1024));
  return head.includes('%PDF-');
}

async function inflateOnce(data, format) {
  try {
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream(format));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * Inflates a stream, tolerating the ways real PDFs are written.
 *
 * `DecompressionStream` rejects trailing bytes, and producers routinely leave
 * an EOL between the compressed data and `endstream` — the fixture written by
 * Python's zlib does exactly that, and it failed with "trailing junk". The
 * `/Length` in the dictionary is authoritative when it is a literal number;
 * when it is an indirect reference, which is common in linearised files, the
 * only option is to trim and retry.
 *
 * Some producers also write raw deflate under the `/FlateDecode` name, so both
 * framings are tried.
 */
async function inflate(data, declaredLength) {
  const candidates = [];
  if (Number.isFinite(declaredLength) && declaredLength > 0 && declaredLength <= data.length) {
    candidates.push(data.subarray(0, declaredLength));
  }
  candidates.push(data);
  // Trim trailing EOL and whitespace, one byte at a time.
  let end = data.length;
  while (end > 0 && (data[end - 1] === 0x0a || data[end - 1] === 0x0d || data[end - 1] === 0x20)) {
    end--;
    candidates.push(data.subarray(0, end));
  }

  const seen = new Set();
  for (const candidate of candidates) {
    if (candidate.length === 0 || seen.has(candidate.length)) continue;
    seen.add(candidate.length);
    for (const format of ['deflate', 'deflate-raw']) {
      const out = await inflateOnce(candidate, format);
      if (out && out.length) return out;
    }
  }
  return null;
}

/** Every `stream ... endstream` block, with the dictionary that precedes it. */
function findStreams(bytes) {
  const text = latin1.decode(bytes);
  const out = [];
  let at = 0;
  while (out.length < MAX_STREAMS) {
    const start = text.indexOf('stream', at);
    if (start < 0) break;
    // Guard against matching "endstream" or a word ending in "stream".
    const before = text[start - 1];
    if (before && /[A-Za-z]/.test(before)) { at = start + 6; continue; }

    // The dictionary is the nearest `<< ... >>` before the keyword.
    const dictStart = text.lastIndexOf('<<', start);
    const dict = dictStart >= 0 ? text.slice(dictStart, start) : '';

    let dataStart = start + 6;
    if (text[dataStart] === '\r') dataStart++;
    if (text[dataStart] === '\n') dataStart++;
    const end = text.indexOf('endstream', dataStart);
    if (end < 0) break;

    // A literal /Length is authoritative; an indirect one is not resolvable
    // without an object table, and inflate() falls back to trimming.
    const lengthMatch = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dict);
    out.push({
      dict,
      data: bytes.subarray(dataStart, end),
      declaredLength: lengthMatch ? Number(lengthMatch[1]) : null,
      at: dictStart,
    });
    at = end + 9;
  }
  return out;
}

/** Decodes a PDF string literal or hex string into bytes. */
function decodeStringBytes(raw, hex) {
  if (hex) {
    const clean = raw.replace(/[^0-9a-fA-F]/g, '');
    const padded = clean.length % 2 ? `${clean}0` : clean;
    const out = new Uint8Array(padded.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(padded.substr(i * 2, 2), 16);
    return out;
  }
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch !== '\\') { out.push(raw.charCodeAt(i)); continue; }
    const next = raw[++i];
    if (next === undefined) break;
    if (next >= '0' && next <= '7') {
      let oct = next;
      while (oct.length < 3 && raw[i + 1] >= '0' && raw[i + 1] <= '7') oct += raw[++i];
      out.push(parseInt(oct, 8) & 0xff);
    } else {
      const map = { n: 10, r: 13, t: 9, b: 8, f: 12, '(': 40, ')': 41, '\\': 92 };
      if (next === '\n') continue;          // line continuation
      out.push(map[next] ?? next.charCodeAt(0));
    }
  }
  return Uint8Array.from(out);
}

/**
 * Parses a ToUnicode CMap: the table that turns glyph codes back into
 * characters. Without it, a PDF produced by Word extracts as mojibake, because
 * subset fonts number their glyphs from scratch.
 */
function parseToUnicode(cmapText) {
  const map = new Map();
  const hex = (s) => parseInt(s, 16);
  const toStr = (s) => {
    let out = '';
    for (let i = 0; i + 3 < s.length + 1; i += 4) {
      const code = hex(s.substr(i, 4));
      if (Number.isFinite(code)) out += String.fromCharCode(code);
    }
    return out;
  };

  const charRe = /beginbfchar([\s\S]*?)endbfchar/g;
  let block;
  while ((block = charRe.exec(cmapText)) !== null) {
    const pairRe = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g;
    let pair;
    while ((pair = pairRe.exec(block[1])) !== null) map.set(hex(pair[1]), toStr(pair[2]));
  }

  const rangeRe = /beginbfrange([\s\S]*?)endbfrange/g;
  while ((block = rangeRe.exec(cmapText)) !== null) {
    const body = block[1];
    // <lo> <hi> <dst>
    const simple = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g;
    let m;
    while ((m = simple.exec(body)) !== null) {
      const lo = hex(m[1]);
      const hi = hex(m[2]);
      const base = hex(m[3].slice(-4));
      if (hi - lo > 65535) continue;
      for (let c = lo; c <= hi; c++) map.set(c, String.fromCharCode(base + (c - lo)));
    }
    // <lo> <hi> [ <a> <b> ... ]
    const listed = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*\[([\s\S]*?)\]/g;
    while ((m = listed.exec(body)) !== null) {
      const lo = hex(m[1]);
      const items = m[3].match(/<([0-9a-fA-F]+)>/g) || [];
      items.forEach((item, i) => map.set(lo + i, toStr(item.slice(1, -1))));
    }
  }
  return map;
}

/** Pulls the text-showing operators out of a content stream. */
function textFromContent(content, cmaps) {
  const out = [];
  let current = null;

  // Tokens we care about: Tf (font select), Tj/'/" (show), TJ (show array),
  // Td/TD/T*/ET (line breaks).
  const re = /\/([A-Za-z0-9#+._-]+)\s+[\d.]+\s+Tf|\(((?:\\.|[^\\()]|\((?:\\.|[^\\()])*\))*)\)\s*(Tj|TJ|'|")|<([0-9a-fA-F\s]*)>\s*(Tj|TJ)|\[((?:[^\][]|\[[^\]]*\])*)\]\s*TJ|(T\*|Td|TD|ET|BT)/g;

  let m;
  while ((m = re.exec(content)) !== null) {
    if (m[1] !== undefined) { current = cmaps.get(m[1]) || null; continue; }

    const show = (bytes) => {
      if (current) {
        // Two-byte glyph codes through the font's own table.
        let s = '';
        for (let i = 0; i + 1 < bytes.length; i += 2) {
          s += current.get((bytes[i] << 8) | bytes[i + 1]) ?? '';
        }
        // Some subset fonts are single-byte even with a ToUnicode map.
        if (!s) for (const b of bytes) s += current.get(b) ?? '';
        out.push(s);
      } else {
        out.push(latin1.decode(bytes));
      }
    };

    if (m[2] !== undefined) { show(decodeStringBytes(m[2], false)); continue; }
    if (m[4] !== undefined) { show(decodeStringBytes(m[4], true)); continue; }
    if (m[6] !== undefined) {
      // A TJ array interleaves strings with kerning numbers; a large negative
      // adjustment is a word space.
      const parts = /(\((?:\\.|[^\\()])*\)|<[0-9a-fA-F\s]*>|-?[\d.]+)/g;
      let p;
      while ((p = parts.exec(m[6])) !== null) {
        const token = p[1];
        if (token[0] === '(') show(decodeStringBytes(token.slice(1, -1), false));
        else if (token[0] === '<') show(decodeStringBytes(token.slice(1, -1), true));
        else if (Number(token) < -120) out.push(' ');
      }
      continue;
    }
    if (m[7] === 'T*' || m[7] === 'Td' || m[7] === 'TD' || m[7] === 'ET') out.push('\n');
  }

  return out.join('')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n');
}

/** The document information dictionary: author, producer, title. */
function documentInfo(text) {
  const info = {};
  const section = /\/(Author|Title|Subject|Creator|Producer|Keywords)\s*\(((?:\\.|[^\\()])*)\)/g;
  let m;
  while ((m = section.exec(text)) !== null) {
    const value = latin1.decode(decodeStringBytes(m[2], false)).replace(/\u0000/g, '').trim();
    if (value) info[m[1].toLowerCase()] = value;
  }
  return info;
}

/**
 * @param {Uint8Array} bytes
 * @returns {Promise<{text, metadata, pages, scanned, streams}|null>}
 */
export async function extractPdfText(bytes) {
  if (!looksLikePdf(bytes) || bytes.length > MAX_PDF_BYTES) return null;
  const whole = latin1.decode(bytes);
  const streams = findStreams(bytes);

  // Font tables first: a content stream cannot be decoded without them.
  const cmaps = new Map();
  const fontRefs = new Map(); // font resource name -> ToUnicode object number
  const resourceRe = /\/([A-Za-z0-9#+._-]+)\s+(\d+)\s+0\s+R/g;
  const toUnicodeObjects = new Set();
  let m;
  const toUniRe = /\/ToUnicode\s+(\d+)\s+0\s+R/g;
  while ((m = toUniRe.exec(whole)) !== null) toUnicodeObjects.add(Number(m[1]));

  // Map each font resource name to the ToUnicode stream of its font object.
  const fontObjRe = /(\d+)\s+0\s+obj\s*<<([^]*?)>>/g;
  const fontObjects = new Map();
  while ((m = fontObjRe.exec(whole)) !== null) fontObjects.set(Number(m[1]), m[2]);
  const nameToFontObj = new Map();
  const fontDictRe = /\/Font\s*<<([^>]*(?:>[^>][^>]*)*)>>/g;
  while ((m = fontDictRe.exec(whole)) !== null) {
    resourceRe.lastIndex = 0;
    let r;
    while ((r = resourceRe.exec(m[1])) !== null) nameToFontObj.set(r[1], Number(r[2]));
  }

  const objectNumberAt = (offset) => {
    const before = whole.lastIndexOf(' obj', offset);
    if (before < 0) return null;
    const head = whole.slice(Math.max(0, before - 24), before);
    const n = /(\d+)\s+0\s*$/.exec(head);
    return n ? Number(n[1]) : null;
  };

  const decoded = [];
  const cmapByObject = new Map();
  let hasImage = false;

  for (const stream of streams) {
    const filtered = /\/FlateDecode/.test(stream.dict);
    if (/\/Subtype\s*\/Image|\/Image\b/.test(stream.dict)) { hasImage = true; continue; }
    if (/\/DCTDecode|\/JPXDecode|\/CCITTFaxDecode|\/JBIG2Decode/.test(stream.dict)) { hasImage = true; continue; }

    const data = filtered ? await inflate(stream.data, stream.declaredLength) : stream.data;
    if (!data) continue;
    const asText = latin1.decode(data);
    const objectNumber = objectNumberAt(stream.at);

    if (objectNumber !== null && toUnicodeObjects.has(objectNumber) && /begincmap|beginbfchar|beginbfrange/.test(asText)) {
      cmapByObject.set(objectNumber, parseToUnicode(asText));
      continue;
    }
    decoded.push(asText);
  }

  for (const [name, objectNumber] of nameToFontObj) {
    const dict = fontObjects.get(objectNumber);
    if (!dict) continue;
    const ref = /\/ToUnicode\s+(\d+)\s+0\s+R/.exec(dict);
    if (ref && cmapByObject.has(Number(ref[1]))) cmaps.set(name, cmapByObject.get(Number(ref[1])));
  }
  // Fonts whose ToUnicode could not be tied to a resource name still help as
  // a fallback when only one table exists.
  if (!cmaps.size && cmapByObject.size === 1) {
    const only = [...cmapByObject.values()][0];
    for (const name of nameToFontObj.keys()) cmaps.set(name, only);
  }

  const text = decoded
    .filter((s) => /\bT[jJ*]\b|\bBT\b|\bTd\b/.test(s))
    .map((s) => textFromContent(s, cmaps))
    .join('\n')
    .trim();

  const pages = (whole.match(/\/Type\s*\/Page\b/g) || []).length || 1;
  const metadata = documentInfo(whole);

  return {
    text,
    metadata,
    pages,
    // Images and no extractable text is a scan. Saying so is the honest
    // alternative to silently reporting nothing found.
    scanned: hasImage && text.replace(/\s/g, '').length < 24,
    streams: streams.length,
  };
}
