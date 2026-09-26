# Architecture

## What this system is

A text classifier with three delivery surfaces and one hard constraint: it must
never transmit what it inspects.

Everything below follows from that constraint. It is why there is no server, no
bundler, no telemetry and no network permission — and why the pieces are
arranged so that adding any of those would require a visible, reviewable change
rather than a quiet one.

## Context

```
         ┌─────────────────────────────────────────────┐
         │                  a person                   │
         │  pasting config into a chat box at 11pm     │
         └───────┬───────────────────────┬─────────────┘
                 │                       │
        paste / Enter                  git commit
                 │                       │
         ┌───────▼────────┐      ┌───────▼────────┐
         │ browser        │      │ CLI            │
         │ extension      │      │ bin/chhanni.js │
         └───────┬────────┘      └───────┬────────┘
                 │                       │
                 └───────┬───────────────┘
                         │
                 ┌───────▼────────┐
                 │  the engine    │   pure, synchronous, dependency-free
                 │  src/*.js      │   no I/O of any kind
                 └────────────────┘

         ╌╌╌╌╌╌╌╌╌╌ nothing crosses this line ╌╌╌╌╌╌╌╌╌╌
                    ↓
              LLM provider
```

The engine never learns whether it is running in a browser, a terminal or CI.
It takes a string and returns findings. That is the whole interface, and it is
what makes the same rule enforceable in a chat box, a pre-commit hook and a
build.

## Module graph

Strictly layered, no cycles. Each layer may import only from below.

```
  index.js              public surface
      │
  redact.js             placeholder substitution, reversible
      │
  detect.js             scanning, prefiltering, overlap resolution, masking
      │
  rules.js              the 102 detectors, with prefilters, categories, proofs
      │
      ├── checksums.js    Luhn, Verhoeff, mod-97, CRC32, entropy, issuer ranges
      ├── identifiers.js  national IDs, AWS account decoding
      ├── negatives.js    benign shapes: UUIDs, digests, epochs, code identifiers
      ├── context.js      business, legal, financial, health signals
      ├── injection.js    indirect prompt injection (OWASP LLM01)
      ├── managed.js      organisation policy, merged locally
      ├── composer.js     finding the composer on an unknown site
      ├── ahocorasick.js  multi-pattern prefilter automaton
      ├── sha256.js       fingerprints, synchronous, no WebCrypto
      └── profile.js      one-pass shape gate (digit/upper/alnum/base64 runs)

                          all of these import nothing at all

  ner.js                names and addresses in prose
      ├── namefeatures.js    hashed character features (shared with the trainer)
      ├── nameweights.js     21 KB int8 logistic-regression weights
      ├── commonwords.js     4,422 title-cased English words
      └── nonlatinnames.js   10,237 names in scripts that have no case

  tabular.js            bulk-record detection
  risk.js               the 0-100 exposure score
  regulations.js        finding -> GDPR / DPDP / HIPAA / PCI / SEC / SEBI

  documents.js          what is actually inside an attachment
      ├── zipreader.js    central directory, ZIP64, DecompressionStream
      ├── officedoc.js    DOCX / XLSX / PPTX / ODT / ODS / ODP
      ├── pdftext.js      content streams, ToUnicode CMaps, kerning
      └── imagemeta.js    EXIF / GPS / PNG text chunks, and stripping them
```

The document layer sits beside the engine rather than under it: nothing in
`detect.js` knows a file exists. `documents.js` turns bytes into text and the
engine scans text, which is why the same extractors serve the extension, the
CLI and the library without any of them sharing a code path.

The three leaf modules importing nothing is load-bearing, not incidental. They
are the layers that decide whether a finding is real, so they are the ones most
worth reading closely, and they must be readable without following a single
reference.

### Why negatives are their own module

