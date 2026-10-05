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

---

### 30. On-device AI is an enhancement with a hardware bill, not a plan

**Context.** `docs/LIMITATIONS.md` says "there is no OCR, and there will not
be", and gives a good reason: Tesseract's WASM build would either triple the
package or require a network fetch. Chrome's built-in Prompt API changes the
premise — the model is the browser's, not ours, and inference is local — so the
reason was re-checked rather than repeated.

**What was measured**, in Chromium 141, against the real extension:

| Context | `LanguageModel`, no flags | `Summarizer`, no flags |
|---|---|---|
| Extension page (`chrome-extension://…`) | **present**, `availability()` → `downloadable` | present, `downloadable` |
| Content script, isolated world | **absent** | **present**, `downloadable` |
| Web page, main world | absent (needs `--enable-features=AIPromptAPI`) | present |

Two things follow, and they point in different directions.

The Prompt API — the multimodal one, the only one that could look at a
screenshot — **is not reachable from where Chhanni does its work.** Using it
means an offscreen document created from a service worker, the `offscreen`
permission, and image bytes crossing `chrome.runtime` messaging. This project
has no background context at all today, and `ci.yml` fails the build on any
permission beyond `storage` and `scripting`. That is three deliberate
properties spent on one feature.

The bill on the user's side is larger: roughly 4 GB of model, **22 GB of free
disk** before Chrome will download it, and either a GPU with 4 GB of VRAM or a
CPU with 16 GB of RAM and four cores — desktop only, so every mobile user is
out. `availability()` returning `downloadable` is the normal state, not an
error, and it means the feature is absent until several gigabytes have moved.

**Decision.** Not now, and when it does happen, under a rule that is written
down before the code is: **the model may only ever add findings.** It may say
"this image appears to contain an email address and an account number". It may
never say "clean", never clear a deterministic finding, and never be the reason
a status moves from `opaque` to anything. An unavailable, downloading, slow or
wrong model must leave today's behaviour exactly as it is — which is a
screenshot reported as not inspected, by name.

That ordering is the whole product. A probabilistic layer that can silence a
deterministic one is not a safety feature, it is a way to be confidently wrong,
and it would turn "we told you what we could not read" into "we think it's
fine". The honest version of this feature makes `opaque` into `partial`. It can
never make it `readable`.

**Cost of waiting.** Screenshots remain the largest category of real-world leak
this cannot see, and `LIMITATIONS` keeps saying so by name. That is the correct
trade while the alternative is a feature most installs cannot run.

**Noted for later.** `Summarizer` *is* reachable from the content script with
no flags and no new permission, which is the cheap door — but it is text-only,
so it is no use for pixels. Where it could help is the semantic layer in
`context.js`: "this reads like unreleased commercial terms" is a judgement,
not a pattern. Same rule applies, and the same 22 GB.

---

### 31. Agent and tool preflight is the right shape and the wrong year

**Context.** The threat is moving from "a person pasted a secret" to "an agent
sent one", and the browser is growing the plumbing for it. WebMCP lets a site
expose structured tools to an agent; Chrome's own guidance for it is about
classifying read-only against state-changing tools, restricting exposure to
trusted origins, labelling untrusted content and requiring confirmation before
consequential actions.

What that guidance does not do — and says as much — is stop a model that has
been deceived from calling a tool it is allowed to call. A confirmation gate
asks *whether* an action may proceed. Nothing inspects **what is in the
arguments**. `createCustomer({name, email, phone})`, `sendEmail({to, body})`,
`uploadFile(export.xlsx)`, `open(urlWithToken)` — each is a legitimate call
that may carry exactly the data this engine already recognises, to a
destination the person never looked at.

That is the same job Chhanni does, on a new surface, with no new permission and
no network call. It is a better fit for this architecture than competing on
detector count, because deterministic inspection is precisely what a
probabilistic agent cannot do for itself.

**What was measured.** `document.modelContext` and `navigator.modelContext` are
both `undefined` in Chromium 141 — page world, isolated world and extension
page alike, with and without AI feature flags. The origin trial runs from
Chrome 149 to 156, with stable support expected later; the API was also renamed
mid-flight, `navigator.modelContext` having been deprecated in Chromium 150 in
favour of `document.modelContext`.

