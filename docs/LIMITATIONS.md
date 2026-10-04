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

## 0. Four guarantees, and they are not the same guarantee

Most of the mistakes this project has made were one of these four being
mistaken for another. They are listed first because every section below is
really about the gap between two of them.

| | What it means | Where it stops |
|---|---|---|
| **Detected** | Something in the text matched, and the panel named it | A detector that does not exist, a format with no pattern, a semantic leak with no shape. § 2, § 3 |
| **Inspected** | The whole artifact was read, not just the part the format is named after | No OCR. A package part with no extractor. Rows past a cap. A closed shadow root. § 1, § 4, § 5 |
| **Redacted** | Every detected value was actually replaced in what gets sent | A cap that binds. A container that cannot be rewritten. A value detected in a part that the rewrite does not cover. § 1, § 13 |
| **Prevented** | It did not reach the provider | "Send as-is" always works, by design. Enter, a click on the send control and a form submit are all held; a path that bypasses all three, or a closed shadow root, is not. § 15, § 16 |

Each one is strictly weaker than the one above it, and the interesting bugs
live in the joins:

- **Detected but not inspected.** A `.docx` whose body parsed while its header
  — where the classification marking actually is — was never opened. The status
  said `readable`. Fixed: packages now report which parts were read, and one
  with anything genuinely unread is `partial`.
- **Detected but not redacted.** The worst bug this project has had. The panel
  said *"6,000 records — person name, email address, phone number, pan and
  compensation"*, and redaction replaced 1,200 names and nothing else, because
  the span budget was consumed entirely by the first column. Six thousand
  phone numbers went out behind an accurate warning. Fixed, and the table
  result now carries `fullyRedactable` so the panel cannot promise what it
  will not deliver.
- **Inspected, but not by every door.** For a while this said, correctly but
  uselessly, that "the submission paths a site can use are not all
  interceptable". What that sentence was covering was that clicking Send and
  submitting a form were not watched at all — only Enter was, which is the path
  a developer tests with and not the one most people use, and on a touch device
  there is no Enter key. All three go through one function now, and
  `test/e2e/` asserts on what a mock provider received rather than on whether a
  panel appeared.
- **Inspected, but not in that frame.** `all_frames` put the script in every
  subframe and the shadow-DOM handling read composers inside open roots. The
  two did not compose: the gate that holds a subframe until it contains
  something editable used `querySelector`, which does not cross a shadow
  boundary, so a composer inside an iframe inside a shadow root left that frame
  unguarded for the life of the page, silently. Fixed, and there is a test with
  a control.
- **Redacted but not prevented.** Always true, by design. See § 16.

When reading anything else in this document, or anything the panel says, the
question worth asking is which of the four is being claimed.

---

## 1. Files

### What a package part inventory does and does not cover

Every text-bearing part of an OOXML or OpenDocument package is read: body,
headers, footers, comments, footnotes, endnotes, speaker notes, slide masters
and layouts, chart labels, SmartArt, and OpenDocument's `styles.xml`. A part
with no bespoke extractor falls back to reading every text run, which is worse
than a real parser and much better than not opening it.

What is deliberately *not* reported as unread: `[Content_Types].xml`, the
relationship files, `xl/workbook.xml` and `ppt/presentation.xml`. Those are
scaffolding, and listing them would bury the one line that matters. The cost is
a defined name in `xl/workbook.xml`, which occasionally holds a value and is
not read.

What is reported: embedded OLE objects, media, and any part with no extractor.
A package with anything genuinely unread comes back `partial`, not `readable`,
and names what it missed.

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
| Table rows | 20,000 processed | Rows past it are counted, so the disclosure is reported at its true size, but their values cannot be replaced. `fullyRedactable` goes false and the panel says so. |
| Spreadsheet rows | 5,000 per `.xlsx` | The cap that actually binds on an attached spreadsheet, and it binds *below* the table layer. It used to be silent, and that was the worst bug in this document's history: a 50,000-row export came back `readable`, the panel said "5,000 records", `fullyRedactable` stayed true, and a "redacted copy" contained a tenth of the file. The row count travels with the text now, so the file reads `partial` and the panel names the rows nobody looked at. |
| Table cell spans | 60,000 | Walked row by row, so a budget that binds truncates the table rather than dropping whole columns. |
| Response window | 24,000 characters per pass | Scanned forward from the last mark rather than as a fixed tail, so a long reply cannot push an earlier one out unread — but a transcript growing faster than the debounce is read a pass behind. |
| ZIP entry | 32 MB declared, 32 MB emitted, 96 MB per archive | The second is the one a decompression bomb runs into; the first is only what a header claims. |
| Package parts | 512 per format | Past it, parts are listed as unread rather than silently dropped. |

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

