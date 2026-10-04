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
import { readCentralDirectory, readEntry, readText, looksLikeZip, archiveBudget } from './zipreader.js';

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

/**
 * How many rows the sheet actually has, without materialising any of them.
 * Cheap on purpose: this runs on every spreadsheet, including the ones whose
 * whole point is that they are too big to read.
 */
function countRows(sheetXml) {
  let n = 0;
  const re = /<(?:\w+:)?row\b/g;
  while (re.exec(sheetXml) !== null) n++;
  return n;
}

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
/**
 * The parts of a package that carry text, and the ones that carry something
 * this cannot read.
 *
 * Reading `word/document.xml` and calling the document inspected was the gap:
 * a contract's classification marking lives in `word/header1.xml`, not in the
 * body, and so did "STRICTLY CONFIDENTIAL — Northwind / Meridian, matter
 * 2026-114" in the fixture. Headers, footers, comments, speaker notes, slide
 * masters, chart labels and OpenDocument's styles.xml are all separate parts,
 * all routinely hold the most sensitive line in the file, and none of them
 * were being opened.
 *
 * `OPAQUE_PARTS` is the other half of honesty: an embedded spreadsheet inside
 * a .docx, or an image in a slide deck, is a part that certainly may carry
 * data and certainly is not being read. Those are counted and reported rather
 * than passed over.
 */
const TEXT_PARTS = {
  word: /^word\/(document|header\d*|footer\d*|comments|commentsExtended|footnotes|endnotes)\.xml$|^word\/(charts|glossary)\/.*\.xml$/,
  spreadsheet: /^xl\/(worksheets\/sheet\d+|comments\d*|sharedStrings)\.xml$|^xl\/(charts|threadedComments|drawings)\/.*\.xml$/,
  presentation: /^ppt\/(slides|notesSlides|slideMasters|slideLayouts|comments|charts|diagrams)\/.*\.xml$/,
  opendocument: /^(content|styles|meta)\.xml$/,
};

/** Parts that may hold data and are not readable by anything here. */
const OPAQUE_PARTS = /\/(embeddings|media|oleObject)\//i;

/** Parts that are structure, not content, and are not worth reporting. */
const STRUCTURAL_PARTS = new RegExp([
  '^(\\[Content_Types\\]\\.xml|mimetype|settings\\.xml|manifest\\.rdf)$',
  '^(_rels|META-INF|docProps|customXml|Configurations2|Thumbnails)/',
  '/_rels/', '\\.rels$',
  // The manifests that say which sheets and slides exist. Structure, not
  // content: reporting them as "not inspected" is noise, and a defined name
  // in xl/workbook.xml is the one thing this gives up. LIMITATIONS says so.
  '^(xl/workbook|ppt/presentation|ppt/presProps|ppt/viewProps|ppt/tableStyles)\\.xml$',
  '^(word|xl|ppt)/(theme|printerSettings|styles|settings|fontTable|webSettings|numbering|calcChain|tables|metadata|activeX|customProperty|slideMasters/_rels|commentAuthors)',
].join('|'));

/** Every `<w:t>`-style run in a part we have no bespoke extractor for. */
function genericText(xml) {
  return textOf(xml, 't')
    .concat(textOf(xml, 'p'))
    .map((t) => decodeEntities(t.replace(/<[^>]*>/g, '')).trim())
    .filter(Boolean);
}

/**
 * Reads every text-bearing part for a kind, and inventories what it did not.
 * @returns {Promise<{blocks: string[], read: string[], skipped: string[], opaque: string[]}>}
 */
async function readParts(bytes, entries, kind, budget, extractors = {}, max = 512) {
  const pattern = TEXT_PARTS[kind];
  const blocks = [];
  const read = [];
  const skipped = [];
  const opaque = [];

  const wanted = entries
    .filter((e) => pattern.test(e.name))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

  for (const entry of wanted.slice(0, max)) {
    const xml = await readText(bytes, entries, entry.name, budget);
    if (xml === null) { skipped.push(entry.name); continue; }
    const extract = Object.entries(extractors).find(([re]) => new RegExp(re).test(entry.name));
    const lines = extract ? extract[1](xml) : genericText(xml);
    read.push(entry.name);
    if (lines && lines.length) blocks.push(Array.isArray(lines) ? lines.join('\n') : String(lines));
  }
  if (wanted.length > max) skipped.push(`${wanted.length - max} more parts`);

  for (const entry of entries) {
    if (pattern.test(entry.name) || STRUCTURAL_PARTS.test(entry.name)) continue;
    if (OPAQUE_PARTS.test(entry.name)) opaque.push(entry.name);
    else if (/\.(xml|txt|csv|json)$/i.test(entry.name)) skipped.push(entry.name);
    else opaque.push(entry.name);
  }
  return { blocks, read, skipped, opaque };
}