**Decision.** Build nothing yet, and do not describe Chhanni as agent-aware.
There is no API to attach to in any shipping browser, the surface is still
moving, and a security claim about a capability that does not exist is worse
than having no capability.

What is worth doing now costs nothing and is already underway: keep the
inspection layer free of any assumption that its input came from a keyboard.
`guardSubmission()` takes text, a target and a replay function; it does not
care whether a human or a script caused the event, which is why guarding
programmatic clicks was a two-line change rather than a redesign. A tool
argument is text with a destination attached. When the API lands, the engine
should already be in the right shape to inspect one.

**The open question**, which is honest to leave open: an extension can observe
the page, and WebMCP tools execute in the page with the user's session. Whether
an extension can *interpose* on a tool call — rather than merely watch one —
is not determined by anything readable today, and that distinction decides
whether this is a product or a log.

---

### 32. Measure the extension, not the page

**Context.** Nothing in this repository measured what the extension costs. A
correct extension that makes ChatGPT feel worse gets uninstalled, and the
uninstall reason box stays empty — so the cost is invisible right up to the
point where it is the only thing that matters.

**What the first attempt got wrong**, which is the useful part of this record.
The first harness windowed its measurement from the `load` event and reported a
960 ms blocking "cliff" on a 1500-turn conversation. The cliff was the
harness's: a 1.7 MB document spends over a second in parse and layout, the
`load` event lands somewhere inside that, and the window therefore caught a
random amount of work the extension neither caused nor could fix. The same
harness's fixture was static HTML, so the response scanner — driven by a
MutationObserver — never ran a single pass. It measured an extension that was
asleep and attributed Chromium's layout to it.

**Decision.** Three rules, each of which exists because breaking it produced a
confident wrong number:

1. **Anchor on quiet, not on an event.** The clock starts after the page has
   gone 1.2 s without a long task. Everything before that is the fixture's.
2. **Every budget that can be is a delta** against the same page with no
   extension loaded. At `--throttle 4` the 1500-turn fixture blocks for about
   four seconds with nothing installed; an absolute budget there measures
   Chromium.
3. **Medians, not runs.** That control measured 3,982 / 4,357 / 4,810 ms across
   three identical runs. A 250 ms budget against an 800 ms swing is a gate that
   fails at random, which teaches whoever sees it to re-run until it passes —
   the habit that lets a real failure through.

**Consequence.** `npm run test:perf` is a gate in CI at 1x. `--throttle 4` is
an investigation tool and deliberately not a gate, for reason 3; it is where
the starvation, the ordering and the `storage.managed` defects were found.

---

### 33. An administrator's policy is an override, not a precondition

**Context.** The bootstrap read two things before declaring itself ready: the
person's settings from `storage.sync`, and an organisation's from
`storage.managed`. Reading both before going ready is the obviously correct
order — the administrator's policy is the one that wins, so apply it before
protecting anything.

**What that cost.** `storage.managed.get(null)` resolves through an IPC to the
browser process whose reply is dispatched on the renderer's main thread.
Measured on a 1500-turn thread: 3.0 s with the renderer idle, and **57.8 s**
with a reply streaming and an indicator ticking at 4x throttle. For that whole
time `engineState` was `loading`, which is fail-closed and perfectly safe —
every paste was held with "still starting, that was held, not checked" — and
completely unusable. Correct and unusable is one of the ways a security product
gets uninstalled.

**Decision.** Readiness depends on the person's settings only. A profile that
has never seen managed policy goes ready and reads managed in the background;
if managed policy turns out to exist, that fact is written to `storage.local`
and every later load waits for it, with a 4 s cap so a stalled policy service
cannot hold the page open. `storage.onChanged` fires for the managed area, so
even the first load after a policy is deployed picks it up when it lands.