## 9. Parsers, and what has been done to them

Reading attacker-supplied bytes with hand-written parsers is the largest
attack surface this project has, and until recently none of those parsers had
ever been handed anything malformed.

`bench/fuzz.js` is a seeded mutation fuzzer over the real fixtures — eight
mutators aimed at length fields, offsets, counts and magic numbers, chained one
to four deep, every case reproducible from its seed. 200,000 inputs in about a
minute. CI runs 20,000 on every push; `test/fuzz.test.js` runs a fixed slice
plus hand-built structures that lie about their own size.

Five invariants: never throws, never crashes internally, always returns one of
the four statuses, bounded time, bounded output.

The second one matters most and is the one that was missing. `extractDocument`
catches everything so a malformed attachment cannot take the page down, which
also means a genuine programming error inside a parser comes back as
`status: 'opaque'` and reads as "this file has nothing in it". The first 200,000
mutations passed while every `.xlsx` in the project was throwing a TypeError.
With the caught message surfaced, the same corpus found 219 crashes — two
out-of-bounds reads in the EXIF and PNG walkers, both reachable by a truncated
image, which is what every half-downloaded photograph is.

What this does not prove: that there is no bug left. A mutation fuzzer explores
near a valid file. It is not a structure-aware fuzzer, there is no coverage
feedback, and nothing here has been run under a sanitiser — JavaScript bounds
checks are the only memory safety in play, and the fuzzer's job is to find the
places where a `RangeError` is thrown rather than handled.

---

## 10. Prompt injection

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

## 11. Responses

Response scanning runs on a 1.2-second debounce after the DOM settles, over
the rendered text plus open shadow roots, scanning forward from wherever the
last pass stopped. It used to read a fixed 12,000-character tail, which meant a
long reply could push an earlier one out of the window before anything looked
at it — measured: a credential 30,000 characters back was missed entirely.
That is fixed. What remains:

- the content has already arrived — this is a notice, not a guard;
- a transcript growing faster than the debounce is read a pass behind;
- the mark resets when the page gets shorter, which virtual scrolling can do
  without a new conversation, and a reset means earlier text is re-read rather
  than skipped;
- what the DOM renders may not match the logical response (streaming, virtual
  scrolling, collapsed blocks, canvas rendering);
- a reply that arrives in pieces may be read mid-assembly. A finding is
  identified by its value *and* the text around it, so a re-render is quiet
  while a second reply carrying the same secret is a second event — keying on
  the value alone meant the second was silently dropped.

---

## 12. The score, and the regulation names

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

## 13. Redaction changes the text

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

## 14. What the panel asks of the reader

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

## 15. The detector library will get harder to reason about

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

## 15b. Startup, and the states that are not "clean"

For about two seconds after a page loaded, nothing was watching. Eight dynamic
imports and two storage reads were awaited before the first listener went on —
measured at 1,986 / 1,973 / 1,982 ms across three cold profiles, against 91–138
ms on a warm one. Somebody who copies a key, opens the tab and pastes lands
inside that window, and there was no sign of it.

Listeners go on first now, and anything that would carry content out while the
engine is still loading is held with a notice rather than passed. That is the
same rule the rest of the product runs on, applied to its own startup: *not
ready* is not *nothing found*.

The same distinction produced a third outcome everywhere else:

| | What it means |
|---|---|
| clean | inspected, nothing found — and it now says so, briefly |
| finding | inspected, something found |
| **could not inspect** | **no information at all: held, named, and overridable** |

The third one did not exist. A scan that threw escaped the handler before
`preventDefault()` ran, so the content went through and the person saw a
perfectly ordinary paste. A malformed policy value — a scalar where an array
belonged, which an administrator's GPO typo or a stale synced setting produces
without any attacker — was enough to trigger it. Policy is coerced at the
boundary so it does not throw, and if a scan throws anyway the action stops.

What is still true: a failure early enough to stop the content script from
running at all cannot be reported by the content script. If the engine does not
load, the top frame says so on the page; if the script itself never starts,
nothing can.

---

## 15c. The three modes, measured

The settings page makes three promises. They are listed here as a table
because one of them used to be false, and the way it was false is worth
keeping in view: `low` severity sat in neither the block nor the warn set, so
a pasted email produced a finding, a verdict of `clean`, and silence — in
strict as well, whose own label names emails and phone numbers as the thing it
catches. A settings page that names the two things which can never fire is not
a wording problem. It is the interface claiming coverage the engine does not
have.

Measured across every mode and every severity, and now asserted in
`test/e2e/`:

| | strict | warn | off |
|---|---|---|---|
| nothing found | sends | sends | sends |
| low — email, phone | **panel, send stopped** | panel on paste, send allowed | nothing |
| medium | **panel, send stopped** | panel on paste, send allowed | nothing |
| high | panel, send stopped | panel, send stopped | nothing |
| critical | panel, send stopped | panel, send stopped | nothing |
| a file nothing could read | **panel, held until you decide** | named in a notice, then allowed | nothing |
| a partially read file | panel names the unread part | panel names the unread part | nothing |
| the scanner threw | held, with an explicit override | held, with an explicit override | nothing |

Two things this table says that are easy to miss.

**`off` means off.** No paste handler, no send handler, no file inspection, no
response scanning, and no notice about a file that could not be read. It is not
a quieter mode; it is the absence of one.

**Strict is the mode where "I could not look at this" is a decision.** An
artifact nobody could open has no findings by definition, so a mode that only
promises to stop on findings would wave a 20 MB opaque binary through — which
is what it did, with a toast. In strict it now raises the panel and waits. In
warn it is still named and still allowed, because a mode most people leave on
has to stay usable.

---

## 15d. What it costs to be on the page, and what the page costs by itself

An extension that is correct and slow gets uninstalled, and the uninstall
reason box stays empty. Nobody reports "your content script forces a layout
every 1.2 seconds"; they notice the chat feels worse since they installed
something. So `test/perf/run.mjs` measures the cost on conversations the size
real ones reach, against budgets that fail the build.

Two things had to be true before any of those numbers meant anything.

**The window starts from quiet, not from `load`.** A 1500-turn page spends over
a second in parse and layout. That is the page's cost and not ours, and
windowing from `load` put a random part of it in the measurement — the first
version of this suite reported a 960 ms "cliff" that was entirely its own
windowing.

**The fixture has to move.** The response scanner is driven by a
MutationObserver, so against static HTML it never runs once. The first version
of this suite reported the cost of an extension that was asleep.

Measured in Chromium, median of three runs, on the committed fixtures:

| | 50 turns | 600 turns | 1500 turns |
|---|---|---|---|
| page text | 57 KB | 685 KB | 1.7 MB |
| elements | 589 | 7,005 | 17,505 |
| one `innerText` read | 0.2 ms | 2.8 ms | 8.2 ms |
| blocking added over 5 s idle | +0 ms | +0 ms | +0 ms |
| blocking added while a reply streams | +0 ms | +0 ms | +0 ms |
| paste to verdict, over the page's own | −1 ms | +11 ms | +35 ms |
| Send held, over the page's own click | +7 ms | +27 ms | +34 ms |
| a credential in a streamed reply is reported after | 2.8 s | 2.9 s | 3.0 s |

Every figure that can be is stated **over the same page with no extension
loaded**, and that is not a presentational choice. With the renderer throttled
4x, the 1500-turn fixture blocks the main thread for about four seconds while a
reply streams *with nothing installed at all*: 17,505 elements relaid out on
every frame of an append. An absolute budget against that number is a budget on
Chromium's layout engine, and chasing it would mean deleting features to fix a
cost that was never ours.

**What the throttled runs are for, and what they say.** `--throttle 4`
approximates a shared CI runner or a laptop with a build running. It is an
investigation tool rather than a gate, because at 4x the control itself swings
3,982 / 4,357 / 4,810 ms across three identical runs, and a delta budget of
250 ms against a control that moves 800 ms is a coin toss dressed as a gate.
It is where three of the defects below were found.

It also carries the one number on this page that is not comfortable. On the
1500-turn fixture at 4x, median of five runs, Chhanni adds **about 1.3 s of
blocking across a streaming reply and the four seconds after it** — on top of
the page's own 3.7 s — and about 80 ms over five seconds of an idle tab. Paste
and Send stay within budget (+168 ms and +135 ms). So: on a slow machine, with
a 1.7 MB conversation, while a reply is streaming, this extension is part of
why that page is not smooth. It is not most of why, and the budgets at 1x are
met with room to spare, but the honest summary is that the response scanner's
cost still scales with the length of the conversation.

The fix for that is known and deliberately not done yet — see decision 35. It
is to stop reading the whole transcript to find the end of it, which needs a
structural mark in the DOM rather than a character offset, and a mark that is
wrong would mean a reply that is never scanned. A miss is not an acceptable
cost for a second of smoothness, so it waits for a design that cannot miss.

---

## 15e. Three defects that only a moving page could show

Each of these shipped, passed 115 unit tests, and would have passed the
end-to-end suite as it stood, because every fixture in it was static and a
static page is one the response scanner is correct to ignore.

