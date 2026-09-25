/**
 * Feature extraction for the person-name classifier.
 *
 * Lives in src/ rather than in the training script on purpose: the trainer
 * imports this exact file, so train-time and inference-time features cannot
 * drift apart. Training/serving skew is the most common way a small model
 * silently stops working, and the cheapest way to prevent it is to have one
 * copy of the code.
 *
 * Features are hashed into a fixed-width vector rather than looked up in a
 * vocabulary. That fixes the memory cost, removes the need to ship a word
 * list, and lets an unseen name still produce features — which is the whole
 * point, since a gazetteer can only recognise names someone already wrote down.
 */

export const DIM = 16384;

/** FNV-1a, folded into the vector width. */
function hashIndex(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % DIM;
}

/** Collapses diacritics so "Adriána" and "Adriana" share n-grams. */
export function fold(token) {
  return token.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/**
 * Emits (index, value) pairs. Calls `emit` rather than allocating an array:
 * this runs on every capitalised token of every paste, and the allocation
 * showed up in profiling.
 */
export function features(token, emit) {
  const raw = String(token);
  const t = fold(raw).toLowerCase();
  const padded = `^${t}$`;
  const n = t.length;

  // Character n-grams, 2 to 4, over the padded form so word boundaries count.
  for (let size = 2; size <= 4; size++) {
    for (let i = 0; i + size <= padded.length; i++) {
      emit(hashIndex(`g${size}:${padded.slice(i, i + size)}`), 1);
    }
  }

  // Affixes get their own feature space: name morphology lives at the edges
  // (-son, -ova, -escu, -appa, Mc-, O'-).
  for (let k = 1; k <= 4 && k <= n; k++) {
    emit(hashIndex(`s${k}:${t.slice(-k)}`), 1);
    emit(hashIndex(`p${k}:${t.slice(0, k)}`), 1);
  }

  // Shape.
  emit(hashIndex(`len:${Math.min(n, 14)}`), 1);
  if (/['’]/.test(raw)) emit(hashIndex('has:apos'), 1);
  if (/-/.test(raw)) emit(hashIndex('has:hyphen'), 1);
  if (raw !== fold(raw)) emit(hashIndex('has:diacritic'), 1);
  if (/^[A-Z]+$/.test(raw)) emit(hashIndex('is:allcaps'), 1);

  const vowels = (t.match(/[aeiouy]/g) || []).length;
  emit(hashIndex(`vr:${Math.round((vowels / Math.max(1, n)) * 6)}`), 1);

  // Doubled letters and consonant runs separate many name families from
  // ordinary vocabulary.
  if (/(.)\1/.test(t)) emit(hashIndex('has:double'), 1);
  const maxRun = (t.match(/[^aeiouy]+/g) || ['']).reduce((m, s) => Math.max(m, s.length), 0);
  emit(hashIndex(`cc:${Math.min(maxRun, 5)}`), 1);

  emit(hashIndex('bias:1'), 1);
}

/** Dense vector, for training. */
export function vectorize(token) {
  const v = new Float32Array(DIM);
  features(token, (i, x) => { v[i] += x; });
  return v;
}