`checksums.js` answers *is this arithmetically valid?* `negatives.js` answers a
different question — *is this a thing that is supposed to be in your text?* —
and the answers are independent. A git SHA is not invalid; it is simply not a
secret. Keeping them apart means a rule can consult either without inheriting
the other's assumptions, which matters because `payment_card` must consult the
issuer range but must **not** consult the repetition guard: `4242424242424242`
is a repeated pattern *and* a real card number, and an early version suppressed
it.

## The precision stack

Detection is five independent filters, not one. Each is cheap and each is
allowed to reject:

```
  candidate match
        │
   1. prefilter        does the literal even appear in the text?
        │
   2. pattern          does it have the right shape?
        │
   3. validate         does its own check digit accept it?          ← checksums.js
        │
   4. benign guard     is it a UUID / digest / epoch / placeholder? ← negatives.js
        │
   5. context          is the required nearby word present?
        │
   6. overlap          did a stronger rule already claim this span?
        │
     finding
```

Filters 3–5 are why this fires once every 247 files on 87,306 files of real
source rather than at the 25–75% precision published for regex-and-entropy
tools. No single one gets there: Luhn alone accepts roughly 1 in 10 random
numbers of the right length. It is the *compounding of independent
constraints* that does the work.

Several of those constraints exist only because the corpus in `bench/wild.js`
produced the counter-example: a decimal-point guard on `payment_card` because
the fractional part of a latitude passes Luhn, a distinct-digit floor on
`aadhaar` because a test fixture reaches for `4444-5555-6666`, an ISO country
check on `isin` because the last group of an uppercase UUID is twelve
characters. Each one names its counter-example in the source.

## The prose pass

Pattern rules cannot see "Priya Nair, 14 Koregaon Park Road". A separate pass
can, and it runs after the pattern rules so it can be told what they already
claimed:

```
  pattern findings ──┐
                     ├──▶ findAddresses(text)  ─┐
                     │                          ├──▶ findNames(text, {claimed})
                     └──────────────────────────┘
```

Order matters twice. A city inside a postal address is part of the address, not
a separate person. And a capitalised run inside an AWS key or a private-key
blob belongs to the credential — which is a real false positive the benchmark
caught, not a hypothetical.

The classifier scores F1 71.7% alone and the pipeline scores 97.2%. The design
and its limits are in [NER.md](NER.md).

## The gating stack

Three filters run before any expensive regex, all fed by **one walk of the
string**:

```
  text
   │
   ├─ Aho–Corasick  ──▶ which prefilter literals are present?      (one O(n) pass)
   ├─ shape profile ──▶ longest digit / upper / alnum / base64 run  (same pass)
   │
   ▼
  for each rule:  literal present?  AND  shape sufficient?  → run the regex
```

The shape gate is the one that was missing. Roughly twenty detectors have no
literal to filter on, because their patterns are pure shape — payment cards,
Aadhaar, CPF, IBAN, PAN, GSTIN, IMEI — and several of them are the most
expensive regexes in the ruleset. A payment card needs thirteen consecutive
digits, separators allowed; if the longest such run in the document is four,
the regex cannot match and never runs.

`base64Run` exists separately from `alnumRun` for one reason: an AWS secret key
is forty characters of base64, which includes `/` and `+`. Gating it on the
alphanumeric run discarded every real one, because the separators are *inside*
the secret.

## Prefilters

Most detectors are anchored on a literal nothing else uses — `AKIA`, `ghp_`,
`xoxb-`, `sk-ant-`. Before compiling and running a backtracking regex, the
scanner asks whether that literal appears in the text at all. On ordinary prose
the overwhelming majority of the 102 detectors are skipped outright.

The obvious implementation asks `String.includes` once per literal — around 250
full passes over the text, which dominated the scan on large pastes. The
literals are instead compiled once at module load into an **Aho–Corasick
automaton**, which answers the same question in a single O(n) pass no matter how
many literals there are. Regexes are likewise compiled once and reused with an
explicit `lastIndex` reset, rather than recompiled 94 times per scan.

Matching in the automaton is case-insensitive while the regexes are not. That
can only admit extra candidates, never discard a real one — the safe direction
for a filter.

