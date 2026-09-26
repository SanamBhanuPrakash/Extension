export { scan, summarise, mask, fingerprint, DEFAULT_POLICY, RULES, RULES_BY_ID } from './detect.js';
export { redact, redactReversible, restore } from './redact.js';
export * as checksums from './checksums.js';

// The document layer. Not imported by the engine — `scan()` takes text, and
// this is what turns an attachment into text — so it is exported separately
// and costs nothing to anyone who only wants the scanner.
export { extractDocument, sniff, describeKind, rewriteMode, rewriteBytes } from './documents.js';
export { readImageMetadata, describeImageMetadata, stripImageMetadata, canStripMetadata } from './imagemeta.js';
export { sha256, sha256hex } from './sha256.js';
