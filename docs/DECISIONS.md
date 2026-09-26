# Decisions

Short records of the choices that shaped this, including the ones with a cost.

---

### 1. Redact rather than block

**Context.** Every tool in this category interrupts. Most of them stop at "are
you sure?".

**Decision.** The primary action is *Redact and continue*, which swaps each
secret for a stable placeholder and lets the prompt through.

**Why.** A blocker gets uninstalled the first time it stands between someone and
their deadline. The model never needed the real key to explain a stack trace —
`<AWS_ACCESS_KEY_ID_1>` carries exactly as much meaning for the task at hand.

**Cost.** Redaction has to write back into a framework-controlled composer,
which is the most fragile code in the project.

---

### 2. Placeholders are stable within a document

**Decision.** The same secret appearing three times becomes the same token three
times.

**Why.** It preserves the structure the model needs — "the key on line 4 is the
same one used on line 22" survives redaction. Random tokens per occurrence
would destroy that and make the redacted prompt less useful than the original.

---

### 3a. Measure, and publish the number

**Context.** Every product in this category claims accuracy and none publish a
figure. The only public numbers are academic, and they are poor: 25–75%
precision across nine secret-detection tools.

**Decision.** Ship `bench/` — a seeded, reproducible corpus — print precision
and recall from one command, and write down what the number does not cover.

**Why.** It is the only claim in this project a stranger can check in thirty
seconds, and it is the one differentiator an incumbent cannot take by
out-spending: they would have to publish too.

**Cost.** A self-authored corpus flatters its author. Stated in BENCHMARK.md
rather than hidden, along with the fact that a check digit can never reach zero
false positives.

---

### 3b. The benchmark is a gate, not a press release

**Decision.** `test/detect.test.js` fails the build below 99% precision or recall.

**Why.** A number measured once is marketing. A number enforced on every commit
is a property of the system.

**Cost, learned the hard way.** The GSTIN validator had an off-by-one that made
it reject every real GSTIN, and the benchmark reported 100% throughout — the
corpus generator called the same broken function to build its samples. A
benchmark validates *consistency*, not *correctness*. Known-good real-world
vectors in the unit tests are what validate correctness. Both are needed, and
neither substitutes for the other.

---

### 3. Checksums, not just patterns

**Decision.** Where a format carries its own verification, use it: Luhn,
Verhoeff, mod-97, CRC32, base64 decode.

**Why.** `\d{16}` matches order numbers, tracking IDs and timestamps. Luhn does
not. The entire difference between a tool people keep and one they disable in a
week is how often it is wrong.

**Cost.** Nine of thirty detectors can do this. The rest match a prefix nothing
else uses, which is strong but is not proof — and they are labelled `shape`
rather than `proof` everywhere they appear, including in the UI.

---

### 4. `PROOFS` is an explicit list, not inferred

**Context.** The first version derived "does this detector prove itself?" from
`rule.validate || rule.enrich`. That counted 11 — including the email rule,
whose only validation is excluding `example.com`.

**Decision.** An explicit map naming the proof method for each of the nine
detectors that genuinely verify. A test pins the count.

**Why.** The inferred number was inflated, and it was the central claim the
project makes about itself. A claim you cannot audit is a claim you should not
make.

---

### 5. No network permission, enforced by test

**Decision.** The manifest requests only `storage`. A test fails if any shipped
module references a network API.

**Why.** The user is handing their credentials to a credential scanner. "Trust
us" is not an answer; a permission that does not exist is.

**Cost.** No cloud policy, no central rule updates, no fleet reporting — all of
which an enterprise buyer would want. That is a different product, and it should
be a different product.

---

### 6. No bundler, no dependencies

**Decision.** Plain ESM, copied into the extension by a 20-line script.

**Why.** A reviewer can read the exact bytes that ship. For a tool making a
security claim, auditability beats convenience, and the dependency count is
itself part of the threat model.

**Cost.** MV3 content scripts cannot be ES modules, so `content.js` is an async
IIFE that dynamic-imports the engine from a web-accessible resource.

---

### 7. History is local and never synced

**Decision.** Policy goes in `storage.sync`; detection history goes in
`storage.local`.

**Why.** Settings are worth having on your other machine. A record of what you
nearly leaked is not worth replicating anywhere, even masked.

---

### 8. Scan on paste and Enter, never on keystroke

**Decision.** No input-event scanning in the content script.

**Why.** Typing must cost nothing. The two moments that matter are the two
moments text crosses a boundary, and both are catchable.

**Cost.** Text that arrives by drag-and-drop, or by a host-page action that
bypasses both events, is not seen until Enter.

---

### 9. Low severity never blocks

