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

---

### 40. The allowlist was going through Google's servers

**Context.** `chrome.storage.sync` is convenient and it is also a network
service: Chrome replicates it to every browser the person is signed into,
which means through Google's servers. Chrome's own documentation says not to
put confidential user information in it.

The options page wrote the whole policy there, and the policy contains
`allow` — the allowlist. That field is made entirely of strings somebody
typed *because they are sensitive*. "Never treat this as a finding" is how you
tell Chhanni about a customer's email address, an internal codename, a shared
test credential, a project whose name is not public.

**Why this is the worst kind of bug this project can have.** The claim was not
false about Chhanni's own behaviour. There is no `fetch` in the codebase, no
network permission in the manifest, and CI fails the build if a shipped module
references a network API. The claim was false about the *outcome*, and the
outcome is the only thing anybody cares about. "Our code makes no request" is
not an answer to "does my customer's address leave this laptop". A privacy
product that answers the second question with the first is doing the thing it
exists to stop.

**Decision.** Split by what a setting reveals. The interruption level and which
detectors are switched off go to `sync` — they say how cautious somebody is,
nothing about who they work with, and following them to a new laptop is the
point. The allowlist goes to `local` and never leaves the profile.

`extension/policy.js` owns the split and both readers use it, because two
copies of "which fields are safe to replicate" is exactly the kind of drift
where the wrong copy is the one nobody reads.

**Migration, which is the part that is easy to skip.** A profile that already
synced an allowlist has those values sitting in a replicated store. Reading
from somewhere else would fix the behaviour and leave the exposure. So the
first read moves them and **deletes the synced copy**, and the options page
says it happened rather than fixing it quietly.

Two browser cases assert this against the storage areas directly, and both
fail when the split is reverted.

---

### 41. "And continue" has to continue, and the verify step is the point

**Context.** On a send interception the panel's primary button says "Redact 2
and continue". The handler wrote the redacted text into the composer and
stopped. The person had to press Send again.

**Decision.** One action: transform, verify, send.

The middle step is why this is not simply `write(); resend()`. Writing to a
composer is a negotiation with somebody else's editor — a React textarea keeps
its own state, a ProseMirror surface keeps a document model, and
`writeComposer` reaches both through the paths that worked when it was
written. If a provider changes its editor, the write can silently fail to
take. Replaying the send on the strength of a write that did not land would
transmit the original secret while the panel said it had been redacted, which
is strictly worse than doing nothing at all.

So the composer is read back through the same accessor the send path uses, and
a fresh scan has to agree that what is there no longer carries the finding that
stopped the send. Only then is the send replayed. If the read-back disagrees,
nothing is sent and the panel says which of the two things went wrong.

A browser case covers it with a fixture whose editor is instrumented to refuse
Chhanni's write, because that is what a provider rewriting its composer looks
like from inside a content script.

---

### 42. Three modes, one table

**Context.** `scanPolicy()` put every severity but `critical` into the warn
set. `guardSubmission()` returned early in warn mode on any verdict that was
not `block`. Neither line is wrong on its own and the composition was a hole:

    pasted Google API key    panel appears
    typed Google API key     sends, in silence

`high` is twenty-five detectors including a Slack webhook, a SendGrid key, a
Twilio key, a Notion token and an IBAN. LIMITATIONS § 15c had listed `high` in
warn mode as "panel, send stopped" since 0.4.0 — the table was the
specification, it was right, and the code did not implement it.

The asymmetry is the part that matters. People do not only paste secrets, they
type them, and the weaker path was the one where nobody would have noticed.

**Decision.** The modes are a table in one place, which the paste path and the
send path both read:

               raises the panel on paste    stops the send
    strict     anything found                anything found
    warn       anything found                critical or high
    off        nothing                       nothing

Making the one row true again was the easy part; the fix is that there is now a
single declaration for both paths to disagree with, instead of two
implementations to drift apart. A browser case asserts that the paste path and
the send path *agree*, whatever the mode decides — which is the invariant, and
it would have failed before this.

`low` still does not stop a send in warn mode, and that is deliberate: a lone
email address is a `low` finding, and interrupting a send over one would make
the mode most people leave on unusable.

---

### 43. Protecting a value must not cost the formatting

**Context.** `writeComposer` selected the whole composer and typed a plain
string over it. For a textarea that is exactly right and nothing else would
work. For a rich composer it was destructive in a way nobody asked for.

