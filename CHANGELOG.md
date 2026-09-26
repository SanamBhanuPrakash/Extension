# Changelog

## 0.3.0 — 2026-09-26

The release that opened the attachment, and then measured itself against
87,306 files of real source.

### It reads the file now

Five new modules, still zero dependencies. `DecompressionStream` is already in
every browser and in Node, and it does both `deflate-raw` (ZIP) and `deflate`
(PDF `FlateDecode`), which is the whole reason this is possible without
shipping a parser.

- **DOCX, XLSX, PPTX, ODT, ODS, ODP** — unzipped and parsed in the page. Tables
  and sheets are emitted as comma-separated lines so a spreadsheet of six
  employees reads as *one bulk disclosure of six records* rather than thirty
  findings. Document properties are read too: an Author field is a person's
  name.
- **PDF** — content streams inflated, `ToUnicode` CMaps applied, `TJ` kerning
  below −120 read as a space. Every `stream…endstream` block is scanned rather
  than the cross-reference table walked, so a linearised, incrementally-updated
  or slightly damaged PDF still yields its text.
- **JPEG, PNG, HEIC, AVIF, WebP, GIF** — EXIF TIFF IFDs, GPS converted to
  decimal degrees, Artist, Copyright, Owner, camera make/model/serial,
  software, capture time; PNG `tEXt`/`iTXt` chunks.
- **Routing is by magic bytes, never by extension.** A `.txt` that is really a
  ZIP and a `.jpg` that is really a PDF are exactly the cases where being wrong
  matters.

**There is no OCR, and there will not be.** Tesseract's WASM build plus one
language model is several megabytes: bundling it roughly triples the package
and invites the "obfuscated blob" question at store review, and fetching it on
demand breaks the only promise this project makes. So a screenshot's pixels
stay unread — and the panel names the file and says exactly that, rather than
letting silence imply it was checked.

### And hands it back

Four rewrite modes, and the panel says which one it will use, per file, before
the button is pressed:

- a `.env` comes back as a `.env`, redacted in place;
- a `.docx` comes back as `contract.docx.redacted.txt` — because a `.docx` is a
  ZIP of XML parts held together by relationship ids, and re-zipping a
  placeholder into one produces a file that opens differently or not at all;
- a photograph comes back as **the same photograph with its metadata gone**.
  `stripImageMetadata()` drops JPEG APPn segments and PNG ancillary chunks and
  copies the image data through untouched. Verified by Chromium's own decoder:
  16×16 before, 16×16 after, 572 bytes → 333, EXIF gone;
- a file that can be neither rewritten nor stripped comes back unchanged, and
  the panel says so.

`chhanni strip photo.jpg` does the same from the command line, and
`chhanni scan` reads documents too.

### Measured against 87,306 files

The benchmark now counts **alarms**, not findings — a file full of example
email addresses produces findings and no interruption, and the number that
decides whether anyone keeps this installed is how often the panel appears.

| | alarms | one every | blocking |
|---|---|---|---|
| before | 405 | 216 files | 282 |
| after | **337** | **259 files** | **212** |

Better precision *and* seven more detector classes. Nine false-positive
classes fixed, every one a real line from a real repository and every one now
pinned by a test carrying that exact string:

- **`aadhaar` 135 → 46** — the middle of a UUID, an AWS account number (also
  twelve digits), a coordinate's decimals, a timestamp. Verhoeff accepts one
  random twelve-digit number in ten and this fires at *critical*.
- **`payment_card` 96 → 9** — the fractional part of a latitude.
  `-0.6358599286615808` holds sixteen digits that pass Luhn in a Discover
  range, and `\b` does not help because `.` is not a word character. The first
  version of the fix then rejected `Card on file 4242 4242 4242 4242.` — a
  sentence-final period is not a decimal point, and the digit on the far side
  is what decides. Caught by a `.docx` fixture.