export async function extractOfficeDocument(bytes, filename = '') {
  if (!looksLikeZip(bytes)) return null;
  const entries = readCentralDirectory(bytes);
  // One allowance for the whole package. Without it, every part gets its own
  // ceiling and four thousand parts get four thousand ceilings.
  const budget = archiveBudget();
  if (!entries || !entries.length) return null;

  const has = (name) => entries.some((e) => e.name === name);
  const metadata = {};

  // Document properties routinely carry a real person's name, an internal
  // path, and the software that produced the file.
  const core = await readText(bytes, entries, 'docProps/core.xml', budget);
  if (core) {
    const grab = (tag) => textOf(core, tag)[0]?.trim();
    Object.assign(metadata, {
      author: grab('creator'), title: grab('title'),
      lastModifiedBy: grab('lastModifiedBy'), subject: grab('subject'),
    });
  }
  const app = await readText(bytes, entries, 'docProps/app.xml', budget);
  if (app) metadata.company = textOf(app, 'Company')[0]?.trim();

  // Word. The body, and every header, footer, comment, footnote, endnote,
  // chart label and glossary entry beside it.
  if (has('word/document.xml')) {
    const got = await readParts(bytes, entries, 'word', budget, {
      '^word/document\\.xml$': (xml) => [extractDocx(xml)],
    });
    if (!got.read.length) return null;
    return { kind: 'word', text: got.blocks.join('\n\n'), metadata, parts: got.read.length, coverage: got };
  }

  // Excel
  if (has('xl/workbook.xml')) {
    const sharedXml = await readText(bytes, entries, 'xl/sharedStrings.xml', budget);
    const sharedStrings = sharedXml
      ? chunksBetween(sharedXml, 'si').map((si) => decodeEntities(
          (si.match(/<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/g) || [])
            .map((t) => t.replace(/<[^>]*>/g, '')).join('')))
      : [];

    const sheets = entries
      .filter((e) => /^xl\/worksheets\/sheet\d+\.xml$/.test(e.name))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

    // Rows left to emit, which is a different budget from the archive's
    // decompression allowance and used to share its name. Passing a row count
    // where a `{remaining}` object was expected made every spreadsheet read as
    // `opaque`: assigning a property to a number primitive throws in a module,
    // and the throw was swallowed as "could not be parsed".
    //
    // The cap also used to be silent, and that was the worse bug of the two.
    // A 50,000-row customer export came back `readable`, the table layer —
    // which only ever saw the 5,000 rows handed to it — reported "5,000
    // records", `unprocessedRows: 0` and `fullyRedactable: true`, and the
    // panel passed that on with nothing to suggest the other 45,000 existed.
    // Worse, "attach a redacted copy" then wrote a file containing a tenth of
    // the spreadsheet. Everything downstream is built to report what was not
    // inspected; it cannot do that about a truncation it was never told about,
    // so the count travels with the text.
    let rowsLeft = MAX_SPREADSHEET_ROWS;
    let rowsRead = 0;
    let rowsTotal = 0;
    const got = await readParts(bytes, entries, 'spreadsheet', budget, {
      '^xl/worksheets/sheet\\d+\\.xml$': (xml) => {
        rowsTotal += countRows(xml);
        if (rowsLeft <= 0) return [];
        const lines = extractSheet(xml, sharedStrings, rowsLeft);
        rowsLeft -= lines.length;
        rowsRead += lines.length;
        return lines;
      },
      // Already consumed above; reading it again would duplicate every string.
      '^xl/sharedStrings\\.xml$': () => [],
    });
    const unreadRows = Math.max(0, rowsTotal - rowsRead);
    if (unreadRows > 0) {
      // Goes into `skipped`, which is what makes documents.js call the whole
      // file `partial` rather than `readable` and name the gap in the panel.
      got.skipped.push(`${unreadRows.toLocaleString()} further rows (Chhanni reads ${MAX_SPREADSHEET_ROWS.toLocaleString()} per spreadsheet)`);
    }
    return {
      kind: 'spreadsheet', text: got.blocks.join('\n\n'), metadata,
      parts: sheets.length, coverage: got,
      rows: { read: rowsRead, total: rowsTotal, truncated: unreadRows > 0 },
    };
  }

  // PowerPoint
  if (entries.some((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.name))) {
    // Slides and speaker notes, and now masters, layouts, comments, chart
    // labels and SmartArt too — a template's footer is on the master, and a
    // reviewer's comment is nowhere near the slide it is about.
    const got = await readParts(bytes, entries, 'presentation', budget, {
      '^ppt/(slides|notesSlides)/': (xml) => extractSlide(xml),
    });
    return {
      kind: 'presentation', text: got.blocks.join('\n\n'), metadata,
      parts: got.read.length, coverage: got,
    };
  }

  // OpenDocument
  if (has('content.xml')) {
    const xml = await readText(bytes, entries, 'content.xml', budget);
    if (xml === null) return null;
    const meta = await readText(bytes, entries, 'meta.xml', budget);
    if (meta) {
      metadata.author = metadata.author || textOf(meta, 'creator')[0]?.trim();
      metadata.title = metadata.title || textOf(meta, 'title')[0]?.trim();
    }
    const mimetype = await readText(bytes, entries, 'mimetype', budget);
    const kind = /spreadsheet/.test(mimetype || '') ? 'spreadsheet'
      : /presentation/.test(mimetype || '') ? 'presentation' : 'word';
    // styles.xml is where OpenDocument keeps headers and footers, which is
    // where a marking goes.
    const got = await readParts(bytes, entries, 'opendocument', budget, {
      '^content\\.xml$': (x) => [extractOpenDocument(x)],
      '^meta\\.xml$': () => [],
    });
    return { kind, text: got.blocks.join('\n\n'), metadata, parts: got.read.length, coverage: got };
  }

  return null;
}

export { decodeEntities, textOf };
