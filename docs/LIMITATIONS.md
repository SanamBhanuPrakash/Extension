# What Chhanni does not do

Every security tool has a boundary. Most of them are vague about where it is,
which is how a tool that catches 60% of leaks gets installed by someone who
believes it catches all of them — and who then pastes the other 40% with more
confidence than they had before it was installed.

This document is the boundary, written down. It exists because a gap analysis
of this repository produced roughly a hundred separate concerns, and the
choice was between answering them one by one in a file anyone can read, or
letting them sit unanswered in a chat log. Everything below is either fixed
and says how, or unfixed and says why.

The one-line version:

> **Chhanni is a local guardrail that reduces accidental disclosure to AI
> tools. It is not a DLP platform, it does not enforce anything, and it cannot
> read a screenshot.**

---

## 1. Files

### What it reads now

| | |
|---|---|
| **DOCX, XLSX, PPTX** | Unzipped and parsed in the page. Tables and sheets become comma-separated lines so the bulk-record detector sees a spreadsheet as one disclosure of *n* rows rather than *n×m* separate findings. Document properties (`core.xml`) are read too, because an Author field is a person's name. |
| **ODT, ODS, ODP** | Same path; OpenDocument is also ZIP + XML. |
| **PDF** | Content streams inflated, `ToUnicode` CMaps applied, `TJ` kerning below −120 read as a space. Every `stream…endstream` block is scanned rather than the cross-reference table walked, so a linearised, incrementally-updated or slightly damaged PDF still yields its text. |
| **RTF** | Control words stripped. |
| **JPEG, PNG, HEIC, AVIF, WebP, GIF** | Metadata only. EXIF TIFF IFDs, GPS (converted to decimal degrees), Artist, Copyright, Owner, camera make/model/serial, software, capture time; PNG `tEXt`/`iTXt` chunks. |
| **Anything else** | Identified by magic bytes and named. |

No dependencies were added for any of it. `DecompressionStream` is in every
browser and in Node, and it does both `deflate-raw` (ZIP) and `deflate`
(PDF `FlateDecode`).

### There is no OCR, and there will not be

Text that exists only as pixels is not read. A screenshot of a dashboard, a
photographed whiteboard, a scanned contract: Chhanni cannot see any of it.

This is a decision, not an omission. Tesseract's WASM build plus one language
model is several megabytes. Bundling it would roughly triple the package and
invite the "what is this obfuscated blob" question at store review; fetching
it on demand would break the only promise this project makes, which is that it
never touches the network. Neither trade is worth it.

So instead:

- a scanned PDF is reported as `scanned`, by name, with the reason;
- an image's metadata **is** read, and a photograph's GPS block is a real leak
  that OCR would not have found either;
- and for JPEG and PNG, the warning comes with a fix — `stripImageMetadata()`
  drops APPn segments and ancillary chunks and copies the image data through
  untouched. The fixture photograph decodes as 16×16 before and after in
  Chromium's own decoder, 572 bytes → 333, EXIF gone. `chhanni strip` does the
  same from the command line.

WebP, HEIC, AVIF and GIF interleave metadata with image data; a half-correct
rewrite is worse than an honest no, so they are read and not rewritten.

### Redaction cannot always give you the file back

A `.env` is its own text, so a redacted `.env` is still a `.env`.

A `.docx` is a ZIP of XML parts held together by relationship ids, with styles,
a content-types manifest and often revision history. Writing a placeholder into
one part and re-zipping produces a file that opens differently, or does not
open. Chhanni does not attempt it. What it offers instead is the extracted
text, redacted, as a `.txt` beside the original name — and the panel says so,
per file, before you press the button.

An image with metadata is handed back as the same image without it. A file
that can be neither rewritten nor stripped is handed back unchanged, and the
panel says that too.

### Size

