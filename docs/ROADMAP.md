# Roadmap

Where this goes, and why — written so the next decision can be argued with
rather than guessed at.

## The thesis

[Cyberhaven's 2026 figures](https://www.cyberhaven.com/blog/sensitive-data-flowing-into-ai-tools):
**77% of employees paste into AI tools**, 34.8% of ChatGPT inputs contain
sensitive data — up from 11% in 2023 — and **82% of those pastes go through
personal accounts**, roughly 14 a day, at least three of them sensitive.
One organisation in five has already had a breach tied to shadow AI.

Two things follow.

**First, the leak is not happening in the enterprise console.** It is happening
in a personal account, on a personal login, outside whatever the security team
bought. A control that only exists inside a managed browser profile does not
see 82% of the problem. A control that costs nothing, installs in one click and
sends nothing anywhere can.

**Second, the leak is not mostly source code.** 32.8% is code and credentials;
**18.2% is M&A documents and investment models**, and the rest is customer
data, financials and HR records. A tool that only reads regexes over API keys
serves less than a third of the actual exposure — which is the state this
project was in two versions ago.

## Now

- **102 detectors. 28 prove the match** with a check digit, an offline decode,
  an issuer range or a trained classifier. 100% precision and recall over 4,244
  reproducible cases — and one alarm every 259 files across **87,306 files of
  real public source**, which is the number that actually matters.
- **Names and addresses in prose**: F1 98.9% and 100% across 34 annotated
  documents in eight scripts.
- **Attachments are read, not guessed at.** DOCX, XLSX, PPTX, ODT, ODS, ODP,
  text-based PDF, RTF and image metadata — routed by magic bytes, parsed in the
  page, zero dependencies.
- **Files are handed back.** Redacted in place where the format allows it, as
  text where it does not, and as the same image without its EXIF where there is
  no text at all.
- **Bulk-record detection**: a pasted export reads as *"184 customer records"*,
  not 368 findings.
- **Business context**: confidentiality markings, legal privilege, M&A
  language, inside information, financials, compensation, health data, incident
  detail — plus unannounced transactions, negotiating positions, trade secrets,
  workforce decisions, live litigation and internal cost.
- **A 0–100 exposure score** that says it is a priority and not a probability,
  and the regulation each finding sits under, which says it is not a legal
  conclusion.
- **Coverage stated out loud**: the popup says whether the current tab is
  watched, and offers to watch it if not.
- **No network permission**, enforced by test.

Everything it does not do is in [LIMITATIONS.md](LIMITATIONS.md).

## Shipped since the last revision of this file

| | |
|---|---|
| Unstructured PII in prose | A 21 KB logistic regression over hashed character n-grams plus structural context. The classifier alone reaches F1 71.7% and cannot go higher; context does the rest. [NER.md](NER.md) |
| Non-Latin scripts | Ten uncased scripts and four cased ones, 10,237 names |
| Team mode without a console | `chrome.storage.managed`: policy in, nothing out, no permission added |
| Response-side scanning | Debounced, advisory, and now aware of open shadow roots |
| Coverage that keeps up | Composer detection by shape, plus a working add-this-site control |
| Documents and images | Read. **Not** OCR — see below |
| Novel credential formats | `unlabelled_secret`, tuned against 87,306 real files |
| Semantic confidentiality | Six advisory signals for the leak with no pattern in it |

## Next — what is genuinely left

### 1. A third-party benchmark

Still the most valuable open item, and the only one that changes what the
project can honestly claim.

[SecretBench](https://arxiv.org/pdf/2303.06729) — 818 real repositories, 97,479
candidate secrets, 15,084 labelled true — and FPSecretBench would make the
credential numbers independent. Both require a signed data-protection agreement
and BigQuery access. `bench/secretbench.js` is written and waiting.

The prose equivalent is the
[Text Anonymization Benchmark](https://aclanthology.org/2022.cl-4.19/).

Expect both numbers to drop. Publishing the drop is the point.

### 2. OCR, if it can be done without breaking the promise

The largest remaining capability gap, and the one most often assumed present.
A screenshot of a dashboard is a common and completely unhandled leak.

The options are all bad today. Tesseract's WASM build plus one language model
is several megabytes, which roughly triples the package and invites the
"obfuscated blob" question at store review. Fetching it on demand breaks the
no-network promise. The Chrome `Translator`/`LanguageDetector` family hints at
a future where the browser exposes on-device vision, and if `Shape Detection
API` text recognition ever ships beyond an origin trial, this becomes a
hundred-line change.

Until then: metadata is read, the file is named, and the reason is stated.

### 3. A gazetteer that generalises

A name in a caseless script that nobody wrote down is missed, and coverage is
uneven — Devanagari in particular is thin. The classifier generalises and the
gazetteer cannot, so the real fix is a script-agnostic feature extractor
trained on the same faker locales rather than more list entries.

### 4. Coreference, and person/organisation disambiguation

"She said the invoice was wrong" is not linked back to Priya three sentences
earlier, and the one remaining name false positive in the prose benchmark is a
company read as a person. Both are solvable with more context modelling and
neither is solvable with a bigger list.

### 5. OOXML rewriting, if it can be done safely

`convert` mode hands back `contract.docx.redacted.txt` rather than a redacted
`.docx`, because re-zipping a placeholder into one XML part of a package held
together by relationship ids produces a file that may not open. If that can be
done provably safely — content types preserved, relationships intact,
round-tripped through a real word processor in CI — it should be.

### 6. Legacy Office formats

`.doc`, `.xls`, `.ppt` and `.msg` are OLE2 compound files. The container format
is documented and a reader is perhaps four hundred lines. Worth it only if
people are actually attaching them.

## Explicitly not doing

- **A cloud console, telemetry, or a "we analyse your prompts to improve
  detection" clause.** That is the product several well-funded companies
  already sell. Competing with them on their terms means losing on their terms.
- **Blocking that cannot be overridden.** "Send as-is" stays. A control people
  cannot override is a control people uninstall.
- **Claiming compliance.** Chhanni names the regime a finding sits under. It
  does not make anyone compliant with anything, and should never be sold as if
  it did.

## How to argue with this

Every item above is a claim about where the exposure is, and each is checkable.
If the next Cyberhaven report says the mix has moved, the order should move
with it. The benchmark is the gate for anything that touches detection: a
feature that lowers precision below 99% does not ship, however good the demo.