A real AI prompt is not one line of plain text. It is a question, a code block,
a bulleted list of what has been tried, a link to a runbook, a bold phrase, a
closing paragraph. Pressing a button labelled "Redact 1 and continue" flattened
all of it. The value was protected and the work was gone.

**Why this needed a position map first.** The offsets a finding carries are
offsets into the text that was scanned, and that text came from `innerText` —
which collapses whitespace and synthesises line breaks from layout. An offset
in `innerText` does not correspond to any position in the DOM, so character
412 of it cannot be turned back into a range. Replacing part of a composer is
impossible until reading it produces a map as well as a string.

So `composerText()` walks the text nodes in order, builds the string itself
with a newline where a block ends, and records the span each node occupies.
`readComposer` uses it, which means the text that is scanned and the text that
can be edited are the same text by construction rather than by coincidence.

**Decision.** `replaceSpans()` replaces each sensitive range where it sits,
last span first so earlier offsets stay valid. A span that crosses a boundary
between text nodes is split and applied per node — the placeholder into the
first, the rest emptied — because joining two text nodes across a block
boundary merges the paragraphs, which is the same destruction in miniature.

Still through `execCommand('insertText')` with a selection, not by assigning
`data`: ProseMirror and Quill read the DOM back on `input` and update their own
model, and a write they never hear about is reverted on the next keystroke. The
selection is the narrow range instead of the whole composer. That is the entire
difference.

**What got stricter, which is worth stating plainly.** Because `readComposer`
now reconstructs block structure, the old whole-composer write produces text
that no longer matches what was intended — so on a rich composer the fallback
path fails the verify step from decision 41 and the send is refused. That is
the right outcome: flattening somebody's prompt is a change they did not ask
for, and refusing while saying so beats doing it quietly. But it means a rich
composer where span replacement cannot work has no redact-and-send path at
all, only "remove it yourself" or "send as-is". The panel says which of the
three things went wrong rather than blaming the editor in every case.

**Still not done.** Pseudonymisation of a *textarea* goes through the
whole-string path, which is correct there. Attachment rewriting is untouched.
And a provider that keeps its text in a model the DOM does not reflect at all
would defeat the map as surely as it defeats everything else — which is what
`test/provider/run.mjs` exists to find out.

---

### 44. Three tiers, because severity answers the wrong question

**Context.** The engine had grown broad enough to find emails, phone numbers,
names, addresses, tax numbers, business context and secrets — and it
interrupted for all of them the same way, because the only axis available was
severity.

Severity ranks how bad a finding is. The question somebody about to press Send
actually has is different: *is this abusable by whoever receives it*. Those
come apart, and the gap was making the product worse to use. A panel that
fires equally for an AWS key and for the email address in "please draft a
reply to priya@…" teaches people to dismiss it, and a dismissed warning
protects nobody.

**Decision.** `tierOf()` in `rules.js`, one tier per rule:

| tier | rules | treatment |
|---|---|---|
| dangerous | 70 | credentials, payment instruments, government identity numbers — stops a send in any mode |
| personal | 14 | emails, phones, names, addresses, tax and company numbers — said, offered an alias, not refused |
| context | 18 | the judgement detectors — describes what the text is *about*, nothing to replace, never blocks |

Enumerated rather than derived, because the mapping is not monotonic in either
direction: `email` is `low` and personal, `us_ssn` is `critical` and dangerous,
`gstin` is `medium` and personal, `pan_india` is `high` and dangerous. A unit
test asserts every rule lands in exactly one tier, so adding a detector forces
the question; an unknown rule is dangerous, never quiet.

The mode table's stop column is by tier now rather than severity. "Warn stops
`high`" was reasonable when it was written and grew into "warn stops
twenty-five things including an IBAN and a passport number"; the tier says
what was actually meant.

---

### 45. The alias offer leads where it helps

**Context.** "Redact and continue" was always the primary action.

For a credential that is correct. There is nothing to preserve about an API
key, and the useful outcome is that it is gone.

For personal data it was the wrong default, and it was working against the
thing this product is best at. Redacting "Priya Nair at
priya.nair@northwind-logistics.co.in" leaves the model guessing who it is
writing to. An alias leaves it able to write the reply while never learning
the address:

    Draft a reply to Person_A at person_a@example.invalid about order 874321

The task survives; the identity does not. That is the only transformation here
that gives something back rather than only taking something away, and burying
it behind a secondary button meant most people would never find it.

**Decision.** When nothing in the message is abusable and an alias is
possible, "Use aliases and continue" is the primary button and Enter does
that. With anything dangerous present, redaction leads as before — a
pseudonymised API key does not exist.