**Decision.** In the default mode, emails and phone numbers are reported but
never stop a send.

**Why.** Prompts contain email addresses constantly and almost always
legitimately. Blocking on them would train users to dismiss the panel without
reading it, which would break the detectors that matter.


---

### 10. Issuer ranges on top of Luhn

**Context.** A 15-digit IMEI was being reported as a payment card. It passed
Luhn — because IMEIs carry a Luhn check digit too.

**Decision.** A card must also begin in a range some network actually issues,
*at a length that network actually issues*. 15 digits is a card only if it
starts 34 or 37.

**Why.** Luhn alone accepts about 1 in 10 random digit strings. One check digit
buys one order of magnitude; that is all it can buy. The second, independent
constraint is what makes the detector trustworthy.

**Cost.** A card on an exotic unlisted BIN is missed. The range table is
deliberately conservative, and that trade is the right way round for a tool that
gets uninstalled when it is wrong.

---

### 11. Redact the attachment, don't block the upload

**Decision.** For text-like attachments, offer a new `File` with the same name
and type and the secrets replaced — not merely a refusal.

**Why.** Identical reasoning to redact-don't-block, one layer out. The person
still gets to send their config and still gets their answer.

**Cost.** Binary files cannot be handled this way, so a screenshot of a
dashboard passes untouched. Documented as a gap rather than papered over.

---

### 12. Glass, and a fallback for when it is unavailable

**Decision.** Real `backdrop-filter` surfaces, with an `@supports` fallback that
goes opaque.

**Why.** The panel appears unannounced over someone's work. A translucent layer
reads as something placed *on* the page rather than part of it — which is
exactly what it is, and it keeps the host page's content visible underneath so
the interruption feels like a pause rather than a takeover.

**Cost.** An extension page has nothing behind it to blur, so the popup and
settings paint a soft colour field for the glass to work against. Without it,
`backdrop-filter` is a no-op and the effect is just a flat card.


---

### 13. A small model plus context, not a big model

**Context.** Names in prose needed statistical help; a pattern cannot express
"looks like a person's name". The options were a gazetteer, a compact trained
classifier, or a quantised transformer in WASM.

**Decision.** A logistic regression over hashed character n-grams — 21 KB,
int8, trained on 30,675 names from 75 locales — used as *one term* in a
log-odds sum with structural context.

**Why.** A gazetteer only recognises names someone already wrote down, which
fails on exactly the names most likely to be missed. A transformer would score
better and could not ship: it has to fit in a store-reviewed package, run in a
content script, and make no network call.

**Cost, and it is the interesting part.** The classifier alone reaches F1 71.7%
and *will not go higher* — a Yoruba place name and a Yoruba person name share
their morphology, and 1,900 tokens are both a name and a place. Reporting that
ceiling honestly, rather than quoting the pipeline's 97.2% as if it were the
model's, is the difference between a measurement and a marketing number.

---

### 14. Train-time and inference-time features are the same file

**Decision.** `src/namefeatures.js` ships in the extension *and* is imported by
`tools/train-name-model.js`.

**Why.** Training/serving skew is the most common way a small model silently
stops working, and the cheapest prevention is having one copy of the code
rather than two that agree today.

---

### 15. Aho–Corasick for the prefilter

**Context.** ~250 prefilter literals, each tested with `String.includes` — 250
full passes over the text, which dominated the scan on large pastes.

**Decision.** One automaton, built at module load, answering the question in a
single O(n) pass. Regexes compiled once and reused rather than recompiled 94
times per scan.

**Why.** A 46 KB paste went from 11.1 ms to 5.7 ms *while gaining* the prose
pass. Latency in a content script is not a benchmark number; it is the
difference between a tool that feels instant and one people disable.

**Cost.** ~80 lines of data structure to maintain, and a test asserting the
automaton returns exactly what `includes()` would — an optimisation that can
change results is a bug, not an optimisation.

---

### 16. Measure against code nobody wrote for you

**Context.** The generated corpus reported 100% precision. It had been
reporting 100% for three versions.

**Decision.** `bench/wild.js`: scan public repositories — 87,306 files of
express, flask, axios, prettier, github/gitignore — and count how often the
engine speaks.

**What happened.** **601 findings. One every 17 files.** Seven distinct
false-positive classes, *none* of which the synthetic corpus could see:
`phone_india` matching 411 arbitrary integers in a formatting fixture,
`credential_in_prose` matching JavaScript identifiers, `prompt_injection`
flagging a **.gitignore** that explained "ignore rules", and zero-width
detection flagging Devanagari and emoji.

**Why it matters more than the benchmark.** A self-authored corpus tests the
cases its author imagined. Real code contains the cases nobody imagined, and
those are the ones that get an extension uninstalled. 601 → 129 after the
fixes, each locked behind a test using the exact string found in the wild.