16 MB per attachment in the page; above that the file is reported as not
inspected, with its size. Inside that: 32 MB per ZIP entry, 4,096 entries,
24 MB per PDF, 600 content streams, 5,000 spreadsheet rows. Every one of these
is a ceiling that trades completeness for never hanging the tab someone is
working in.

### Formats that are not read

Legacy `.doc`, `.xls`, `.ppt` and `.msg` are OLE2 compound files — a different
binary container. They are identified and named, with the suggestion that
saving as `.docx` makes them readable. General archives (`.zip`, `.tar.gz`) are
not opened. Neither is anything inside an encrypted container.

---

## 2. Secrets and identifiers

### Novel formats

Until recently every detector was anchored on a literal (`AKIA`, `ghp_`,
`xoxb-`) or on a credential word within reach. A token in a format that did not
exist when this shipped, pasted on its own with nothing around it to say what
it is, matched nothing.

`unlabelled_secret` closes that. It requires all three character classes,
Shannon entropy ≥ 4.2, at least 0.3 character-class transitions per character,
fewer than 0.04 four-letter lowercase runs per character, and that the value
stands alone on its line or on the right of an assignment. It excludes
digests, UUIDs, SSH public keys, file paths, hyphen-grouped identifiers, PEM
bodies, subresource-integrity hashes, Go module checksums, and base64 that
decodes to valid UTF-8 text.

Tuned against 87,306 real source files, not against intuition: 5,064 findings
on the first draft, 234 on the last, in 18 files.

It is `medium`, never `critical`. The honest statement is *this looks like a
key and nothing here says what it is*, and that is a question for you.

### A check digit can never reach zero false positives

Verhoeff accepts about one random twelve-digit number in ten. Luhn accepts
about one in ten of the right length. That is arithmetic, not a bug, and it is
why the identifier detectors carry structural and contextual guards on top —
distinct-digit floors, compound-token guards, decimal-point guards, issuer
ranges, ISO country codes. See `src/rules.js`; each guard names the real file
that produced the false positive it exists to stop.

### Precision and recall are a trade, permanently

Tightening a detector to remove a false positive can remove a true one. Every
such change in this repository is pinned by a test carrying both: the real
line from the wild that must not fire, and the real value that must.

---

## 3. Names and addresses

`src/ner.js` is a logistic model over hashed character n-grams plus a log-odds
combination of contextual signals, with a gazetteer for scripts that have no
case distinction. `docs/NER.md` has the method.

What it cannot do:

- **Resolve person/place/company ambiguity in general.** "Austin", "Paris",
  "Virginia", "Park" and "Baker" are people and not-people, and character
  evidence cannot settle it. Context decides, and context is sometimes absent.
- **Coreference.** "She said she would send it" is not connected to the name
  three sentences earlier.
- **Generalise a gazetteer.** Arabic, Hebrew, Devanagari, Thai, Han, Hangul,
  kana, Bengali, Tamil and Telugu names are matched against a list of 10,237.
  A name not on that list, in a script with no case distinction, is not found.
- **Cover every language equally.** The measured figures are for the 34
  annotated documents in `bench/ner-corpus.js`, across eight scripts. That is
  not a claim about all languages, and it should not be read as one.

Measured: names precision 97.8%, recall 100%, F1 98.9%. Addresses 100/100.

---

## 4. Where it runs

### The list is finite

Chhanni ships with 23 AI sites in its manifest. On anything else it is inert —
including on whatever your organisation self-hosts, which is often exactly
where the sensitive prompts go.

The popup now states which of three states the current tab is in, reading the
list from the manifest rather than from a second copy that can drift. Where a
site is not covered, it offers to cover it: "Watch this site too" requests the
origin and registers the same content script, persisted across sessions.

### The list will go stale

A new AI product ships every week. Composer detection is by shape rather than
by hostname, which helps once the script is running, but the script only runs
where it has permission. This is a maintenance problem with no clean solution
short of requesting `https://*/*` up front, which is a permission this project
will not ask for by default.

### Shadow DOM and frames