This is purely an optimisation and must never change a result, which is not a
promise worth making without a test behind it: `test/detect.test.js` scans a set
of samples twice, once with every prefilter stripped, and asserts the findings
are identical — and separately checks the automaton returns exactly what
`includes()` would.

Measured: a 46 KB document scanned in **4.8 ms, about 9.6 MB/s**, with all 102
detectors, table detection, the prose pass *and* injection detection enabled.
The same document with *fewer* features took 11.1 ms before the automaton, the
shape gate, the compiled-regex cache and the NER tokenisation work.

One more, found by profiling rather than by reading: line numbers used to be
computed by walking the text from position zero for each finding. That is
O(n·f), which nobody notices while the largest input is a pasted paragraph and
which became 73% of the entire scan once the prose pass was allowed to run on
800 KB. One pass to collect the newline offsets and a binary search per finding
took 800 KB from 5,156 ms to 431 ms.

## Surfaces

| Surface | Entry | How it gets the engine |
|---|---|---|
| Extension — in-page | `extension/content.js` | `await import(chrome.runtime.getURL('engine/detect.js'))` |
| Extension — popup | `extension/popup.js` | direct ESM import (extension page, same origin) |
| Extension — settings | `extension/options.js` | direct ESM import |
| CLI | `bin/chhanni.js` | direct ESM import from `../src/` |
| Library | `src/index.js` | `import { scan, redact } from 'chhanni'` |

`extension/engine/` is a **copy** of `src/`, produced by
`scripts/build-extension.js` and excluded from version control. One source of
truth; the copy exists only because a Chrome extension can only load files
inside its own package.

### Why no bundler

A bundler would be one line of config and a supply chain. For a tool whose only
claim is "this does not send your secrets anywhere", the ability for a reviewer
to read the exact bytes that ship — in the same form the author wrote them —
is worth more than the convenience. There are no dependencies, no build output
to diff against source, and no post-install scripts.

The cost is real and accepted: MV3 content scripts cannot be ES modules
directly, so `content.js` is an async IIFE that dynamic-imports the engine
from a web-accessible resource.

## Data flow: the response

Everything else in this system runs before text leaves. One pass runs after it
comes back.

```
  MutationObserver on <body>
        │  debounced 1.2s — past a streaming reply's cadence
        ▼
  scan(last 12 KB of innerText, {ner: false, tables: false})
        │
        ├─ prompt injection in the reply ──▶ notice
        ├─ a critical credential echoed  ──▶ notice
        └─ otherwise                     ──▶ silence
```

A notice, not a panel: the text has already arrived, so blocking it would be
theatre. What the person can still do is not forward it. Findings are
fingerprinted so the same reply is reported once, not on every mutation.

## Data flow: attachments

The composer is not the only way a secret reaches a provider. Drops and file
pickers are intercepted in the capture phase alongside paste and submit:

```
  drop / <input type=file> change
        │
        ▼
  detach the selection      input.files = empty DataTransfer
        │                   (nothing uploads while we look)
        ▼
  for each file
        ├── > 16 MB?  ──▶ reported as not inspected, with its size
        └── bytes     ──▶ sniff() by magic number, never by extension
              │
              ├── zip   ──▶ officedoc.js  DOCX/XLSX/PPTX/ODT/ODS/ODP
              ├── pdf   ──▶ pdftext.js    content streams, ToUnicode
              ├── image ──▶ imagemeta.js  EXIF / GPS / PNG text chunks
              ├── rtf   ──▶ control words stripped
              └── text  ──▶ as-is
              │
              ▼
        status: readable | partial | metadata | opaque   ──▶ scan(text)
        │
        ▼
  panel
        ├── findings, as for a paste
        ├── "What Chhanni could not read", naming each file and why
        └── what the button will do, per file, before it does it
        │
        ▼
  rewriteMode(doc)
        ├── text     ──▶ same name, same format, redacted in place
        ├── convert  ──▶ <name>.redacted.txt, the words without the formatting
        ├── strip    ──▶ the same image with its metadata removed
        └── none     ──▶ unchanged, and the panel says so
        │
        ▼
  input.files = DataTransfer(chosen); re-dispatch change
```

