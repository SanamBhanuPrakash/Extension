/**
 * Text and tables out of Office and OpenDocument files.
 *
 * The formats that carry the most confidential material in an organisation —
 * contracts, HR spreadsheets, board decks — are ZIP archives of XML. Once the
 * ZIP reader exists, extracting their text is a walk over tags.
 *
 * Spreadsheets get special treatment: cells are reconstructed into delimited
 * rows, so an HR export dropped into a chat is not "some text with emails in
 * it" but a table with a `full_name` column and 4,000 rows, which is what the
 * bulk-record detector needs to call it what it is.
 *
 * Deliberately no DOMParser: it does not exist in Node, and an XML parse of an
 * untrusted document is a larger attack surface than a tag walk over text.
 * These files are adversarial input.
 */
import { readCentralDirectory, readEntry, readText, looksLikeZip } from './zipreader.js';

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body] ?? whole;
  });
}

/** All text inside elements with the given local name, in document order. */
function textOf(xml, localName) {
  const out = [];
  const re = new RegExp(`<(?:\\w+:)?${localName}\\b[^>]*?(/)?>`, 'g');
  let m;
  while ((m = re.exec(xml)) !== null) {
    if (m[1]) continue; // self-closing
    const close = xml.indexOf('</', re.lastIndex);
    if (close < 0) break;
    out.push(decodeEntities(xml.slice(re.lastIndex, close).replace(/<[^>]*>/g, '')));
  }
  return out;
}

/** Splits a document into the chunks a tag delimits, keeping their order. */
function chunksBetween(xml, localName) {
  const parts = [];
  const open = new RegExp(`<(?:\\w+:)?${localName}\\b[^>]*>`, 'g');
  const close = new RegExp(`</(?:\\w+:)?${localName}>`, 'g');
  let m;
  while ((m = open.exec(xml)) !== null) {
    close.lastIndex = open.lastIndex;
    const end = close.exec(xml);
    if (!end) break;
    parts.push(xml.slice(open.lastIndex, end.index));
    open.lastIndex = close.lastIndex;
  }
  return parts;
}

// ── Word ─────────────────────────────────────────────────────────────────

function extractDocx(documentXml) {
  const lines = [];
  // Tables first, so their rows become delimited lines the table detector can
  // read; then the remaining paragraphs in order.
  const withoutTables = documentXml.replace(/<(?:\w+:)?tbl\b[\s\S]*?<\/(?:\w+:)?tbl>/g, (table) => {
    for (const row of chunksBetween(table, 'tr')) {
      const cells = chunksBetween(row, 'tc').map((cell) => textOf(cell, 't').join('').trim());
      if (cells.some(Boolean)) lines.push(cells.join(','));
    }
    return '\n\u0000TABLE\u0000\n';
  });

  const paragraphs = [];
  for (const p of chunksBetween(withoutTables, 'p')) {
    const text = textOf(p, 't').join('').trim();
    if (text) paragraphs.push(text);
  }
  // Tables are emitted as a contiguous block so their rows stay adjacent.
  return [...paragraphs, ...(lines.length ? [''] : []), ...lines].join('\n');
}

// ── Excel ────────────────────────────────────────────────────────────────

