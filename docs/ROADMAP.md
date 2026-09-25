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

- 94 detectors. 26 prove the match with a check digit, a decode, an issuer
  range or a trained classifier. 99.88% precision, 99.88% recall over 4,247
  reproducible cases.
- Names and addresses in prose: F1 97.2% and 100% on 25 annotated documents.
- Bulk-record detection: a pasted export is reported as *"184 customer records"*,
  not 368 findings.
- Business context: confidentiality markings, legal privilege, M&A language,
  inside information, financials, compensation, health data, incident detail.
- A 0–100 exposure score, and the regulation each finding sits under.
- Attachments intercepted, with redacted-copy replacement.
- No network permission, enforced by test.

## Next — the things that would matter most

### ~~1. Unstructured PII, without shipping a model~~ — shipped

Done, and measured: **names F1 97.2%, addresses F1 100%** on 25 annotated
documents. A 21 KB logistic regression over hashed character n-grams, trained
on 30,675 names from 75 locales, combined with structural context. The
classifier alone reaches 71.7% and cannot go higher; context does the rest.
[NER.md](NER.md) has the full design, the ceiling, and what it still cannot do
— coreference, organisation disambiguation, and non-Latin scripts.

What follows is the remaining order.

### ~~1b. Non-Latin scripts~~ — shipped

Ten uncased scripts and four cased ones, 10,237 names. Names F1 98.9% across
eight scripts. What remains: scripts outside that set, and the fact that a
gazetteer cannot generalise the way the classifier does — Devanagari coverage
in particular is thin and deserves a better source.

### ~~3. Team mode, without a console~~ — shipped

Through `chrome.storage.managed`, which the browser populates from GPO, macOS
profiles, Chrome Enterprise or Firefox `policies.json`. Policy flows in;
nothing flows out; no permission added. Internal codenames are matched locally
and never ship in the package.

### ~~4. Response-side scanning~~ — shipped

A debounced pass over replies, reporting echoed credentials and injection
payloads as a notice rather than a panel — the text has already arrived.

### ~~6. Coverage that keeps up~~ — shipped

Composer detection by shape, not hostname. Plus optional host permissions so a
user can grant access to a product that ships after this version.

### 1c. What is actually left

The largest capability gap. A name, a home address, a medical detail written in
ordinary prose is invisible to a pattern engine.
[Casper](https://arxiv.org/abs/2408.07004) uses an ML NER layer; Nightfall uses
cloud classifiers. Neither option is open here: one bloats the package, the
other breaks the no-network promise.

The shipped classifier folds diacritics but assumes Latin characters, so a name
written in Devanagari, Arabic, Han or Cyrillic is invisible. This is now the
largest gap for the non-English world, and the same architecture should extend
to it: the feature extractor is script-agnostic in principle, and the training
data exists in the same faker locales already used.

The other open piece is evaluation against the
[Text Anonymization Benchmark](https://aclanthology.org/2022.cl-4.19/), which
would make the prose numbers independent the way SecretBench would make the
credential numbers independent.

### 2. A third-party benchmark

The current corpus is self-authored. Running against
[SecretBench](https://arxiv.org/pdf/2303.06729) — 818 real repositories, 97,479
candidate secrets, 15,084 labelled true — would make the precision claim
independent. Expect the number to drop; publishing the drop is the point.

### 3. Team mode, without a console

The obvious monetisation is an enterprise console, and it would cost the thing
that makes this different. The alternative: a signed **policy file** an
organisation publishes at a URL of its own, which the extension fetches *only
if the user opts in*, containing allowlists, required detectors and internal
project codenames. Policy flows in; nothing flows out. A CISO gets consistent
rules without a telemetry pipe, and the default install stays silent.

### 4. Response-side scanning

Nobody scans what the model sends *back*. Two real cases: a model echoing your
credential into a shared transcript, and a model returning content carrying a
prompt-injection payload aimed at whatever reads the output next. The engine
already runs in the page; pointing it at the response stream is a small change
with a category nobody occupies.

### 5. Images and documents

Binary attachments pass untouched today — a screenshot of a dashboard is a
common and completely unhandled leak. Local OCR via WASM Tesseract, and text
extraction from `.docx` and `.pdf`, would close it. Heavy, so it belongs behind
an opt-in.

### 6. Coverage that keeps up

A new AI product ships every week and the manifest will always be behind. A
generic composer heuristic — any `contenteditable` or `textarea` on a page that
posts to a known inference endpoint — plus a user-added-site control, replaces
a list that cannot be maintained.

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