Replacing the file rather than blocking the upload is the same decision as
redact-don't-block, applied one layer out: the person still gets to send their
config and still gets their answer, without the credentials in it.

The four rewrite modes exist because the honest answer differs by format. A
`.env` is its own text, so a redacted `.env` is still a `.env`. A `.docx` is a
ZIP of XML parts held together by relationship ids; substituting a placeholder
into one and re-zipping produces a file that opens differently or not at all,
so the offer is the extracted text instead and the panel says which it is
doing. An image has no text to redact but does have metadata to remove, and
`stripImageMetadata()` drops JPEG APPn segments and PNG ancillary chunks while
copying the image data through byte for byte.

The fourth mode is the important one. A file that can be neither rewritten nor
stripped is handed back unchanged, *and named* — because a screenshot nobody
could look inside must never produce the same silence as one that came back
clean.

## Data flow: paste

```
  paste event (capture phase)
        │
        ▼
  is the target editable?  ─── no ──▶ let it through
        │ yes
        ▼
  scan(clipboardText, policy)          ~0.3ms for a 2KB prompt
        │
        ├── verdict 'clean' ──────────▶ let it through, no UI
        │
        ▼
  preventDefault()  ← the secret never reaches the composer at all
        │
        ▼
  panel: grouped by severity
        │
        ├── "Redact and continue" ──▶ insert redact(text).text
        ├── "Send as-is" ───────────▶ insert text
        └── Esc / × ────────────────▶ insert nothing, back to editing
        │
        ▼
  store.record(findings, {host, action})   masked previews only
```

Preventing the default paste is the important detail. The alternative — let it
land, then clean up — means the secret briefly exists in a React state tree and
in whatever autosave the host page runs. It does not land.

## Data flow: submit

```
  keydown, Enter without Shift (capture phase)
        │
        ├── panel already open? ─────▶ the panel owns Enter; return
        ├── within the bypass window? ▶ this is our own re-dispatch; return
        │
        ▼
  scan(composerText, policy)
        │
        ├── 'clean' ─────────────────▶ let it send
        ├── mode 'warn' and verdict is only 'warn' ──▶ let it send
        │
        ▼
  preventDefault() + stopImmediatePropagation()
        │
        ▼
  panel
        │
        ├── redact ──▶ writeComposer(el, redacted); user presses Enter again
        └── send as-is ──▶ bypassUntil = now + 2s; re-dispatch Enter
```

`stopImmediatePropagation` rather than `stopPropagation`: these apps attach
several listeners to the same node, and stopping only propagation still lets
siblings on the same element fire.

The two-second bypass window is how "send as-is" avoids catching itself. It is
a timer rather than a flag because the re-dispatched event may be handled
asynchronously by the host framework.

### Writing back into a controlled composer

The single fiddliest part of the system, and the one most likely to break when
a host app updates.

| Composer | Technique | Why |
|---|---|---|
| `<textarea>` (React) | native `value` setter via `Object.getOwnPropertyDescriptor`, then a bubbling `input` event | React tracks the previous value on the DOM node; assigning `.value` directly leaves its shadow copy stale and the next keystroke restores the secret |
| `contenteditable` (ProseMirror, Lexical) | select all, `document.execCommand('insertText')` | the editor's own transaction pipeline observes this; direct DOM mutation desyncs its document model |

`execCommand` is deprecated and still the only thing these editors reliably
observe. Noted as a known future break.

### Finding the composer at all

Two places a composer hides from a content script, both confirmed in Chromium
rather than assumed:

| Where | What happens | What is done |
|---|---|---|
| Inside an **open shadow root** | the paste event is retargeted, so `e.target` is the host `<div>` and every editability test fails on it | every interception point reads `composedPath()[0]` |
| Inside an **iframe** | a top-frame-only script sees nothing at all | `all_frames` and `match_about_blank` |
| Inside a **closed shadow root** | nothing reaches it — not `composedPath`, not `innerText`, not any API an isolated world has | nothing; it is a stated limitation |