**The debounce had no ceiling.** The scanner's timer was cleared and reset on
every mutation, so a page that mutates more often than the interval reset it
forever and the scanner never ran — not late, never. Every product on the match
list keeps something moving in the DOM: a typing indicator, a caret, a shimmer,
a token counter. Measured with an indicator ticking every 400 ms, a reply
carrying a credential streamed in full and nothing was said for the fifteen
seconds the test waited. A documented feature was dead on all twenty-three
sites it was written for. There is now a hard ceiling: a pass runs within three
seconds of the first mutation that is still unscanned, whatever else arrives.

**The newest reply was read last.** The scan mark started at zero and walked
forward one window per pass, which is right for completeness and backwards for
urgency: on a 1.7-million-character thread the reply that just arrived was the
seventy-first thing the scanner looked at. Measured notice latency — 3.0 s at 50
turns, 4.9 s at 600, 10.6 s at 1500 — a number that grew with the length of a
transcript that was already on screen before the page loaded. Passes now read
forward from where the text last ended, which is the new text and nothing else.

**Enterprise policy was on the critical path for everybody.** The bootstrap
awaited `chrome.storage.managed.get(null)` before the engine would admit to
being ready. That read resolves through an IPC whose reply is dispatched on the
renderer's main thread, and on a busy page that thread is not available:

| | `storage.managed.get(null)` |
|---|---|
| 1500-turn thread, renderer idle | 3.0 s |
| 1500-turn thread, reply streaming and an indicator ticking, 4x | **57.8 s** |

Fifty-eight seconds — not of being wrong, because the holding listeners are
attached long before and nothing leaks, but of a tool that answers every paste
with *still starting, that was held*. Open a long conversation, paste a key, and
Chhanni tells you to wait a minute. What a person actually does then is switch
it off.

Nothing can be done about a busy renderer. What can be done is to stop a policy
nine profiles in ten do not have from gating the nine: a profile that has never
seen managed policy goes ready on the person's own settings and reads managed in
the background, and if it turns out to exist, that is remembered and every
later load waits for it. `storage.onChanged` fires for the managed area too, so
even the first load after an administrator deploys a policy picks it up when it
lands rather than at the next navigation.

**A reply only had to be critical to be worth mentioning.** The scanner
reported `critical` findings and nothing else, and the rule table says why that
was too narrow: a Slack incoming webhook is `high`. So is a SendGrid key, a
Twilio key, a Notion token, a Grafana token, an IBAN — twenty-one shapes that
are unmistakably live credentials, every one of which a model can echo back
into a conversation, and about every one of which Chhanni said nothing at all.
"Critical" is a severity ranking for your own outgoing message; it was never a
definition of what matters in a reply. The scanner now reports `high` as well,
minus three groups that would make it noise rather than signal: the ten
advisory context detectors (an assistant discussing a negotiation would trip
one every time), `jwt` and `bearer_header` (which match a shape, not a vendor —
a reply explaining JWTs contains JWTs), and a postal address (which in an
answer is usually the answer). Findings of `possible` confidence are left out
too: for text you did not write, a maybe is not worth interrupting you for.

**What is still true.** On a profile in a managed fleet, the first page load
after the policy appears runs on the person's own settings until the managed
read lands. Managed policy in practice tightens — a stricter mode, extra
required detectors, an allowlist the person cannot edit — so that window is one
where Chhanni may be less strict than the administrator intends, not one where
it is off.

---

## 15f. The caps say when they fired

Reading the page's text means `document.body.innerText`, which stops at a
shadow boundary, plus a sweep of open shadow roots. The sweep is capped —
20,000 elements, 200 roots — because an extension running inside somebody
else's DOM has no business making an unbounded traversal. The history walk is
capped too, at 120,000 characters of transcript that was already on screen.

A cap is a limitation. A cap that fires silently is this product telling the
same lie it exists to catch: *we stopped looking* rendered as *nothing found*.
So each one records why it fired, and the popup says so on the tab it happened
on — "this page is too large for Chhanni to read in full, so replies inside
custom elements are not being watched", and for a long thread, roughly how many
words further up were never checked. The number is derived from the cursor
rather than from the budget, so on a page too busy to spare an idle frame it
reports the history as unread, which is what it is.

None of this touches what you send. The caps are on reading the page's own
replies; the message in the composer is scanned in full.

---

## 16. It is advisory, not enforcement

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

## 17. Enterprise

`storage.managed` is read on every load, so a policy pushed by Group Policy, a
macOS configuration profile, Chrome Enterprise or Firefox `policies.json`
applies. `extension/managed-schema.json` is the schema.

`lockAllow` makes the managed allowlist the whole allowlist, and `neverAllow`
names values that may never be allowlisted by anyone — including by the
policy's own `allow` list. Both are opt-in, because the default is that policy
*adds* protection rather than removing what a user chose. Without them an
administrator could require a detector and then watch somebody allowlist the
exact value it existed to catch.

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

## 18. Library and CLI

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

## 19. Things this is not

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