**Cost.** None worth mentioning, which is the uncomfortable part: this should
have existed from the first version.

---

### 17. A gazetteer for scripts without case, a classifier for scripts with it

**Context.** The name classifier assumed capitalisation. Arabic, Hebrew,
Devanagari, Thai, Han, Hangul and the kana have no case at all, so the single
strongest feature in the pipeline did not exist for most of the world.

**Decision.** An exact gazetteer of 10,237 names for uncased scripts; the
classifier for cased ones.

**Why a gazetteer is right here rather than a fallback.** Where there is no
capitalisation to lean on, an exact match is the strongest evidence available.
The character inventory is small and names are short. Dense scripts (Han,
Thai, kana) have no token boundaries either, so they use a sliding window and
additionally require context.

**Cost.** A gazetteer cannot generalise. A Devanagari name nobody wrote down is
missed, and Devanagari coverage is thin — 93 entries from a test-data library
is not a serious source, and is named as such.

**A correction it forced.** The classifier's negatives are Latin-only, so it
had never seen an ordinary Cyrillic word and scored every one as a name —
including the verb `Говорил`. Cased non-Latin scripts now require a gazetteer
hit or real context too.

---

### 18. Enterprise policy through the browser, not through a server

**Decision.** Organisation policy arrives via `chrome.storage.managed` — GPO,
macOS profiles, Chrome Enterprise, Firefox `policies.json`.

**Why.** The obvious way to sell this to a company is a console: rules down,
findings up. The second half would make every claim in the threat model false.
Browsers already solved this, locally, with no permission beyond the `storage`
one already held. A CISO gets consistent rules; the default install stays
silent. Those two are usually sold as a trade-off and are not one.

**Cost.** No fleet dashboard, which is exactly what an enterprise buyer will
ask for first.

---

### 19. One walk of the string

**Context.** Twenty detectors have no literal to prefilter on because their
patterns are pure shape, so they ran unconditionally — and several are the most
expensive regexes in the ruleset.

**Decision.** A single pass yielding the longest digit, uppercase, alphanumeric
and base64 runs, plus the Aho–Corasick literal set. Every gate afterwards is an
integer comparison.

**Why.** 46 KB went from 11.1 ms to 3.2 ms *while gaining* the prose pass and
injection detection. In a content script, latency is not a benchmark number —
it is the difference between a tool that feels instant and one people disable.

**Cost, and the bug it caused.** `base64Run` had to exist separately from
`alnumRun`: an AWS secret is forty base64 characters including `/` and `+`, and
gating on the alphanumeric run discarded every real one. The benchmark caught
it immediately, which is the argument for having the benchmark be a gate.

---

### 20. Read the attachment, and route by magic bytes

**Context.** A `.docx`, a PDF and a screenshot went through untouched while a
`.env` was caught. People do not only paste secrets; they attach them, and the
attachment is usually where the sensitive thing actually lives.

**Decision.** Read every attachment as bytes, identify it by magic number, and
extract what text there is. DOCX, XLSX, PPTX, ODT, ODS, ODP, text-based PDF and
RTF are parsed in the page; images give up their EXIF.

**Why bytes and not the extension.** An extension is a claim a file makes about
itself. A `.txt` that is really a ZIP and a `.jpg` that is really a PDF are
exactly the cases where being wrong matters.

**Why no dependency.** `DecompressionStream` is in every browser and in Node,
and it does both `deflate-raw` (ZIP) and `deflate` (PDF `FlateDecode`). The
whole stack is five files and no `package.json` change.

**Cost.** Five more parsers this project owns and must get right. Mitigated by
`tools/make-fixtures.py`, which builds genuine containers with nothing but the
standard library, and by a test suite that runs the extractors against them.

---

### 21. No OCR, and say so by name

**Context.** The single most-requested capability, and the one most likely to
be assumed present.

**Decision.** There is no OCR. Instead, every file that could not be read is
named in the panel, with the reason, and a scanned PDF is reported as scanned.

**Why.** Tesseract's WASM build plus one language model is several megabytes.
Bundling it roughly triples the package and invites the "what is this
obfuscated blob" question at store review; fetching it on demand breaks the
only promise this project makes. Neither trade is worth it.

**Cost.** A screenshot of a dashboard is a real, unhandled leak.

**What was done instead.** An image's metadata *is* read — a photograph's GPS
block is a leak OCR would not have found either — and the warning comes with a
fix: `stripImageMetadata()` drops JPEG APPn segments and PNG ancillary chunks
and copies the image data through untouched.

---

### 22. Rewrite the file only as honestly as its format allows