`all_frames` means the script loads in every ad slot and tracking pixel on
these pages too, so a subframe holds one idle `MutationObserver` and imports
none of the engine until something typeable appears in it.

Response scanning had the same blind spot from the other direction:
`document.body.innerText` stops at a shadow boundary, so a chat UI built on web
components would have had its entire transcript invisible. It now sweeps open
roots, capped at 20,000 nodes and 200 roots, once per debounce interval rather
than per mutation.

## Storage

Two stores, chosen for different reasons.

| Store | Holds | Why this one |
|---|---|---|
| `chrome.storage.sync` | policy: mode, disabled rules, allowlist | small, and a user wants the same settings on their other machine |
| `chrome.storage.local` | detection history, capped at 120 events | **must not sync** — even masked, a record of what you almost leaked is not something to replicate across devices |

History entries hold `label`, `severity`, the **masked** preview, a fingerprint,
host, action and timestamp. Never the secret. The fingerprint earns its place
by letting the popup say "6 distinct secrets" across 47 catches without ever
holding one.

The fingerprint is SHA-256 over a per-install random salt and the value,
truncated to 128 bits — `src/sha256.js`, synchronous and about eighty lines,
because `crypto.subtle` is async and making every finding's fingerprint a
promise would turn the whole engine async for nothing a user could see. It is
verified against `node:crypto` on 512 vectors.

It replaced a 32-bit FNV-1a hash that this document used to call "one-way".
Four billion outputs is a table anyone can build. The salt matters more than
the algorithm did: an email address has perhaps thirty bits of real entropy, so
an unsalted digest of one is recovered by trying candidates whatever the hash.
The salt is generated on first run, kept in `storage.local` and **never
synced**, so fingerprints cannot correlate a person's devices. The CLI leaves
it empty, because a build pipeline wants reproducible digests.

## Scanning cost

`scan()` is O(rules × text), plus one bounded pass for table detection and one
for line offsets. A hundred detectors over a prompt-sized string is roughly
0.3 ms for 2 KB, which is why the design can afford to be synchronous and avoid
a service worker entirely.

Above 2 MB it scans a 1.4 MB head and a 600 KB tail joined by a seam no
detector can match across, maps every offset and line number back onto the
original input, discards anything straddling the seam, and reports the size of
the gap. The previous behaviour was a prefix, which is the worst available
choice: an `.env` dump, a key block or a signature is at the end of a file far
more often than in the middle.

It runs **on paste and on Enter** — never on keystroke. Typing costs exactly
nothing. The settings playground does scan on every input, which is fine: it is
a settings page, and the responsiveness is the point.

Regexes are compiled per call (`new RegExp(rule.pattern.source, flags)`) rather
than reused. This costs a little and buys freedom from `lastIndex` leaking
between calls on global regexes — a bug class that produces intermittent misses,
which is the worst possible failure mode for this product.

## Overlap resolution

Several rules legitimately match the same span. `api_key = "sk-ant-..."` is both
an Anthropic key and a credential-shaped value; a MongoDB URL contains something
shaped like an email address.

Findings are ranked by severity, then confidence, then length, and any finding
overlapping an already-kept one is dropped. Reporting a database URL once, as a
database URL, is worth more than reporting it three ways.

## Extension points

**A new detector** — add one object to `RULES` in `src/rules.js`, put its id in
a `CATEGORIES` group, and add it to `PROOFS` if it genuinely verifies. Two tests
enforce the last two steps: an uncategorised rule would be invisible in
settings, and an unproven rule may not claim proof.

**A new site** — add the host to `host_permissions` and to the content script's
`matches`. The composer selectors are already generic enough for most apps;
`COMPOSER` in `content.js` is the list to extend if not.

**A new surface** — import `src/index.js`. The engine has no environment
assumptions.