**What this is not.** It is not a new detector and not a new screen. The
pseudonymiser, the tiers and the panel all already existed; what changed is
which of two existing buttons is in front. The retention argument for this
product is that somebody keeps it installed because the task still worked
after Chhanni touched it, and a button they never saw cannot do that.

**Found while testing it:** `example.com` is deliberately excluded from the
email detector as a documentation domain, so the first version of "a lone
email does not block the send" asserted that a send went through when there
had never been a finding to stop it. A test that passes because its input
produces nothing is worse than no test.

---

### 46. The gate had the defect it was built to catch

**Context.** Decision 45 shipped a plan: `SYSTEM-DESIGN.md`, `V1-CONTRACT.md`,
`PROVIDERS.md`, a finite roadmap, and `scripts/gate.js` as the executable
definition of done. The argument was that prose cannot end an audit loop
because prose is not run, and a script can.

Then the plan itself was audited, and four of its criteria were not run
either.

- The provider criterion was hardcoded `blocked`. It never opened
  `PROVIDERS.md`. Somebody could have certified all five providers and the
  gate would still have refused, until a human edited the gate — which means
  the gate was never the authority. A human editing the gate was.
- The third-party benchmark criterion was `existsSync('/tmp/claude-0/wild')`.
  It checked that a directory was present on the machine that happened to run
  it. It did not measure an alarm rate; it asserted that a corpus existed and
  then reported the alarm rate as checked.
- The provider harness could return `PASS` from having observed nothing. If
  the browser was not signed in, or the API matcher did not match that
  provider's traffic, zero requests were seen and zero of them contained the
  sentinel. "No request contained the secret" is true of a page that never
  sent anything.
- The matrix the harness wrote and the schema the gate expected to read were
  never compared by anything.

Each is the same failure: **a surface that claims a stronger state than it
has.** That is the thing this product exists to catch when a composer does it,
and the proof machinery was doing it about the product.

**Decision.** Every criterion consumes evidence or says it cannot.

The provider criterion parses `PROVIDERS.md` and counts verdicts. The
benchmark criterion runs `bench/wild.js`, reads the alarm rate out of its
output, and fails below 10,000 files — because a rate measured on a few
hundred files is not a rate. `PASS` in the harness now requires a *control*
message to put a request on the wire first: if a harmless "what is the capital
of France" produces no observable request, the harness cannot see this
provider's traffic and the cell is `NOT TESTED`. And `check-docs.js` compares
the harness's path set against the matrix's markers, so the two cannot drift.

A fifth, found the same way: `scripts/package.js --verify` compares a fresh
build against the zip already in `dist/`, and reported "the package is not
reproducible" when the real finding was that the tree had been rebuilt since
that zip was written. Two different findings, one symptom, and only one of them
a defect. It distinguishes them now. The gate was never affected — it writes
first and verifies second — which is why this survived: the automated path was
correct and the path a person takes was not.

**What this is not.** It is not a loosening. The provider criterion is still
`BLOCKED` today, and still says so. What changed is that it is blocked by the
absence of evidence rather than by a constant, so the evidence can now
unblock it.

**Found while fixing it, twice.**

The "nothing sensitive reaches synchronised storage" guard in `check-docs.js`
took three attempts. The first used `[^.]{0,120}` as a "same sentence" window,
which can never span `chrome.storage.sync` because that string is full of the
dots the class excludes. The second widened the window to characters and
excluded any window containing a phrase like "never synchronised" — wide
enough that a legitimate neighbouring sentence switched the check off. Both
passed on exactly the drift they were written for. A guard that cannot fail is
indistinguishable from no guard, and is worse, because it reports `ok`.

The third stopped trying to police prose by proximity. `PRIVACY.md` states the
area in one fixed shape — ``**Your allowlist** (`chrome.storage.<area>`)`` —
and that area is compared to `LOCAL_FIELDS` in the code, with a separate check
that the file still says "never synchronised" in words. A contradiction
elsewhere in the file is a writing problem; this is the sentence a reader acts
on, and it is the one that is checked.

Then, while testing that the gate could read what the harness writes: the
harness replaced the whole of `PROVIDERS.md`, not its matrix. So the single
most valuable action anybody can take on this repository — signing in to five
products and certifying the boundary — would have deleted the five sections
that say what a cell means, which paths V1 promises, and why a pass expires.
And `check-docs.js` would still have reported that the documentation agreed
with the code, because every machine-readable invariant happened to live in the
part that survived. The harness rewrites the `## The matrix` section in place
now, refuses a file that has no such section rather than overwriting it, and a
guard asserts the other four sections are present. A proof machine whose
operation destroys the meaning of its own output is not a proof machine.