**Context.** "Attach a redacted copy" is the feature that makes the attachment
path worth having. It cannot mean the same thing for every format.

**Decision.** Four modes, and the panel says which one it will use, per file,
before the button is pressed. `text` replaces in place. `convert` offers the
extracted text as a `.txt` beside the original name. `strip` returns the same
image without its metadata. `none` returns the file unchanged and says so.

**Why not rewrite a `.docx` in place.** It is a ZIP of XML parts held together
by relationship ids, with styles, a content-types manifest and often revision
history. Substituting a placeholder into one part and re-zipping produces a
file that opens differently, or does not open. A tool that silently damages an
attachment loses the user permanently.

**Cost.** `contract.docx` comes back as `contract.docx.redacted.txt`, which is
not what was asked for. Saying so beforehand is the whole of the mitigation.

---

### 23. SHA-256, salted, and synchronous

**Context.** `fingerprint()` was a 32-bit FNV-1a hash, and the documentation
called it "one-way". Four billion outputs is a table anyone can build.

**Decision.** SHA-256 over a per-install random salt, truncated to 128 bits,
implemented in about eighty lines in `src/sha256.js`.

**Why not `crypto.subtle`.** It is async. Making every finding's fingerprint a
promise would turn `scan()` and everything downstream async for nothing a user
could see, and WebCrypto is unavailable on an `http://` page, which some
self-hosted front ends still are.

**Why the salt matters more than the hash.** An email address has perhaps
thirty bits of real entropy, so an unsalted digest of one is recovered by
trying candidates whatever the algorithm. A per-install salt means there is no
shared table to build and no correlation across a person's devices.

**Cost.** Another primitive this project owns. Verified against `node:crypto`
on 512 vectors including every block-boundary length.

---

### 24. Head and tail, not a prefix

**Context.** Above 2 MB the scanner took the first 2 MB and reported
`truncated`.

**Decision.** The same budget buys a 1.4 MB head and a 600 KB tail, joined by a
seam no detector can match across, with every offset and line number mapped
back onto the original input and anything straddling the seam discarded.

**Why.** An `.env` dump, a key block or a signature is at the *end* of a file
far more often than in the middle. A prefix reliably missed the part that
mattered.

**Cost.** The middle is genuinely not read. The panel says how much, in
megabytes, rather than leaving the gap implied.

---

### 25. Measure alarms, not findings

**Context.** `bench/wild.js` reported a findings count. A file full of example
email addresses produced findings and no interruption, so the number was not
measuring the thing that decides whether anyone keeps this installed.

**Decision.** The benchmark counts how often `scan()` returns a verdict that
would raise the panel, and prints both.

**Why.** Warning fatigue is the failure mode. One alarm every 259 files across
87,306 files is a claim about the product; 7,863 findings is a claim about the
engine, and only the first one matters to a person using it.

**What it immediately caught.** Nine false-positive classes, two of them
internationalisation bugs — Khmer's word separator read as an invisible-
character attack, Central Kurdish bidi isolates read as Trojan Source. Neither
was findable by reasoning about the code.

---

### 26. `scripting`, for a permission that was only ever a claim

**Context.** `optional_host_permissions` had been in the manifest since the
first version and nothing ever requested it. A permission declared and never
used is a claim on the store listing the code does not make good on.

**Decision.** The popup states which of three states the current tab is in and,
where a site is not covered, offers to cover it — requesting the origin and
registering the same content script the manifest declares, persisted across
sessions, with an unwatch beside it.

**Why.** A fixed list of 23 sites can never reach whatever an organisation
self-hosts, which is exactly where its sensitive prompts go.

**Cost.** A second permission (`scripting`) and a slightly larger review
surface. It grants no network access, and the test that pins the permission
list now also pins that every optional permission is one something asks for.

---

### 27. Say what the number is not

**Context.** `93/100` reads as precision. `Regulated under: GDPR · SEBI` reads
as a finding of fact about your organisation. Neither is what those elements
mean.

**Decision.** The score carries "a priority, not a probability" under the
headline. The chips are headed "Rules about this kind of data" and carry a
sentence saying that whether any regime is engaged depends on jurisdiction,
purpose and lawful basis — none of which a content script can see. Advisory
findings carry a "context" tag, and the panel says under the button what
redacting will and will not do.

**Why.** A figure that looks precise will be read as precise unless it says
otherwise, and a chip that looks like a verdict will be read as one. Both
mislabel the tool's authority, and the cost of that is either unwarranted
alarm or unwarranted confidence.

**Cost.** Four more lines of text in a panel whose whole design is about being
readable in two seconds. Judged worth it: the two-second read is the score and
the band, and everything else is for whoever wants it.