const columnIndex = (ref) => {
  const letters = /^([A-Z]+)/.exec(ref);
  if (!letters) return 0;
  let n = 0;
  for (const ch of letters[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

function extractSheet(sheetXml, sharedStrings, maxRows) {
  const lines = [];
  for (const row of chunksBetween(sheetXml, 'row')) {
    const cells = [];
    const cellRe = /<(?:\w+:)?c\b([^>]*)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g;
    let m;
    while ((m = cellRe.exec(row)) !== null) {
      const attrs = m[1] || '';
      const body = m[2] || '';
      const ref = /r="([A-Z]+\d+)"/.exec(attrs);
      const at = ref ? columnIndex(ref[1]) : cells.length;
      const type = /t="([^"]+)"/.exec(attrs)?.[1];

      let value = '';
      if (type === 's') {
        const index = Number(textOf(body, 'v')[0]);
        value = sharedStrings[index] ?? '';
      } else if (type === 'inlineStr') {
        value = textOf(body, 't').join('');
      } else if (type === 'str') {
        value = textOf(body, 'v').join('');
      } else {
        value = textOf(body, 'v').join('');
      }
      while (cells.length < at) cells.push('');
      cells[at] = String(value).replace(/[\r\n,]+/g, ' ').trim();
    }
    if (cells.some(Boolean)) lines.push(cells.join(','));
    if (lines.length >= maxRows) break;
  }
  return lines;
}

// ── PowerPoint ───────────────────────────────────────────────────────────

function extractSlide(slideXml) {
  const lines = [];
  for (const p of chunksBetween(slideXml, 'p')) {
    const text = textOf(p, 't').join('').trim();
    if (text) lines.push(text);
  }
  return lines;
}

// ── OpenDocument ─────────────────────────────────────────────────────────

function extractOpenDocument(contentXml) {
  const lines = [];
  // Spreadsheet rows first.
  const withoutTables = contentXml.replace(/<table:table\b[\s\S]*?<\/table:table>/g, (table) => {
    for (const row of chunksBetween(table, 'table-row')) {
      const cells = chunksBetween(row, 'table-cell').map((c) => textOf(c, 'p').join(' ').trim());
      if (cells.some(Boolean)) lines.push(cells.join(','));
    }
    return '\n';
  });
  const paragraphs = [];
  for (const text of textOf(withoutTables, 'p')) {
    const trimmed = text.trim();
    if (trimmed) paragraphs.push(trimmed);
  }
  for (const text of textOf(withoutTables, 'h')) {
    const trimmed = text.trim();
    if (trimmed) paragraphs.push(trimmed);
  }
  return [...paragraphs, ...(lines.length ? [''] : []), ...lines].join('\n');
}

// ── dispatcher ───────────────────────────────────────────────────────────

const MAX_SPREADSHEET_ROWS = 5000;

/**
 * @param {Uint8Array} bytes
 * @param {string} filename
 * @returns {Promise<{kind, text, metadata, parts}|null>}
 */
export async function extractOfficeDocument(bytes, filename = '') {
  if (!looksLikeZip(bytes)) return null;
  const entries = readCentralDirectory(bytes);
  if (!entries || !entries.length) return null;

  const has = (name) => entries.some((e) => e.name === name);
  const metadata = {};

  // Document properties routinely carry a real person's name, an internal
  // path, and the software that produced the file.
  const core = await readText(bytes, entries, 'docProps/core.xml');
  if (core) {
    const grab = (tag) => textOf(core, tag)[0]?.trim();
    Object.assign(metadata, {
      author: grab('creator'), title: grab('title'),
      lastModifiedBy: grab('lastModifiedBy'), subject: grab('subject'),
    });
  }
  const app = await readText(bytes, entries, 'docProps/app.xml');
  if (app) metadata.company = textOf(app, 'Company')[0]?.trim();

  // Word
  if (has('word/document.xml')) {
    const xml = await readText(bytes, entries, 'word/document.xml');
    if (xml === null) return null;
    let text = extractDocx(xml);
    // Comments and footnotes are where the candid remarks live.
    for (const extra of ['word/comments.xml', 'word/footnotes.xml', 'word/endnotes.xml']) {
      if (!has(extra)) continue;
      const more = await readText(bytes, entries, extra);
      if (more) {
        const lines = textOf(more, 't').map((t) => t.trim()).filter(Boolean);
        if (lines.length) text += `\n\n${lines.join('\n')}`;
      }
    }
    return { kind: 'word', text, metadata, parts: 1 };
  }

  // Excel
  if (has('xl/workbook.xml')) {
    const sharedXml = await readText(bytes, entries, 'xl/sharedStrings.xml');
    const sharedStrings = sharedXml
      ? chunksBetween(sharedXml, 'si').map((si) => decodeEntities(
          (si.match(/<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/g) || [])
            .map((t) => t.replace(/<[^>]*>/g, '')).join('')))
      : [];

    const sheets = entries
      .filter((e) => /^xl\/worksheets\/sheet\d+\.xml$/.test(e.name))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

    const blocks = [];
    let budget = MAX_SPREADSHEET_ROWS;
    for (const sheet of sheets) {
      if (budget <= 0) break;
      const xml = await readText(bytes, entries, sheet.name);
      if (!xml) continue;
      const lines = extractSheet(xml, sharedStrings, budget);
      budget -= lines.length;
      if (lines.length) blocks.push(lines.join('\n'));
    }
    return { kind: 'spreadsheet', text: blocks.join('\n\n'), metadata, parts: sheets.length };
  }

  // PowerPoint
  if (entries.some((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.name))) {
    const slides = entries
      .filter((e) => /^ppt\/(slides|notesSlides)\/(slide|notesSlide)\d+\.xml$/.test(e.name))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    const blocks = [];
    for (const slide of slides) {
      const xml = await readText(bytes, entries, slide.name);
      if (!xml) continue;
      const lines = extractSlide(xml);
      if (lines.length) blocks.push(lines.join('\n'));
    }
    return { kind: 'presentation', text: blocks.join('\n\n'), metadata, parts: blocks.length };
  }

  // OpenDocument
  if (has('content.xml')) {
    const xml = await readText(bytes, entries, 'content.xml');
    if (xml === null) return null;
    const meta = await readText(bytes, entries, 'meta.xml');
    if (meta) {
      metadata.author = metadata.author || textOf(meta, 'creator')[0]?.trim();
      metadata.title = metadata.title || textOf(meta, 'title')[0]?.trim();
    }
    const mimetype = await readText(bytes, entries, 'mimetype');
    const kind = /spreadsheet/.test(mimetype || '') ? 'spreadsheet'
      : /presentation/.test(mimetype || '') ? 'presentation' : 'word';
    return { kind, text: extractOpenDocument(xml), metadata, parts: 1 };
  }

  return null;
}

export { decodeEntities, textOf };