---

### 47. The exit code answers the question the flags asked

**Context.** The gate printed `PRE-PRODUCTION` and exited `0`, above a
document whose second paragraph said "the exit code is the answer to can this
ship".

It was not. It was the answer to "did anything fail". Those differ exactly
when a claim is unproven rather than broken, which is the state this
repository has been in for its whole life.

A script that announces the thing cannot ship and then reports success to its
caller is decision 46's defect again, in the one file that is supposed to be
immune to it.

**Decision.** Three modes and three codes, and the modes ask different
questions.

| | question | `BLOCKED` |
|---|---|---|
| `gate.js` | did I break anything | exits `0` |
| `gate.js --full` | did I break anything, browser included | exits `0` |
| `gate.js --release` | can this ship | exits `2` |

`0` the question was answered yes, `1` something is broken, `2` nothing is
broken and something is unproven. `--release` implies `--full`, because
deciding whether something can ship while leaving the browser suite unrun
would block on the gate's own laziness and then report it as doubt about the
product. `1` beats `2` when both apply: a broken repository is a more urgent
answer than an unproven one.

The codes are declared as a table in the script and `check-docs.js` compares
that table against the document, including that every declared code is
reachable from the exit expression.

**What this is not.** It is not a stricter CI. CI still runs the default mode
and still exits `0` on a blocked criterion, because a criterion this machine
cannot check is not a regression and failing every push over it would train
everybody to ignore the gate. `--release` is for the one decision it names.

---

### 48. V1 is ten cells; V1.x is forty and never finishes

**Context.** `V1-CONTRACT.md` said V1 ships when all five providers carry a
dated certification. `ROADMAP.md` said V1.x delivers "all five providers
certified across all ten paths". Those are the same sentence, so provider
certification was simultaneously the last blocker of V1 and the main content
of the release after it.

That is not a cosmetic overlap. If V1 waits for all fifty cells, V1 waits on
forty drivers against five products that redesign without notice, and V1 never
ships. A release criterion that cannot be met is not a high standard. It is an
unfinishable release with a high standard written on it.

**Decision.** The boundary is drawn where the evidence changes kind.

**V1 asks one question: does the boundary work against a real provider at
all?** Ten cells answer it — five providers across the two paths marked
`(V1)` in `PROVIDERS.md`, paste and typed-plus-Enter. Those are how every user
actually sends, and the harness drives them on any provider with no
provider-specific knowledge, so a `PASS` is evidence about the product rather
than about a driver somebody wrote for one site.

**V1.x asks a different question: does it keep working, across every way a
provider can be driven, after each redesign?** Forty cells, a driver per
provider per path, and a re-certification cadence. V1.x has no exit, and the
roadmap now says so: it is current when every cell is `PASS`, `UNSUPPORTED`,
or newer than that provider's last visible redesign — a condition that can go
false next month with nothing in this repository changing.

One rule crosses the line: a `FAIL` in **any** cell fails the gate outright.
A secret reaching a provider is the product failing, and the fact that the
roadmap assigns that path to a later release does not make the leak later.

**What this is not.** It is not a reduction in what gets tested. Nothing was
removed from the matrix and no cell was marked `UNSUPPORTED` to make a number
look better. Forty cells are still named, still `NOT TESTED`, and still
visible in the gate's own output, which reports them on a pass rather than
hiding them.

---

### 49. An invariant nothing executes is a comment

**Context.** Four claims in this repository were true by inspection and
unenforced by anything.

- **Every detector lands in exactly one tier.** `tierOf()` ended
  `return 'dangerous'`, so an unclassified detector silently became
  dangerous and the test asserting full coverage could not fail.
- **The allowlist is never synchronised.** `popup.js` declared its own
  `DEFAULTS` and wrote `policy` through `chrome.storage.sync` directly,
  bypassing the module that owns the split. One more field added to the popup
  and the allowlist would have gone back off the device.
- **The migration moves the allowlist to local storage.** It pushed the field
  name onto `migrated` *before* the writes, and reported success whether or
  not the synchronised copy was actually deleted. The failure mode is the
  interesting one: the UI would say the data had been brought back onto the
  device while a copy of it was still on Google's servers.