A paste event crossing an open shadow boundary is retargeted, so `e.target` is
the host element and every editability test fails on it. Every interception
point now reads `composedPath()[0]` instead. Response scanning sweeps open
shadow roots, because `innerText` stops at the boundary — measured in Chromium,
not assumed.

`all_frames` and `match_about_blank` are on, so a composer inside an iframe is
covered. A subframe holds one idle `MutationObserver` and imports nothing until
something typeable appears in it, so an ad slot costs almost nothing.

**Closed shadow roots are not reachable.** Not by `composedPath`, not by
`innerText`, not by any API available to an extension's isolated world. A
composer inside one is invisible to Chhanni. That is the platform, not a bug to
fix.

### Sites change

ChatGPT, Claude, Gemini and the rest change their front ends frequently.
Interception, composer detection, text insertion, attachment handling and
response reading can all break without a line of Chhanni changing. React-
controlled textareas and ProseMirror editors have specific handling, and that
handling depends on those libraries' behaviour continuing to be what it is.

---

## 5. Limits that create blind spots

| Limit | Value | What it costs |
|---|---|---|
| Bytes examined | 2 MB | A 1.4 MB head and a 600 KB tail. What falls between is reported by size in the panel. |
| Matches per rule | 500 | A pathological input cannot spin. |
| Findings per scan | 2,000 | Past this the reader learns nothing further. |
| Name/address pass | 800 KB | A larger paste gets credential and pattern scanning without the prose pass. |
| Table rows | 2,000 processed, 5,000 read | Column inference is from a sample; an unusual value late in a very large table may not be represented. |
| Response tail | 12,000 characters | Only the most recent stretch of the transcript. |

The truncation strategy used to be a prefix. An `.env` dump, a key block or a
signature is at the *end* of a file far more often than in the middle, so a
prefix reliably missed the part that mattered. Head-and-tail is a better trade,
not a fix: the middle of a very large paste is genuinely not read, and the
panel says how much.

---

## 6. False positives, and the cost of them

A tool that fires constantly gets uninstalled in a week, whatever its benchmark
says. So the benchmark measures the thing that actually decides that:

**337 alarms across 87,306 real source files — one every 259 files, 0.39%.**

Not findings; alarms. A file full of example email addresses produces findings
and no alarm, because `low` on its own is not a reason to interrupt anybody.
`node bench/wild.js <dir>` reproduces it.

Every false-positive class that measurement found is fixed and pinned by a test
using the exact string from the wild. Two of them were internationalisation
bugs: U+200B is Khmer's word separator (and Thai's, Lao's, Myanmar's,
Tibetan's), and bidirectional isolates are how a Latin placeholder sits inside
an Arabic-script sentence. Both were being read as attacks. Neither would have
been found by thinking about it.

---

## 7. What the benchmarks do not prove

**The generated corpus is self-authored.** 4,244 cases over ten seeds,
precision and recall both 100%. That number is exactly the one you should
distrust: a rule that is wrong in a way its author did not think to test scores
perfectly. It is published because it is reproducible (`node bench/run.js`),
not because it settles anything.

**SecretBench and FPSecretBench cannot be run here.** Both require a signed
data-protection agreement and BigQuery access. `bench/secretbench.js` is
written and waiting; until someone runs it, the independent validation this
project needs does not exist. See `docs/BENCHMARK.md`.

**The wild corpus is source code.** Fifteen large public repositories are not a
sample of what people paste into AI tools. Real prompts contain more prose,
more spreadsheets and more documents, and nobody has published a corpus of
them.

**There is no telemetry, by design.** Which means there is no measurement of
real-world false positives or negatives, and there will not be unless someone
reports them. That is a real cost of the privacy position, and it is the right
trade, but it is a cost.

---

## 8. Fingerprints

`fingerprint()` is SHA-256 over a per-install random salt and the value,
truncated to 128 bits. It used to be a 32-bit FNV-1a hash described in the
documentation as "a one-way hash" — four billion outputs is a table anyone can
build, and a chosen collision was trivial.