**What this gives up, stated plainly.** On a managed profile's first load after
a policy appears, Chhanni runs on the person's own settings until the managed
read lands. Managed policy in practice tightens — a stricter mode, extra
required detectors, an allowlist the person cannot edit — so the window is one
where Chhanni may be *less strict than the administrator intends*, not one where
it is off. The alternative was a product that holds every paste for a minute on
a long conversation, for every user, to close a window that affects one page
load per managed profile.

---

### 34. A cap that fires silently is the bug this product exists to prevent

**Context.** Reading the page's replies means `document.body.innerText` plus a
sweep of open shadow roots, and the sweep is capped at 20,000 elements and 200
roots. Walking the history of a conversation is capped at 120,000 characters.
Both caps are necessary: an extension inside somebody else's DOM has no
business making an unbounded traversal, and a 1.7 MB transcript is seconds of
scanning however politely it is scheduled.

**The problem.** Every one of those caps used to fire silently. The sweep was
skipped entirely above 20,000 elements and the loop broke out above 200 roots,
with no record either happened, and the result was reported the same way a
complete read was. *We stopped looking* presented as *nothing found* — which is
the exact substitution this product exists to catch, committed by the product.

**Decision.** Each cap records why it fired, and the popup states it on the tab
it happened on. The unread-history figure is derived from the walk's cursor
rather than from the budget, because an earlier version stored the budget's
floor once and would have claimed the recent history was read on a page too
busy for the walk to have moved at all.

**Scope, so this is not read as bigger than it is.** These caps are on reading
the page's own replies. What you put in the composer is scanned in full, and
none of this changes that.

---

### 35. Reading the whole transcript to find the end of it

**Context.** The response scanner needs the newest text on the page. It gets it
by reading `document.body.innerText` and taking the part past a character
offset, which means the cost of finding a 2 KB reply is the cost of building a
string of the entire conversation.

**What that costs, measured.** On a 1500-turn thread (1.7 MB, 17,505 elements):
8 ms a read on a desktop, 43 ms with the renderer throttled 4x. Three
strategies were compared at 4x — `innerText` on a dirty layout 62 ms,
`textContent` 62 ms, a `TreeWalker` over text nodes 71 ms — which settles what
the cost actually is. It is not the forced layout; it is building a 1.7 MB
string. No read strategy is cheaper, because they all read everything.

The mitigations that are in place are real but second-best: the read is cached
for the length of a burst of work, the pass interval is derived from what a
pass costs so the scanner holds to a fixed share of the main thread, and the
history walk has a CPU budget rather than only a byte budget. Together they
leave about 1.3 s of added blocking across a streaming reply at 4x on that
fixture, down from a point where the same measurement swung past five seconds —
but still scaling with the length of the conversation, which is the property
that should not be there.

**The fix, and why it is not in this change.** Read only the tail: walk the
transcript container's children from the end, accumulating text until there is
enough, so the cost is proportional to what is read and not to what exists.
That requires giving up character offsets as the way progress is tracked, and
the replacement has to be exact. Two candidates, both with a sharp edge:

- *Match the overlap by content* — remember the last few thousand characters
  scanned and find them in the next read. On a transcript with long repeated
  passages, `lastIndexOf` can land on a later occurrence than the true one, and
  the text between is never scanned.
- *Mark the position structurally* — hold a reference to the last element
  scanned and its text length at that moment. Exact, and it needs a way to find
  the container that holds the turns, on twenty-three products that do not
  agree about their DOM, with a fallback for when the marked element is
  recycled by virtual scrolling.

**Decision.** Keep the whole-text read, with the three mitigations, and state
the residual cost in LIMITATIONS §15d. The second candidate is the right
design and is worth doing properly rather than quickly: a mark that is wrong
means a reply that is never scanned, and a silent miss is not an acceptable
price for a second of smoothness on a slow machine. What is in place is honest
about its cost; what would replace it must be provably honest about its
coverage first.

---

### 36. Decode what is decodable; do not normalise what needs a position map

**Context.** Measured on `AWS_ACCESS_KEY_ID=AKIA…`, nine of fourteen encodings
of the same assignment produced verdict `clean`. Base64 was one of them, which
matters more than the others combined: a Kubernetes Secret's values are always
Base64, so the single most common way a real credential appears in text a
developer pastes was the way this engine could not see.