- **Two permissions, SHA-256 fingerprints.** `THREAT-MODEL.md` said three
  permissions and FNV-1a, `PUBLISHING.md` said three, `PRIVACY.md` described
  two stored things and placed the allowlist in `sync`. All four statements
  had been true once.

**Decision.** Each one is now executed.

`classify()` returns `null` for a detector no rule covers, `tierOf()` still
fails closed to `dangerous` for runtime safety, and the test asserts
`unclassifiedRules()` is empty — a distinction that lets the invariant fail in
the test suite without failing open in the product. `popup.js` imports
`readPolicy`/`writePolicy`. The migration reads both stores back and populates
`migrated` only when the local copy is present *and* the synchronised copy is
gone, with a distinct `migrationFailed` message for each half. And
`check-docs.js` now greps the permission count, the allowlist's storage area
and the hash out of the prose and compares them to the manifest and the
source.

Routing the popup through `policy.js` then broke the notice, which is worth
recording because it is the shape these fixes keep taking. The migration runs
on first read from whichever surface opens first. The popup is the likely first
reader and the popup does not show the notice; the options page does, and would
then find nothing stranded and say nothing. A privacy defect repaired silently
is not repaired — somebody who typed a customer's address into that box is owed
the fact that it had been leaving the device and has stopped. So the outcome is
persisted and survives the call that produced it, the options page clears it
once shown, and a failed migration is deliberately *not* cleared, because it
describes a condition that is still true.

`test/policy.test.js` tests this against a fake storage area that can be told
to lie, because the half-failure that matters is unreachable in a real profile:
every context that sees the change races to perform the migration with the real
API, so a stub installed in one of them does not hold. Nine cases, each run
against the previous code first — three fail on the unverified migration, one
on the lost notice.

**What this is not.** None of this is a feature. The user-visible behaviour is
identical in every case except one: when the migration cannot delete the
synchronised copy, the options page now says so, in red, instead of saying the
opposite.

**Found while fixing it:** the tier test passed against the broken
`tierOf()` and against the fixed one, so it proved nothing until
`classify()` existed. Every guard added in this pass was then run against the
drift it was written for, and each was confirmed to fail before being
confirmed to pass. That ordering is the whole lesson of decision 46.

---

### 50. The step between here and a release was the step no test touched

**Context.** For a month the answer to "what is left" was the same sentence:
*provider certification, about an hour for somebody with five accounts.* The
gate said it. `V1-CONTRACT.md` said it. `RELEASE-GATE.md` put a time estimate
on it.

`test/provider/run.mjs` opens with this, and has since it was written:

> The first run opens a visible browser and stops, so you can sign in to
> whichever providers you want covered.

There was no such code. No `readline`, no `stdin`, no wait of any kind. A
first run launched Chromium, drove all five providers straight into their
login walls, wrote `NOT TESTED` fifty times, and exited 2. The one action
standing between this repository and a finished V1 **could not have worked
for anybody who attempted it.**

Worse, it misdiagnosed itself. A missing composer was reported as
`this provider's markup has changed` — so a person with no ChatGPT account
would have been told ChatGPT had been redesigned.

Nothing caught either, and the reason is worth keeping: the only thing that
exercises those five entries is a person with five accounts, so this was the
single path in the project with no test, no CI step, and no second reader. It
was also the path with the highest value per minute spent on it.

**Decision.** The phase exists now: a tab per provider, a readiness probe that
distinguishes *signed in* from *not signed in* from *unreachable*, a printed
list, and a stop — with those tabs still open, so signing in happens in the
very browser that measures a moment later. `--signin` does that and nothing
else, so the human part and the measuring part are separable. `npm run
certify` is the whole thing.

Four tests cover it, against `file://` fixtures standing in for a signed-in
composer and a login wall, and they run in CI on every push. `--wait` forces
the pause over a pipe, because a pause reachable only behind
`process.stdin.isTTY` is a pause no test can watch — which is precisely how
the missing one survived. Each test was then run against the old behaviour:
removing the pause fails exactly one of them, removing the login-wall
diagnosis fails three.

**What this is not.** Not a feature. It is twenty lines that a header comment
claimed were already there.

**The general lesson, which is the reason this record exists.** A month of
work went into proving the product correct and none into the path by which
anybody would ever use it. Every audit in `DECISIONS.md` asked *is this
claim true?* and the claim that failed was not in the engine — it was the
sentence telling a person what to type. `docs/SHIP.md` exists so that path
has an owner, and its commands are now checked against `package.json` by
`check-docs.js`, because this project has shipped a documented step with no
code behind it once already.