- **`isin` 21 → 0** — the last group of an uppercase UUID. An ISIN starts with
  an ISO 3166 country code; `CB` is not one.
- **`iban`** — mod-97 alone accepts about one string in ninety-seven of the
  right shape. A benchmark seed found an Indian driving licence number,
  `BB7120133083564`, validating as a Barbados IBAN; Barbados IBANs are 28
  characters. Every country's IBAN length is fixed and published, so the
  validator now checks it, which turns a one-in-97 guess into a real proof.
- **`classification_marking` 53 → 15** — "This is for internal use only" is how
  every library labels a private API.
- **`health_information` 7 → 0** — "a *prescribed* notification" in Go,
  "*symptoms of* bugs" in the Rust book, "Node.js *diagnostic report*" — all at
  *critical* severity.
- **`prompt_injection` 19 → 7** — Django's lazy object "pretends to be" the
  class it wraps; axios documents "send the token to"; Ansible logs "no system
  message:".
- **`legal_hold` 20 → 8** — S3 Object Lock has a setting called "legal hold".
- **Khmer read as an attack** — U+200B is Khmer's word separator, and Thai's,
  Lao's, Myanmar's and Tibetan's. Django's Khmer translation carries fifty in
  one file.
- **Central Kurdish read as Trojan Source** — bidi isolates U+2066–U+2069 are
  how a Latin placeholder sits inside an Arabic-script sentence. Only the two
  *overrides* force a reading order against the characters' own direction.

The last two are internationalisation bugs, and neither was findable by
reasoning about the code.

### Secrets with nothing to name them

`unlabelled_secret` closes the gap every keyword-anchored scanner has: a token
in a format that did not exist when this shipped, pasted on its own with
nothing around it to say what it is.

Tuned against the corpus, not against intuition — 5,064 findings on the first
draft, **234 on the last, in 18 files out of 87,306**. The two statistics that
earned their place: `wordiness` (runs of four-plus lowercase letters per
character, which separates a random token from a name built out of words
without needing a dictionary) and `classTransitions` (0.62 for uniform base62,
0.1 for a long identifier).

### The leak with no pattern in it

> "Our company is acquiring Acme for $46M and the announcement is scheduled for
> October 12."

Not one credential, not one identifier, not one person's name — and the most
damaging sentence in the document. Six advisory signals: unannounced
transactions, negotiating positions, trade secrets before filing, unannounced
workforce decisions, live litigation, and internal cost and margin.

### Coverage, said out loud

- The popup states which of three states the current tab is in, reading the
  list from the manifest rather than from a second copy that had already
  drifted to twelve hostnames against the manifest's twenty-three.
- Where a site is not covered, **"Watch this site too"** requests the origin
  and registers the same content script, persisted across sessions.
  `optional_host_permissions` had been in the manifest since the first version
  and nothing ever asked for it.
- Under it: four things that are never covered, named rather than implied.

### Places a composer was hiding

- **Open shadow roots.** A paste event crossing the boundary is retargeted, so
  `e.target` was the host `<div>` and every editability test failed on it.
  Every interception point now reads `composedPath()[0]`. Reverting that one
  line turns the new browser test from "caught" back to "MISSED".
- **Iframes.** `all_frames` and `match_about_blank`. A subframe holds one idle
  `MutationObserver` and imports none of the engine until something typeable
  appears in it.
- **Response scanning** had the same blind spot from the other direction:
  `innerText` stops at a shadow boundary, so a chat UI built on web components
  would have had its whole transcript invisible.

Closed shadow roots remain unreachable. That is the platform, not a bug.

### Fingerprints that mean it

SHA-256 over a per-install random salt, truncated to 128 bits, replacing a
32-bit FNV-1a hash the documentation called "one-way". Pure JS and synchronous
on purpose: `crypto.subtle` is async, and making every fingerprint a promise
would turn the whole engine async for nothing a user could see. Verified
against `node:crypto` on 512 vectors.