The engine already knew how to decode. `decodesToText()` has been in
`rules.js` since the entropy detector shipped, and it is used to decide that a
high-entropy value is "an encoded config" and therefore *not* worth reporting.
The capability existed and was pointed at suppression.

**Decision.** `src/encoded.js` finds decodable runs — Base64, Base64url,
percent-encoding, hex, HTML numeric entities, `\x`/`\u` escapes — decodes
them, and hands the result back to `scan()`. Nothing in it knows what a secret
looks like; the detectors stay the single source of truth.

Three constraints, each a constraint rather than a nicety:

- **It can only add.** A decode never clears a finding, lowers a severity, or
  turns `partial` coverage into `clean`. If a decode is wrong the worst case is
  a finding nobody wanted, never a secret waved through. A test asserts it.
- **It is bounded.** 64 candidate runs, 256 KB decoded, two decode layers (a
  Secret holding a kubeconfig needs two; a third is somebody probing), and a
  minimum run of 24 characters so a UUID is not decoded on every sighting.
- **It says the finding was encoded.** The span is the *encoded run*, because
  a value that is not literally in the text cannot be replaced by itself. So
  `match` is the run, redaction swaps the whole encoded value for a
  placeholder, `preview` masks what was inside, and `fingerprint` digests the
  decoded value — so the same key recognises itself whether it arrived plainly
  or Base64'd.

**What it cost, which is the part that decided it.** On 88,166 files and 412.8
MB of real source: 7,958 findings before and 7,958 after, 342 alarms (0.39%)
before and 342 after, throughput 6.1 → 4.5 MB/s. Identical detection on
ordinary code, 26% slower. Strictly more coverage on encoded secrets for no
false positives at all is a trade worth taking; the threshold is what buys it
(`critical` and `high`, nothing advisory — an email in a Base64 blob is a test
fixture).

**What was deliberately not built: a normalisation layer.** Three cases remain
uncaught and they share a cause.