The salt matters more than the hash upgrade did. An email address has perhaps
thirty bits of real entropy, so an *unsalted* digest of one is recovered by
trying candidates whatever the algorithm. With a per-install random salt kept
in local storage and never synced, there is no shared table to build and no
correlation across devices.

The CLI leaves the salt empty on purpose, because a build pipeline wants the
same value to fingerprint the same way on every machine. That is a deliberate
trade.

What a fingerprint is **not**: a secret. Local history also stores a masked
preview that keeps the first and last few characters — you have to be able to
recognise your own key — plus the hostname and the timestamp. The store is
designed so that a leak of it is not a leak of your credentials. It is not
designed to survive an attacker who already has your browser profile, and
neither is anything else in that profile.

---

## 9. Prompt injection

`src/injection.js` is lexical and heuristic. It looks for instructions
addressed to an assistant, exfiltration requests with a real destination, tool
abuse, markdown image exfiltration, CSS-hidden text, Unicode tag characters and
bidi overrides.

A sufficiently novel payload — different phrasing, a different language, an
encoding, a payload split across a conversation — will not match. Security
writing *about* injection can resemble injection, which is why every signal
requires structure rather than keywords alone.

It is advisory. It never blocks, because the text has already arrived by the
time it is seen, and blocking it would be theatre. What you can still do is not
forward it.

---

## 10. Responses

Response scanning runs on a 1.2-second debounce after the DOM settles, over the
last 12,000 characters of rendered text plus open shadow roots. That means:

- the content has already arrived — this is a notice, not a guard;
- only the tail of the transcript is covered, not its whole history;
- what the DOM renders may not match the logical response (streaming, virtual
  scrolling, collapsed blocks, canvas rendering);
- a reply that arrives in pieces may be read mid-assembly, and a fingerprint set
  stops the same finding being reported twice.

---

## 11. The score, and the regulation names

**The score is a heuristic.** 93/100 is not a probability, not a percentage
chance of anything, and not a compliance measure. The weights in `src/risk.js`
are judgement written down and compressed so the number is readable in the two
seconds before somebody presses Enter. The panel says so, under the number:
*a priority, not a probability.* Every contribution is listed in `drivers`,
because a score nobody can reconstruct is a score nobody should trust.

It also flattens things that are not comparable. One AWS key, two hundred
customer records and an unannounced acquisition are three different problems
with one number on them.

**A regulation name is not a legal conclusion.** Whether GDPR, the DPDP Act,
HIPAA, SEC Reg FD, SEBI PIT or UK MAR is actually engaged depends on
jurisdiction, organisation, purpose, lawful basis, contract, data subject and
sector — none of which a content script can see. The panel heading is "Rules
about this kind of data", and the chips carry a sentence saying exactly that.
Every reference in `src/regulations.js` carries its article or section so it
can be checked against the current text, and so a stale one is visible rather
than merely wrong.

Laws change. This mapping will go out of date, and keeping it current is a
maintenance obligation this project has taken on.

---

## 12. Redaction changes the text

A placeholder is not the value it replaced, and sometimes that matters.

