/**
 * Deterministic byte mutation, for hostile-input testing.
 *
 * Chhanni became a parser engine without becoming a parser *project*: it now
 * reads ZIP central directories, OOXML, PDF content streams, TIFF IFDs and PNG
 * chunks, all from attacker-supplied bytes, and until this file existed none of
 * that had ever been handed anything malformed.
 *
 * Every mutation here is seeded, so a failure reproduces exactly from the seed
 * printed with it. The mutators are chosen to break the specific things these
 * parsers trust: length fields, offsets, counts, magic numbers and the
 * assumption that a structure is complete.
 */

/** mulberry32 — small, fast, and identical on every machine. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (r, list) => list[Math.floor(r() * list.length)];

/**
 * Values a length or count field takes when someone is trying to make a parser
 * allocate. Includes the boundaries this codebase's own limits sit on.
 */
const HOSTILE_NUMBERS = [
  0, 1, 0x7f, 0x80, 0xff, 0x100, 0xffff, 0x10000,
  0x7fffffff, 0x80000000, 0xfffffffe, 0xffffffff,
];

export const MUTATORS = {
  /** A single bit, anywhere. The cheapest way to find a missing bounds check. */
  bitflip(bytes, r) {
    const out = bytes.slice();
    if (!out.length) return out;
    const at = Math.floor(r() * out.length);
    out[at] ^= 1 << Math.floor(r() * 8);
    return out;
  },

  /** Truncation. Every parser that reads a header then trusts it breaks here. */
  truncate(bytes, r) {
    if (bytes.length < 2) return bytes.slice();
    return bytes.slice(0, Math.max(1, Math.floor(r() * bytes.length)));
  },

  /** A run of bytes replaced with a hostile 32-bit value, little-endian. */
  lengthField(bytes, r) {
    const out = bytes.slice();
    if (out.length < 8) return out;
    const at = Math.floor(r() * (out.length - 4));
    const value = pick(r, HOSTILE_NUMBERS);
    out[at] = value & 0xff;
    out[at + 1] = (value >>> 8) & 0xff;
    out[at + 2] = (value >>> 16) & 0xff;
    out[at + 3] = (value >>> 24) & 0xff;
    return out;
  },

  /** The same, big-endian — PNG, TIFF-MM and PDF all read this way. */
  lengthFieldBE(bytes, r) {
    const out = bytes.slice();
    if (out.length < 8) return out;
    const at = Math.floor(r() * (out.length - 4));
    const value = pick(r, HOSTILE_NUMBERS);
    out[at] = (value >>> 24) & 0xff;
    out[at + 1] = (value >>> 16) & 0xff;
    out[at + 2] = (value >>> 8) & 0xff;
    out[at + 3] = value & 0xff;
    return out;
  },

  /** A slice moved somewhere else: offsets now point into the wrong structure. */
  shuffleChunk(bytes, r) {
    const out = bytes.slice();
    if (out.length < 64) return out;
    const size = 1 + Math.floor(r() * Math.min(256, out.length / 4));
    const from = Math.floor(r() * (out.length - size));
    const to = Math.floor(r() * (out.length - size));
    const piece = out.slice(from, from + size);
    out.set(piece, to);
    return out;
  },

  /** A run of zeroes, which is what a half-written file looks like. */
  zeroRun(bytes, r) {
    const out = bytes.slice();
    if (out.length < 16) return out;
    const size = 1 + Math.floor(r() * Math.min(512, out.length / 2));
    const at = Math.floor(r() * (out.length - size));
    out.fill(0, at, at + size);
    return out;
  },

  /** Repeat the whole file. Containers that scan for markers see two of each. */
  duplicate(bytes) {
    const out = new Uint8Array(bytes.length * 2);
    out.set(bytes, 0);
    out.set(bytes, bytes.length);
    return out;
  },

  /** Structural bytes sprayed in: `<<`, `stream`, `PK`, `endstream`, `<w:t>`. */
  injectMarkers(bytes, r) {
    const markers = [
      'stream', 'endstream', '<<', '>>', 'PK\u0003\u0004', 'PK\u0001\u0002',
      'PK\u0005\u0006', '<w:t>', '</w:t>', 'Exif\u0000\u0000', 'IEND', 'tEXt',
    ];
    const text = pick(r, markers);
    const add = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) add[i] = text.charCodeAt(i) & 0xff;
    const out = new Uint8Array(bytes.length + add.length);
    const at = Math.floor(r() * bytes.length);
    out.set(bytes.subarray(0, at), 0);
    out.set(add, at);
    out.set(bytes.subarray(at), at + add.length);
    return out;
  },
};

export const MUTATOR_NAMES = Object.keys(MUTATORS);

/**
 * One to four chained mutations of `bytes`, deterministic in `seed`.
 *
 * Chaining matters more than it looks. A single bit flip usually leaves a
 * container structurally intact enough that the parser rejects it at the first
 * check; it is the second and third mutation — a corrupted length *and* a
 * moved chunk — that reaches code paths the first one only opened.
 *
 * @returns {{bytes: Uint8Array, mutator: string}}
 */
export function mutate(bytes, seed) {
  const r = rng(seed);
  const rounds = 1 + Math.floor(r() * 4);
  const applied = [];
  let out = bytes;
  for (let i = 0; i < rounds; i++) {
    const name = MUTATOR_NAMES[Math.floor(r() * MUTATOR_NAMES.length)];
    applied.push(name);
    out = MUTATORS[name](out, r);
    // A chain of `duplicate` would grow without bound; this is a fuzzer, not
    // a memory test of the harness itself.
    if (out.length > 8 * 1024 * 1024) break;
  }
  return { bytes: out, mutator: applied.join('+') };
}
