# Changelog

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
