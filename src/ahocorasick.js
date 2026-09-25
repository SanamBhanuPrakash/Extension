/**
 * Aho–Corasick multi-pattern search.
 *
 * The prefilter asks one question — which of these ~250 literals appear in the
 * text? — and the obvious implementation answers it with 250 calls to
 * `String.includes`, each a full pass. That is O(250n) and it dominated the
 * scan on large pastes.
 *
 * Aho–Corasick answers the same question in a single O(n) pass, regardless of
 * how many literals there are. The automaton is built once at module load from
 * the ruleset and reused for every scan, so the build cost is paid at import
 * and never again.
 *
 * Matching is over lowercased text with lowercased literals: a prefilter only
 * decides whether to run a regex, and the regex does the real, case-sensitive
 * work. Being case-insensitive here can only admit extra candidates, never
 * discard a real one — the safe direction for a filter.
 */

export function build(patterns) {
  // Goto: array of Maps, node -> char -> node. Node 0 is the root.
  const next = [new Map()];
  const out = [new Set()];
  const fail = [0];

  patterns.forEach((pattern, id) => {
    const p = pattern.toLowerCase();
    if (!p) return;
    let node = 0;
    for (const ch of p) {
      let child = next[node].get(ch);
      if (child === undefined) {
        child = next.length;
        next.push(new Map());
        out.push(new Set());
        fail.push(0);
        next[node].set(ch, child);
      }
      node = child;
    }
    out[node].add(id);
  });

  // Failure links, breadth-first.
  const queue = [];
  for (const child of next[0].values()) { fail[child] = 0; queue.push(child); }
  for (let head = 0; head < queue.length; head++) {
    const node = queue[head];
    for (const [ch, child] of next[node]) {
      let f = fail[node];
      while (f !== 0 && !next[f].has(ch)) f = fail[f];
      fail[child] = next[f].has(ch) && next[f].get(ch) !== child ? next[f].get(ch) : 0;
      // Outputs are inherited along the failure link, so a match is reported
      // for every suffix that is also a pattern.
      for (const id of out[fail[child]]) out[child].add(id);
      queue.push(child);
    }
  }

  return { next, out, fail, size: next.length };
}

/**
 * One pass. Returns the set of pattern ids present in `text`.
 * @param {ReturnType<build>} automaton
 */
export function search(automaton, text) {
  const { next, out, fail } = automaton;
  const found = new Set();
  const lower = text.toLowerCase();
  let node = 0;
  for (let i = 0; i < lower.length; i++) {
    const ch = lower[i];
    while (node !== 0 && !next[node].has(ch)) node = fail[node];
    node = next[node].get(ch) ?? 0;
    if (out[node].size) for (const id of out[node]) found.add(id);
  }
  return found;
}
