/**
 * What is actually inside an attachment.
 *
 * Routing is by content, not by filename. An extension is a claim the file
 * makes about itself, and a `.txt` that is really a ZIP, or a `.jpg` that is
 * really a PDF, is exactly the case where being wrong matters. Every format
 * below is identified by its magic bytes.
 *
 * Four outcomes, and the fourth is the one most tools get wrong:
 *
 *   readable  — text was extracted and has been scanned
 *   partial   — some text was extracted; some of the file could not be read
 *   metadata  — no text, but the file gave away something anyway (EXIF, GPS)
 *   opaque    — nothing could be read, and the user is told so plainly
 *
 * Silence is not an outcome. A screenshot that cannot be read must not look
 * the same as a screenshot that was read and found clean.
 */
import { extractOfficeDocument } from './officedoc.js';
import { extractPdfText, looksLikePdf } from './pdftext.js';
import { readImageMetadata, describeImageMetadata, sniffImage,
         stripImageMetadata, canStripMetadata } from './imagemeta.js';
import { looksLikeZip } from './zipreader.js';

const latin1 = new TextDecoder('latin1');

/** Identified by content. The filename is only used to name the file back. */
export function sniff(bytes, filename = '') {
  if (!bytes || bytes.length < 4) return 'empty';
  if (looksLikePdf(bytes)) return 'pdf';

  // OLE2 compound file: legacy .doc/.xls/.ppt and .msg.
  if (bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) return 'ole2';

  const image = sniffImage(bytes);
  if (image) return `image/${image}`;

  if (looksLikeZip(bytes)) return 'zip';

  const head = latin1.decode(bytes.subarray(0, Math.min(bytes.length, 512)));
  if (head.startsWith('{\\rtf')) return 'rtf';
  if (/^(%!PS|\x04%!)/.test(head)) return 'postscript';

  // Binary if it contains NULs in the first kilobyte.
  for (let i = 0; i < Math.min(bytes.length, 1024); i++) if (bytes[i] === 0) return 'binary';
  return 'text';
}