- A key split across a `\` line continuation is two fragments; no detector can
  match either half.
- A key written in fullwidth or confusable characters needs NFKC.
- Both of these are *normalisations* rather than encodings: they rewrite the
  text everywhere rather than inside a delimited run, which means reporting a
  position in the original requires a cumulative index map from the normalised
  copy back to it. Without that map, a finding's span is wrong, and a wrong
  span means redaction removes the wrong characters — which is worse than not
  finding the secret, because it looks like success.

That map is buildable and is the right next step for this layer. It is not
worth building halfway, and the second case is the weaker motive anyway: it is
a deliberate evasion rather than a format somebody's tooling produces, and the
person Chhanni protects is not the person it would be fighting.

**Also not done, and stated so nobody infers it:** a secret inside a gzip or
zlib stream inline in a prompt is not decompressed (files are different — a
`.docx` is a ZIP and is extracted), and an encrypted value is not readable at
all.

---

### 37. A self-test, because "installed" is not "working"

**Context.** Every other section of LIMITATIONS is about the gap between what
Chhanni claims and what it does. This is about the one claim nobody could
check. The popup says which sites are on the match list — a fact about
configuration — and nothing answered the question a person actually has:
*does this work on this page, right now, in this browser, with my settings?*

Nothing else answers it either. The panel appearing is not proof; it appears
on a page whose send guard is broken too. A green CI badge is a claim about a
machine that is not theirs.

**Decision.** A button in the popup, on a watched tab, raises a card on the
page with a line to paste. The person pastes it into their own composer,
through the real paste path, and the card says what happened.

The value is `AKIAIOSFODNN7EXAMPLE`, which AWS publishes in its own
documentation. That single choice is what makes this honest rather than
reckless: if every guard in the extension failed at once, what reaches the
provider is a string from a public manual. A test that risked a real
credential to prove a tool protects credentials would be absurd.

**What a browser test found, which changed the design.** The first version
asked the *guard* what had happened, via a hook in the paste path. In `off`
mode the paste handler returns before any hook runs — so the credential went
into the composer and the card sat on "waiting for the paste" forever. A
self-test that cannot tell *nothing is protecting this page* from *you have
not pasted yet* is worse than no self-test, because the person reads the
second one and the truth is the first. The card watches the composer now.

A second browser test found the card sitting on top of the message box it was
asking the person to paste into — bottom-left is where every product on the
match list puts its composer. It is top-left, which also keeps it clear of the
panel at bottom-right so both can be read at once. Neither of those was
visible from reading the stylesheet.

**Scope, so the card does not overclaim.** It exercises the paste path, not
the click, the Enter key, the form submit or a file attachment. And it proves
nothing about the provider: *a mock recorded nothing* and *your real provider
received nothing* are different claims, and TESTING.md § 2 is how to check the
second by hand.

---

### 38. Ship the licence of the thing you redistribute

**Context.** The extension bundles Inter rather than loading it from
`fonts.googleapis.com`. That is the right call for a specific reason: a webfont
request would tell a third party, every time this UI opens, that somebody is
being shown a warning — and it would falsify the one promise the project
makes, which is that nothing leaves the machine.

**The bug.** Bundling has a condition attached, and it was not met. OFL-1.1,
clause 2, verbatim:

> Original or Modified Versions of the Font Software may be bundled,
> redistributed and/or sold with any software, provided that each copy
> contains the above copyright notice and this license.

*Each copy.* The store package is a copy. It contained `fonts/inter.woff2`,
`fonts/inter.css`, and no licence file of any kind — not Inter's, not the
project's own. What stood in for it was a comment in the CSS saying "Inter is
OFL-1.1 licensed, so redistributing it here is permitted", and a line in the
README. Neither is inside the ZIP, and a comment asserting that a licence
permits something is not the licence.

For a project whose entire argument is that a claim has to be checkable, this
was the argument pointed the wrong way: it shipped somebody else's work on the
strength of an unaccompanied assertion about their terms.

**Decision.** `extension/fonts/LICENSE-Inter.txt` holds the copyright notice
and the full OFL-1.1 text, fetched verbatim from the Inter project rather than
reconstructed, and `scripts/build.js` carries it into both packages. A check in
`scripts/check-docs.js` fails the build if a `.woff2`, `.ttf` or `.otf` ever
sits in `extension/fonts/` without a licence beside it carrying a copyright
notice. Removing the file to see the guard fire is how it was verified.

---

### 39. Not Google Sans Flex, and not Material 3 — for the same reason

**Context.** Both were raised as a design direction: adopt Material 3
Expressive, and use Google Sans Flex as the typeface.

**What is true about the licence.** Google Sans Flex *is* available —
`google/fonts/ofl/googlesansflex/OFL.txt` carries "Copyright 2015 The Google
Sans Flex Authors" under SIL OFL 1.1, confirmed at the repository rather than
from the coverage of its release, some of which says "no attribution required"
and is wrong in exactly the way decision 38 was wrong. So this is a design
question, not a legal one.

**Decision: keep Inter, and do not adopt Material 3.** The reason is not taste,
and it is not inertia.

Chhanni draws a panel on top of somebody else's product, and four of the
twenty-three products it draws on are Google's — Gemini, AI Studio,
NotebookLM, and Google's Copilot surfaces sit on that list. A warning rendered
in Google's brand typeface, in Google's design language, on top of Gemini,
reads as something Google shipped. It is not, and the one thing this extension
cannot afford to be confused about is who is making the claim: the entire
product is a second opinion about what a provider is being sent. A second
opinion that looks like it came from the provider is worth nothing.

The same argument runs the other way on ChatGPT and Claude, where Material 3
would read as a Google surface pasted onto a competitor's page — which is
noise at best and a trust problem at worst.

What an overlay actually needs is to be legible on, and visually distinct
from, every host it sits on. That is what the current treatment is for: a
neutral glass panel, system-adjacent type, no vendor's visual signature. It
should stay neutral as the hosts redesign around it.

**Cost of being wrong.** If this is wrong, it is wrong in the direction of
looking plainer than it could. That is recoverable. The other direction —
shipping something that implies an affiliation nobody granted — is a
trademark question and a trust failure at once, and it is not.