- **Meaning.** `<PERSON_NAME_1>` carries less than "Priya Nair" for a model
  asked to draft a reply. Placeholders are stable within a document — the same
  value becomes the same token every time — so the *structure* survives ("the
  key on line 4 is the one used on line 22"), but the content does not.
- **Shape.** For debugging, a secret's length, character set and relationship
  to neighbouring values can be the thing you needed help with. A placeholder
  removes all three. `redactReversible()` exists for the case where you want
  the answer back in terms of the original, but it is a library call, not
  something the panel offers.
- **Structured files.** See § 1. A `.docx` cannot be rewritten in place, and
  what comes back is text.
- **A missed secret cannot be redacted.** Redaction is exactly as good as
  detection, and § 2 is about how good that is.

---

## 13. What the panel asks of the reader

A person should not need to know what Luhn is, what entropy means, or what an
issuer range does in order to decide whether to press Enter. So the panel leads
with a score and one sentence, and everything technical is below the fold:
severity groups first, then the note that explains *why* a detector is
confident, then the coverage block.

Where it still asks too much: the regulation chips assume you know what GDPR
and SEBI are, the "context" tag assumes you will read the sentence under the
button explaining it, and a finding note like "check character verified mod 36"
is written for the person who wants proof rather than the person who wants a
decision. That is a deliberate ordering, not an accident, but it is a
compromise and it will not suit everybody.

---

## 14. The detector library will get harder to reason about

There are 102 detectors. Each new one is a new interaction with overlap
resolution, with the shape gate, and with every other detector's guards — and
the regression surface grows faster than the list does.

What holds it together today: every detector is a plain object in one file,
with its prefilter, its guards and its counter-examples beside it; `PROOFS`
names exactly which ones prove a match rather than matching a shape, pinned by
a test; `bench/wild.js` measures the whole set against real code rather than
each rule against its own fixtures; and the benchmarks are CI gates rather than
reports.

What does not scale: reading `src/rules.js` end to end. At some point the
categories in `CATEGORIES` need to become files.

---

## 15. It is advisory, not enforcement

"Send as-is" always works. That is deliberate — a tool that cannot be
overridden gets uninstalled, and an uninstalled tool catches nothing — but it
means Chhanni is not a control you can point at in an audit.

It does not stop a determined person from exfiltrating anything. It stops the
accident: the paste nobody looked at closely, the attachment nobody opened, the
screenshot with coordinates in it.

Warning fatigue is the failure mode that matters most. Everything in section 6
exists to keep the interruption rate low enough that the interruption still
means something.

---

## 16. Enterprise

`storage.managed` is read on every load, so a policy pushed by Group Policy, a
macOS configuration profile, Chrome Enterprise or Firefox `policies.json`
applies. `extension/managed-schema.json` is the schema.

What does not exist:

- a management console;
- central visibility — nothing is reported anywhere, which is the point, and
  also means an administrator cannot see what was caught;
- dynamic policy fetch — policy changes when the platform pushes them, not when
  a server says so;
- any mechanism that would let an administrator see the *contents* of what an
  employee pasted. Adding one would make this a surveillance tool, and it will
  not be added.

---

## 17. Library and CLI

- Node ≥ 20, for `DecompressionStream` and modern regular-expression syntax.
- Zero dependencies, which means every line of the ZIP reader, the PDF text
  extractor, the EXIF parser and the SHA-256 implementation is this project's
  to maintain and to get wrong. SHA-256 is verified against `node:crypto` on
  512 vectors; the extractors are verified against fixtures built by
  `tools/make-fixtures.py` with nothing but the standard library.
- The public API is `scan`, `redact`, `redactReversible`, `restore`,
  `fingerprint`, `mask`, `summarise`, `RULES`, `DEFAULT_POLICY`, the document
  layer (`extractDocument`, `sniff`, `rewriteMode`, `rewriteBytes`), the image
  helpers (`readImageMetadata`, `describeImageMetadata`, `stripImageMetadata`)
  and `sha256`. Everything else is internal and will change.

---

## 18. Things this is not

- Not a DLP platform. No agent, no gateway, no endpoint coverage, no console.
- Not a guarantee. It reduces accidental disclosure; it does not prevent
  deliberate exfiltration.
- Not protection for every application — only the browser, only where it is
  permitted to run.
- Not any influence at all over what the AI provider does with a prompt once it
  arrives. That is between you and them.

---

*Numbers in this document come from `node --test test/*.test.js`,
`node bench/run.js`, `node bench/ner.js` and `node bench/wild.js`, run on the
commit that carries it. If they disagree with the code, the code is right and
this file is a bug.*