The salt matters more than the algorithm did — an email address has perhaps
thirty bits of real entropy, so an unsalted digest of one is recovered by
trying candidates whatever the hash.

### Both ends of a large paste

Above 2 MB the scanner took a prefix. An `.env` dump, a key block or a
signature is at the *end* of a file far more often than in the middle. The same
budget now buys a 1.4 MB head and a 600 KB tail, joined by a seam no detector
can match across, with every offset and line number mapped back onto the
original input.

Raising the prose-pass ceiling from 200 KB to 800 KB exposed a performance bug
that had been there all along: `--cpu-prof` put 73% of the scan in a function
that walked the text from position zero for every finding. One pass for the
newline offsets and a binary search per finding:

| | before | after |
|---|---|---|
| 200 KB | 798 ms | **246 ms** |
| 800 KB | 5,156 ms | **431 ms** |

### Numbers that were reading as verdicts

- The score now carries *"a priority, not a probability"* under the headline.
- The regime chips are headed **"Rules about this kind of data"** and carry a
  sentence saying that whether any regime is engaged depends on jurisdiction,
  purpose and lawful basis — none of which a content script can see.
- Advisory findings carry a **context** tag, and the panel says under the
  button what redacting will and will not do, including the case where the
  honest answer is that nothing can be replaced and this is a decision, not a
  fix.

### And a document that owns the rest

[docs/LIMITATIONS.md](docs/LIMITATIONS.md) — eighteen sections, every known gap,
each either fixed with a note on how or unfixed with a note on why. Written
because a boundary nobody states is a boundary everybody crosses.

### Also

- 96 tests, up from 66, including a document suite that runs the extractors
  against real DOCX, XLSX, PPTX, ODT, PDF, JPEG and PNG fixtures built by
  `tools/make-fixtures.py` with nothing but the Python standard library.
- The JPEG fixture is now a genuinely decodable 16×16 image. The old one was
  SOI + APP1 + EOI: enough to read EXIF out of, not enough to ask whether
  stripping it left a picture behind.
- `scripts/render-ui.mjs` drops real fixture bytes on a real composer in real
  Chromium, and checks the shadow-root and iframe paths.
- NER trims heading nouns off the ends of a candidate run, because a document
  extractor hands over the title first and "Master Services Agreement" has
  exactly the shape of a three-part name.
- Ten-seed sweep: 4,244 cases, precision and recall both 100% — and the sweep
  itself found two real bugs, on seeds 20260927 and 77777: the leading twelve
  digits of a Google OAuth client id read as an Aadhaar number, and an Indian
  driving licence number read as a Barbados IBAN. Both are fixed and both now
  have a test.
- `tools/make-fixtures.py` writes a fixed timestamp into every ZIP entry, so
  regenerating the fixtures is byte-identical and CI can check that the
  committed ones match the generator.

## 0.2.0 — 2026-09-25

The release that made every claim measurable, and then fixed what the
measurements exposed.

### Measured against real code, for the first time

`bench/wild.js` scans public repositories nobody wrote for this benchmark —
10,472 files, 23.4 MB of real source from express, flask, axios, prettier and
github/gitignore. The first run produced **601 findings, one every 17 files**.
Almost all were wrong, and none of them showed up in the synthetic corpus,
which was reporting 100%.

Seven false-positive classes, each found in real code and each now fixed and
locked behind a test:

- **`phone_india` matched any ten digits** — 411 hits in a single Prettier
  formatting fixture full of arbitrary integers. Now requires a country code,
  separator formatting, or a word nearby that says what the number is.
- **`credential_in_prose` matched JavaScript** — `password: urlPassword`,
  `credentials: isCredentialsSupported`,
  `password = utils.getSafeProp(configAuth, 'password')`. Identifier-shaped
  values are now rejected, with camelCase-from-whole-words as the test, because
  a mere case change would discard real passwords like `Xq7vTm2Lp`.
