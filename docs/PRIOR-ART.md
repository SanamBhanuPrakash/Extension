# Prior art

## This idea is not new

It is worth saying plainly, because a project that pretends otherwise is
lying to you about the one thing you cannot verify yourself.

**[Casper: Prompt Sanitization for Protecting User Privacy in Web-Based Large
Language Models](https://arxiv.org/abs/2408.07004)** (arXiv 2408.07004, August
2024) is a browser extension that sanitizes prompts on-device before they reach
a hosted LLM. Its architecture is three layers: a rule-based filter, an ML
named-entity recognizer, and a browser-local LLM topic identifier. That is the
same product thesis as this one, published first, with an evaluation.

Commercially, the category is well funded and consolidating:

| | |
|---|---|
| **Nightfall AI** | Browser extension plus endpoint agent. ML classifiers over 100+ data types. Monitors prompts *and* file uploads. |
| **LayerX** | Browser security platform with GenAI DLP. **Acquired by Akamai for ~$205M, completed July 2026**, now Akamai Workforce Protector. |
| **Prompt Security, Harmonic, Witness AI, Zscaler, Netskope** | Same space, enterprise distribution. |

A $205M acquisition is not a signal that the market is empty. It is a signal
that it is real and that the incumbents are better resourced than this project
will ever be.

## Where there is actually room

Three gaps, and they are narrow and specific.

### 1. Nobody publishes accuracy

Not Nightfall, not LayerX, not Casper in a form you can rerun. The only public
numbers for secret detection come from academic work on source-code scanners
([Rahman et al.](https://arxiv.org/pdf/2307.00714)): GitHub Secret Scanner at
75% precision, Gitleaks at 46% precision and 88% recall, TruffleHog at 52%
recall. **No tool in that study achieves both.** The paper's conclusion is that
regex-and-entropy approaches reach high recall at poor precision.

Chhanni ships `bench/`, a seeded reproducible corpus, and measures **99.88%
precision and 99.54% recall over 4,247 cases**. `node bench/run.js` prints it on
your machine. The limits of that claim are written down in
[BENCHMARK.md](BENCHMARK.md), including the fact that the corpus is
self-authored and that a check digit can never reach zero false positives.

This is the difference that matters, and it is the one an incumbent could erase
tomorrow by publishing their own numbers. They have not.

### 2. Enterprise DLP has to report; an individual's tool does not

Nightfall and LayerX are sold to security teams, so they necessarily send
findings to a console. That is the product. It also means the tool that
inspects your credentials holds a network handle.

Chhanni requests one permission, `storage`, has no service worker, and a test
fails the build if any shipped module references `fetch`, `XMLHttpRequest`,
`sendBeacon`, `WebSocket` or `EventSource`. That is not better than enterprise
DLP — it is a different buyer. An engineer who wants this on their own laptop
without their employer's console is not served by any of the above.

### 3. Offline structural intelligence is under-used

Everyone matches patterns. Very little is done with what the matched value
*contains*:

- **AWS account number, decoded from the access key ID.** base32 decode and a
  bit shift, no API call — the technique published by
  [Truffle Security](https://trufflesecurity.com/blog/research-uncovers-aws-account-numbers-hidden-in-access-keys).
  Turns "an AWS key is in your prompt" into "the key for account 5810-3995-4779
  is in your prompt".
- **JWT `alg:none` detection**, which is a signature-bypass vulnerability, not
  merely a leak — escalated to critical.
- **Card issuer ranges** on top of Luhn, which is what stops an IMEI being
  reported as a payment card.
- **GitHub token type** read from its prefix, and its CRC32 verified.

### 4. Indian and non-Western identifiers are poorly served

Presidio and the Western commercial tools have thin coverage here, and India's
DPDP Act 2023 makes it consequential. Chhanni validates **Aadhaar** (Verhoeff),
**GSTIN** (mod-36 check character and state code), **PAN**, **IFSC**, **UPI VPA**
against real PSP handles, and Indian driving licence — alongside **CPF/CNPJ**
(Brazil), **SIN** (Canada), **NINO** (UK), **ABN/TFN** (Australia), **EU VAT**,
**ISIN** and **IMEI**.

## What this project does not have

Honest ledger, so nobody buys a story:

- **No ML or NER layer.** Casper has one. Unstructured PII in prose — a name, an
  address, a medical detail — is invisible to a pattern engine. This is the
  largest capability gap and it is not close.
- **No central policy, console, or fleet reporting.** Deliberate, and
  disqualifying for an enterprise buyer.
- **No third-party benchmark.** The obvious next step is running against
  [SecretBench](https://arxiv.org/pdf/2303.06729) (818 repos, 97,479 candidate
  secrets). Not done.
- **No published user study.** Casper has one. Whether people keep a redactor
  installed longer than a blocker is an assertion here, not a finding.
