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
  rules.js              the 92 detectors, with prefilters, categories, proofs
      │
      ├── checksums.js    Luhn, Verhoeff, mod-97, CRC32, entropy, issuer ranges
      ├── identifiers.js  national IDs, AWS account decoding
      └── negatives.js    benign shapes: UUIDs, digests, epochs, placeholders

                          all three import nothing at all
```

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

Filters 3–5 are why the measured precision is 99.88% rather than the 25–75%
published for regex-and-entropy tools. No single one gets there: Luhn alone
accepts roughly 1 in 10 random numbers of the right length. It is the
*compounding of independent constraints* that does the work.

## Prefilters

Most detectors are anchored on a literal nothing else uses — `AKIA`, `ghp_`,
`xoxb-`, `sk-ant-`. Before compiling and running a backtracking regex, the
scanner asks whether that literal appears in the text at all. On ordinary prose
the overwhelming majority of the 92 detectors are skipped outright.

This is purely an optimisation and must never change a result, which is not a
promise worth making without a test behind it: `test/detect.test.js` scans a set
of samples twice, once with every prefilter stripped, and asserts the findings
are identical.

Measured: a 46 KB document scanned in ~5.8ms, about 8 MB/s, with all 92
detectors enabled — table detection included.

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
        ├── binary, or > 4 MB?  ──▶ skipped, reported as skipped
        └── text-like           ──▶ file.text() → scan()
        │
        ▼
  panel
        ├── "Attach redacted copies" ──▶ new File([redacted], same name, same type)
        ├── "Attach as-is"           ──▶ original files restored
        └── dismiss                  ──▶ selection cleared
        │
        ▼
  input.files = DataTransfer(chosen); re-dispatch change
```

Replacing the file rather than blocking the upload is the same decision as
redact-don't-block, applied one layer out: the person still gets to send their
config and still gets their answer, without the credentials in it.

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

## Storage

Two stores, chosen for different reasons.

| Store | Holds | Why this one |
|---|---|---|
| `chrome.storage.sync` | policy: mode, disabled rules, allowlist | small, and a user wants the same settings on their other machine |
| `chrome.storage.local` | detection history, capped at 120 events | **must not sync** — even masked, a record of what you almost leaked is not something to replicate across devices |

History entries hold `label`, `severity`, the **masked** preview, a **one-way**
FNV-1a fingerprint, host, action and timestamp. Never the secret. The
fingerprint earns its place by letting the popup say "6 distinct secrets"
across 47 catches without ever holding one.

## Scanning cost

`scan()` is O(rules x text), plus one bounded pass for table detection. Ninety-two detectors over a prompt-sized string is
roughly 0.3ms for 2KB, which is why the design can afford to be synchronous and
avoid a service worker entirely.

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
