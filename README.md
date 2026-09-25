<div align="center">

# Chhanni

**छन्नी** — *a sieve*

### Your prompt leaves your machine the instant you press Enter.<br>Chhanni looks at it first.

**`99.88%` precision · `95` detectors · `8` scripts · on-device ML · `0` network permissions**

<img src="docs/images/panel.png" alt="Chhanni: exposure 90 of 100, 184 customer records detected in a pasted export" width="470">

</div>

---

**77% of employees paste into AI tools. 34.8% of what they paste is sensitive —
up from 11% in 2023. 82% goes through personal accounts.**
([Cyberhaven, 2026](https://www.cyberhaven.com/blog/sensitive-data-flowing-into-ai-tools))

Not careless people. Tired people, at 11pm, debugging something — because the
fastest way to get help is to paste the whole thing.

Chhanni reads it first, on your device, and gives you one number.

## Not only for engineers

The usual version of this tool scans for API keys. That is **32.8%** of what
actually leaks. The rest is customer data, board material, contracts and HR
records — and a regex over `AKIA` sees none of it.

| You are | You paste | Chhanni says |
|---|---|---|
| **Support** | A customer export from the admin panel | **90/100** — *184 records of personal data — name, email and phone. A bulk disclosure, not a single value.* `GDPR` `DPDP Act` |
| **Founder** | A board update before the announcement | **93/100** — *Legally privileged. Possible inside information.* `SEC` `SEBI` `UK MAR` |
| **HR** | A compensation review | **79/100** — *Compensation ×3. Health information ×2.* `HIPAA` `GDPR` |
| **Engineer** | A failing deploy's `.env` | **88/100** — *IAM key for AWS account 5810-3995-4779, decoded offline from the key itself.* |
| **Anyone** | An email about a customer | **58/100** — *Person name ×2. Postal address.* `GDPR` `DPDP Act` |
| **Anyone** | A web page pasted in for summarising | **critical** — *contains instructions aimed at an assistant. You are the carrier here, not the target.* |

Then it offers to **redact and continue** — because the model never needed your
real key, or your customers' real emails, to answer the question.

## It reads sentences, in eight scripts

<img src="docs/images/prose.png" alt="Names and a postal address found in an ordinary email" width="440">

Most personal data is not in a database export. It is in a sentence — and the
sentence is not always in English.

Chhanni ships a **21 KB logistic regression** (16,384 hashed character
features, trained on 30,675 names from 75 locales) for scripts that have case,
and a **10,237-name gazetteer** for the ten scripts that do not: Arabic,
Hebrew, Devanagari, Bengali, Tamil, Telugu, Thai, Han, Hangul, kana.

```console
$ node bench/ner.js
34 annotated documents · 13 of them hard negatives

  names      precision 97.8%   recall 100.0%   F1  98.9%
  addresses  precision 100.0%  recall 100.0%   F1 100.0%
```

**The honest part:** the classifier alone scores **F1 71.7%** and more training
does not move it. A Yoruba place name and a Yoruba person name share their
morphology; `Austin`, `Paris` and `Virginia` are names *and* places. Character
evidence cannot settle that — an honorific in front, or the word "region"
after, can. The gap between 71.7% and 98.9% is the design, and
[docs/NER.md](docs/NER.md) shows the whole log-odds table.

## The measurement that changed the product

Every benchmark in this repository said 100%. Then I scanned **10,472 files of
real public source** — express, flask, axios, prettier, github/gitignore — that
nobody wrote for my benchmark.

**601 findings. One every 17 files.** Almost all wrong. *None* of them
detectable from the synthetic corpus.

| What fired | On what |
|---|---|
| `phone_india` ×411 | a Prettier formatting fixture of arbitrary integers |
| `credential_in_prose` | `password: urlPassword` — that's JavaScript |
| `prompt_injection` | a **.gitignore** explaining "ignore rules" |
| zero-width detection | Devanagari and emoji, where ZWJ is *required* |
| `payment_card` | a 15-digit window starting `34` that passed Luhn by chance |

**601 → 129, one every 81 files.** Every fix is locked behind a test using the
exact string found in the wild. `node bench/wild.js` reproduces it.

That is the difference between a benchmark and a product.

## Measured, not asserted

Nobody else in this category publishes a number. The only public figures come
from academic work on secret scanners
([Rahman et al., 2023](https://arxiv.org/pdf/2307.00714)):

| Tool | Precision | Recall |
|---|---|---|
| GitHub Secret Scanner | 75% | — |
| Gitleaks | 46% | 88% |
| TruffleHog | — | 52% |
| "Commercial X" | 25% | — |
| **Chhanni** — credentials | **99.88%** | **99.88%** |
| **Chhanni** — names in prose | **97.8%** | **100%** |
| **Chhanni** — addresses | **100%** | **100%** |

4,247 cases over ten seeds, from a seeded PRNG so no real credential is
committed here. Method, per-seed results and **what the numbers do not say** in
[docs/BENCHMARK.md](docs/BENCHMARK.md) — including why
[SecretBench](https://arxiv.org/pdf/2303.06729) cannot be run here (it requires
a signed data agreement; `bench/secretbench.js` is written and waiting) and the
honest limit that a check digit can never reach zero false positives.

## Why it is right so much more often

Six independent filters, each allowed to reject:

```
candidate → literal prefilter → shape gate → pattern → check digit → benign shape → context → overlap → finding
```

| | |
|---|---|
| **Check digits** | Luhn, Verhoeff (Aadhaar), mod-97 (IBAN), mod-36 (GSTIN), mod-11 (CPF/CNPJ), mod-89 (ABN), CRC32 (GitHub) |
| **Issuer ranges** | Luhn alone accepts ~1 in 10 random numbers. A card must also start where a network issues, *at a length it issues* — which is what stops a 15-digit IMEI being called a payment card |
| **Benign shapes** | UUIDs, git SHAs, sha256 digests, epoch timestamps, and **code identifiers** — `password: urlPassword` is JavaScript |
| **Required context** | Nine digits are nine digits until something says "SIN". Ten digits are not a phone number on their own |
| **Offline decoding** | The **AWS account number is recovered from the key itself** — base32 and a bit shift, no API call. `alg:none` JWTs escalate to critical |

**95 detectors. 27 prove the match**; the rest match a prefix nothing else uses
and are labelled `shape`, not `proof`, everywhere they appear.

Coverage is global: Aadhaar, PAN, GSTIN, IFSC, UPI and Indian DL/passport/voter
ID alongside CPF/CNPJ (BR), SIN (CA), NINO (UK), ABN/TFN (AU), EU VAT, ISIN,
IMEI, SSN and IBAN — plus ~45 vendor credentials across cloud, source, AI,
payments and platform.

## 14.3 MB/s, with everything on

A 46 KB paste, 95 detectors, table detection, the prose pass and injection
detection — **3.2 ms**. It was 11.1 ms with *fewer* features.

- **A single-pass shape gate.** Twenty detectors have no literal to filter on
  because their patterns are pure shape. One walk of the string yields the
  longest digit, uppercase, alphanumeric and base64 runs; a pattern needing
  thirteen consecutive digits never runs on a document whose longest run is four.
- **Aho–Corasick** — one O(n) pass instead of ~250 `String.includes` passes.
- **Regexes compiled once**, not 95 times per scan.
- **Bounded table processing** — a 5,000×60 export went 3,346 ms → 504 ms while
  still reporting the true row count.

An optimisation that can change a result is a bug, so two tests assert exact
equivalence.

## It reads attachments, and fixes them

People do not only paste secrets — they **attach** them. Chhanni intercepts
drops and file pickers, reads text-like files locally, and offers something no
other tool does: **attach a redacted copy instead.** Same name, same type,
secrets replaced, everything the model needs left intact.

Files it cannot read — images, PDFs, office documents — now **say so**, rather
than letting silence imply they were checked.

## It watches what comes back

Nobody scans the response. Two things there are worth catching: the model
echoing your credential into a transcript that is now shared and exported, and
an **indirect prompt-injection payload** (OWASP LLM01) arriving in the answer,
aimed at whoever reads it next.

A quiet notice, not a panel — the text has already arrived, so blocking it
would be theatre.

## For organisations, without a console

The obvious way to sell this to a company is a cloud console: rules down,
findings up. The second half would make every claim in the threat model false.

Policy arrives through **`chrome.storage.managed`** — Windows GPO, a macOS
profile, Chrome Enterprise, Firefox `policies.json`. The browser hands it over
locally. Policy flows in; nothing flows out; **no permission is added**.
Internal codenames are matched on the device and never ship in the package.

## It makes no network call

There is no `fetch` in the extension. The manifest requests **one** permission —
`storage`, for your settings. Even the font is bundled locally, because a
webfont request would tell a third party you are being shown a warning.

CI fails the build if any shipped module references a network API, or if the
permission set changes.

## Install

```console
git clone https://github.com/SanamBhanuPrakash/Extension chhanni && cd chhanni
node scripts/build.js
```

`chrome://extensions` → Developer mode → **Load unpacked** → `extension/`.
Firefox: `about:debugging` → **Load Temporary Add-on** → `dist/firefox/manifest.json`.

**CLI** — no install, zero dependencies:

```console
node bin/chhanni.js scan .          # exit 0 clean, 1 findings, 2 blocking
node bin/chhanni.js redact < prompt.txt
node bench/run.js && node bench/ner.js && node bench/wild.js
```

```sh
# .git/hooks/pre-commit — the same rules that guard your chat box
git diff --cached --name-only -z | xargs -0 node bin/chhanni.js scan --quiet
```

**Publishing it costs US$5, once.** Chrome Web Store charges a one-time $5 fee
and covers Chrome, **Brave**, Opera, Arc and Vivaldi. Firefox AMO and Edge
Add-ons are free. Store assets are generated at the required sizes in
`docs/store/`; requirements are in [docs/PUBLISHING.md](docs/PUBLISHING.md).

## Documentation

| | |
|---|---|
| [ARCHITECTURE](docs/ARCHITECTURE.md) | Module graph, the four interception flows, the gating stack, storage split |
| [BENCHMARK](docs/BENCHMARK.md) | Every number, how to reproduce it, and what it does not say |
| [NER](docs/NER.md) | The on-device model, its 71.7% ceiling, the context layer, eight scripts |
| [THREAT-MODEL](docs/THREAT-MODEL.md) | Nine threats with mitigations, and an explicit not-covered list |
| [PRIOR-ART](docs/PRIOR-ART.md) | Who did this first, who sells it, what this lacks |
| [ROADMAP](docs/ROADMAP.md) | Where the exposure is, and what is genuinely left |
| [PUBLISHING](docs/PUBLISHING.md) | Store requirements, fees, listing copy |
| [DECISIONS](docs/DECISIONS.md) | Nineteen decision records, each with its cost |
| [CHANGELOG](CHANGELOG.md) · [PRIVACY](PRIVACY.md) | |

## What it does not do

- **Images, PDFs and office documents are not read.** A screenshot of a
  dashboard is a real, unhandled leak. It says so rather than staying silent.
- **The gazetteer cannot generalise.** A Devanagari name nobody wrote down is
  missed, and Devanagari coverage is thin — 93 entries is not a serious source.
- **No coreference, no organisation disambiguation.** "She said the invoice was
  wrong" is not linked back to Priya; the one remaining name false positive is
  a company read as a person.
- **This idea is not new.** [Casper](https://arxiv.org/abs/2408.07004) published
  the architecture in 2024; **LayerX sold to Akamai for ~$205M in July 2026.**
  The gap that is real is that nobody publishes accuracy.
- **It is advisory.** "Send as-is" exists on purpose. A guardrail, not an
  enterprise DLP control, and it should not be sold as one.
- **It names regulations; it does not make you compliant.**

## Tests

```console
$ node --test test/*.test.js
# tests 66
# pass 66
```

Checksums against known-good and known-bad vectors, a proof that the
Aho–Corasick prefilter returns exactly what `includes()` would, crash-safety
across malformed input and 3 MB pastes, a test that a throwing rule degrades
only itself, **and every real-world false positive locked behind a test using
the exact string found in the wild.**

Two benchmark gates in CI: 99% on credentials, 90/95% on names. A feature that
lowers precision does not ship, however good the demo.

## Licence

MIT. Inter is bundled under the SIL Open Font License 1.1.