- **`prompt_injection` flagged a .gitignore** explaining "ignore rules", a
  threat model discussing "leak secrets", and API docs saying "send the token".
  Imperatives now need a deictic target ("previous instructions") and
  exfiltration needs a destination.
- **Zero-width detection flagged Devanagari, Persian and emoji.** ZWJ and ZWNJ
  are required for correct rendering in those scripts; counting them was wrong.
- **`payment_card` matched a window into a longer digit stream** — fifteen
  digits beginning `34` that passed Luhn by chance. A card must be a whole
  number.
- **A bare CVE identifier** in a changelog is public information, not incident
  detail.
- **`classification_marking` matched the verb "classified"**, and
  `health_information` matched a `Diagnosis/` build directory.

**Result: 601 → 129 findings, one every 81 files.** What remains is email
addresses in `CODE_OF_CONDUCT` files, documentation passwords indistinguishable
from real ones, and one genuine private key in a test fixture.

### Names and addresses, in eight scripts

- Non-Latin name detection for **Arabic, Hebrew, Devanagari, Bengali, Tamil,
  Telugu, Thai, Han, Hangul, kana, Cyrillic, Greek, Armenian and Georgian** —
  10,237 names. Capitalisation is a Latin-shaped assumption, and scripts
  without case need a gazetteer, not a classifier.
- Dense scripts (Han, Thai, kana) use a sliding window up to the longest
  gazetteer entry; a four-character ceiling had silently missed every Thai name.
- Cased non-Latin scripts require a gazetteer hit or real context: the
  classifier's negatives are Latin-only, so it scored every Cyrillic word as a
  name, including the verb `Говорил`.
- **Names 97.8% precision / 100% recall (F1 98.9). Addresses 100% / 100%**,
  across 34 annotated documents, 13 of them hard negatives.

### New detection

- **Indirect prompt injection** (OWASP LLM01) — the one check where the user is
  the carrier, not the leaker. Override imperatives, role reassignment,
  exfiltration requests, tool abuse, CSS-hidden text and invisible Unicode.
- **Table columns now produce findings for their own cells**, so a pasted
  export is fully redactable — including the `name` column, which no
  value-level rule could ever identify.
- **Response-side scanning**: a quiet notice when the model's reply echoes a
  credential back, or carries an injection payload aimed at whoever reads next.
- **Organisation policy** through `chrome.storage.managed` — GPO, macOS
  profiles, Chrome Enterprise, Firefox `policies.json`. Policy flows in;
  nothing flows out; no permission is added. Internal codenames are matched
  locally and never shipped in the package.

### Speed: 3.2 → 14.3 MB/s

With 95 detectors, table detection, the prose pass and injection detection all
enabled — more than four times faster while doing considerably more.

- **A single-pass shape gate.** Twenty detectors have no literal to prefilter
  on because their patterns are pure shape. One walk of the string now yields
  the longest digit, uppercase, alphanumeric and base64 runs; a pattern needing
  thirteen consecutive digits never runs on a document whose longest run is
  four.
- **Aho–Corasick** for the prefilter: one O(n) pass instead of ~250
  `String.includes` passes.
- **Regexes compiled once** at module load, not 95 times per scan.
- **Name detection matches capitalised tokens directly** rather than tokenising
  the document: 6.1 ms → 0.69 ms.
- **Address lines gated** on one regex before tokenising, and **table rows
  bounded** at 2,000 processed while still reporting the true count: a
  5,000×60 export went 3,346 ms → 504 ms.

### Also

- Generic composer detection, so the extension works on AI products that ship
  after this version does. 23 hosts in the manifest, plus optional permissions.
- Attachments that cannot be read now say so, rather than letting silence imply
  they were checked.
- Firefox build alongside Chromium, from one source.
- CI gates on both benchmarks, on the permission set, and on the absence of any
  network API.

## 0.1.0

First release. 30 detectors, checksum-verified matching, redact-don't-block,
no network permission.