/** RTF is text with control words; stripping them is enough to scan it. */
function extractRtf(text) {
  return text
    .replace(/\\'([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\u(-?\d+)\s?\??/g, (_, code) => String.fromCharCode(Number(code) & 0xffff))
    .replace(/\{\\\*[\s\S]*?\}/g, ' ')
    .replace(/\\par[d]?\b/g, '\n')
    .replace(/\\tab\b/g, '\t')
    .replace(/\\[a-zA-Z]+-?\d*\s?/g, '')
    .replace(/[{}]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const FRIENDLY = {
  pdf: 'PDF', zip: 'archive', ole2: 'legacy Office document', rtf: 'RTF document',
  'image/jpeg': 'JPEG image', 'image/png': 'PNG image', 'image/gif': 'GIF image',
  'image/webp': 'WebP image', 'image/heic': 'HEIC image', 'image/avif': 'AVIF image',
  binary: 'binary file', text: 'text file', postscript: 'PostScript file', empty: 'empty file',
};

/**
 * @param {Uint8Array} bytes
 * @param {string} filename
 * @returns {Promise<{status, kind, text, metadata, note, reason}>}
 */
export async function extractDocument(bytes, filename = '') {
  const kind = sniff(bytes, filename);
  const name = FRIENDLY[kind] || kind;
  const base = { kind, text: '', metadata: {}, note: null, reason: null };

  try {
    if (kind === 'pdf') {
      const pdf = await extractPdfText(bytes);
      if (!pdf) return { ...base, status: 'opaque', reason: 'This PDF could not be parsed.' };
      const meta = pdf.metadata || {};
      const metaText = [meta.author, meta.title, meta.subject, meta.keywords]
        .filter(Boolean).join('\n');
      if (pdf.scanned) {
        return {
          ...base,
          status: metaText ? 'metadata' : 'opaque',
          text: metaText,
          metadata: meta,
          reason: 'This PDF is a scan — its pages are images, so there is no text to read. Chhanni does not do OCR.',
          note: meta.author ? `Its properties name ${meta.author}.` : null,
        };
      }
      return {
        ...base,
        status: 'readable',
        text: metaText ? `${metaText}\n\n${pdf.text}` : pdf.text,
        metadata: meta,
        note: `${pdf.pages} page${pdf.pages === 1 ? '' : 's'} read.`,
      };
    }

    if (kind === 'zip') {
      const office = await extractOfficeDocument(bytes, filename);
      if (office) {
        const meta = office.metadata || {};
        const metaText = [meta.author, meta.title, meta.lastModifiedBy, meta.company]
          .filter(Boolean).join('\n');
        return {
          ...base,
          kind: office.kind,
          status: 'readable',
          text: metaText ? `${metaText}\n\n${office.text}` : office.text,
          metadata: meta,
          note: meta.author ? `Document properties name ${meta.author}.` : null,
        };
      }
      return {
        ...base,
        status: 'opaque',
        reason: 'This is an archive. Chhanni does not open archives to inspect what is inside.',
      };
    }

    if (kind === 'ole2') {
      return {
        ...base,
        status: 'opaque',
        reason: 'This is a pre-2007 Office file (.doc, .xls, .ppt). Its format is a binary container Chhanni does not read. Saving it as .docx, .xlsx or .pptx makes it readable.',
      };
    }

    if (kind === 'rtf') {
      return { ...base, status: 'readable', text: extractRtf(latin1.decode(bytes)) };
    }

    if (kind.startsWith('image/')) {
      const image = readImageMetadata(bytes);
      const summary = describeImageMetadata(image);
      const values = Object.values(image?.metadata || {}).filter((v) => typeof v === 'string');
      const gps = image?.gps ? `${image.gps.lat}, ${image.gps.lon}` : null;
      return {
        ...base,
        status: summary ? 'metadata' : 'opaque',
        // The metadata itself is scanned: an Artist field is a person's name.
        text: [gps, ...values].filter(Boolean).join('\n'),
        metadata: image?.metadata || {},
        gps: image?.gps || null,
        strippable: summary ? canStripMetadata(bytes) : false,
        note: summary,
        reason: `Chhanni reads ${name} metadata but not the pixels — there is no OCR, so text inside the image is not seen. Check it yourself before sending.`,
      };
    }

    if (kind === 'text') {
      return { ...base, status: 'readable', text: new TextDecoder('utf-8').decode(bytes) };
    }

    return {
      ...base,
      status: 'opaque',
      reason: `Chhanni does not read ${name}s.`,
    };
  } catch (err) {
    return { ...base, status: 'opaque', reason: `This file could not be read (${String(err && err.message).slice(0, 80)}).` };
  }
}

/** Human label for a sniffed kind. */
export function describeKind(kind) {
  return FRIENDLY[kind] || kind;
}

// ────────────────────────────────────────────────── handing the file back
//
// Warning is the easy half. The half that decides whether anyone keeps the
// extension installed is being able to hand back a file they can still send.
//
// Four honest outcomes, and the difference between them is which one the
// button promises:
//
//   text     the file's bytes *are* its text, so a redacted .env is a .env
//   convert  text came out of a container we do not rebuild; the redacted
//            text can go instead, as a .txt, and the person is told that the
//            formatting does not survive
//   strip    there is no text to redact, but the metadata can be removed and
//            the image itself comes back byte-for-byte decodable
//   none     nothing can be done to this file, and saying so is the feature
//
// Rewriting a .docx in place was considered and rejected. It is a ZIP of XML
// parts held together by relationship ids, with styles, revision history and
// a content-types manifest; substituting a placeholder into one part and
// re-zipping produces a file that opens differently or does not open. A tool
// that silently damages the attachment is worse than one that says what it
// can do.

const REWRITE_IN_PLACE = new Set(['text', 'rtf']);
const CONTAINERS = new Set(['word', 'spreadsheet', 'presentation', 'pdf']);

/**
 * @param {{status: string, kind: string, text: string, strippable?: boolean}} doc
 * @returns {{mode: 'text'|'convert'|'strip'|'none', suffix?: string, explain: string}}
 */
export function rewriteMode(doc) {
  if (!doc) return { mode: 'none', explain: 'This file was not read.' };
  if (REWRITE_IN_PLACE.has(doc.kind) && doc.text) {
    return { mode: 'text', explain: 'replaced in place, same name and format' };
  }
  if (CONTAINERS.has(doc.kind) && doc.status === 'readable' && doc.text) {
    return {
      mode: 'convert', suffix: '.redacted.txt',
      explain: 'attached as text instead \u2014 the words survive, the formatting does not',
    };
  }
  if (doc.strippable) {
    return { mode: 'strip', explain: 'same image, with its metadata removed' };
  }
  return { mode: 'none', explain: 'cannot be rewritten, so it would be attached unchanged' };
}

/**
 * The bytes to attach in place of the original.
 *
 * @param {Uint8Array} bytes original file
 * @param {object} doc result of extractDocument
 * @param {string} redactedText the extracted text with findings replaced
 * @returns {{bytes: Uint8Array|string, name: (n: string) => string}|null}
 */
export function rewriteBytes(bytes, doc, redactedText) {
  const plan = rewriteMode(doc);
  if (plan.mode === 'text') return { bytes: redactedText, name: (n) => n };
  if (plan.mode === 'convert') {
    return { bytes: redactedText, name: (n) => `${n}${plan.suffix}` };
  }
  if (plan.mode === 'strip') {
    const stripped = stripImageMetadata(bytes);
    return stripped ? { bytes: stripped.bytes, name: (n) => n, removed: stripped.removed } : null;
  }
  return null;
}
