# Benchmark

```console
$ node bench/run.js

Chhanni benchmark
seed 20260925 · 424 cases · 241 positive · 183 hard negative

  precision   100.0%   241 true / 0 false positives
  recall      100.0%   0 missed
  F1          100.0%

  46,206 byte document scanned in 3.2ms (14.3 MB/s), 95 detectors
```

## Why this file exists

Every product in this category claims accuracy. None of them publish a number.

The only public figures for secret detection come from academic work on
source-code scanners — [Rahman et al., *A Comparative Study of Software Secrets
Reporting by Secret Detection Tools*](https://arxiv.org/pdf/2307.00714):

| Tool | Precision | Recall |
|---|---|---|
| GitHub Secret Scanner | 75% | — |
| Gitleaks | 46% | 88% |
| SpectralOps | — | 67% |
| TruffleHog | — | 52% |
| "Commercial X" | 25% | — |

No tool in that study has both. The paper's own conclusion is that regex and
entropy approaches reach high recall at poor precision — which is the problem
this engine is built around.

## Result

Across ten seeds, **4,247 cases**:

| | |
|---|---|
| Precision | **99.88%** (2,417 true / 3 false positives) |
| Recall | **99.88%** (3 missed) |
| F1 | **99.88%** |

Per seed:

| seed | cases | precision | recall | F1 |
|---|---|---|---|---|
| 1 | 425 | 100.0% | 99.6% | 99.8% |
| 7 | 424 | 100.0% | 99.2% | 99.6% |
| 42 | 425 | 100.0% | 99.6% | 99.8% |
| 999 | 425 | 100.0% | 100.0% | 100.0% |
| 20260925 | 424 | 100.0% | 100.0% | 100.0% |
| 31337 | 424 | 99.6% | 98.8% | 99.2% |
| 8675309 | 423 | 99.6% | 99.6% | 99.6% |
| 2718281 | 426 | 100.0% | 100.0% | 100.0% |
| 1414213 | 426 | 100.0% | 99.6% | 99.8% |
| 77777 | 425 | 99.6% | 99.2% | 99.4% |

Reproduce any row with `node bench/run.js --seed 42`.

## Names and addresses in prose

A separate corpus and a separate harness, because the task is different: these
are annotated documents, not generated strings.

```console
$ node bench/ner.js
25 annotated documents · 10 of them hard negatives

  names      precision 97.8%   recall 100.0%   F1  98.9%
  addresses  precision 100.0%  recall 100.0%   F1 100.0%
```

34 documents in **eight scripts** — Latin, Devanagari, Arabic, Hebrew, Thai,
Han, Hangul and Cyrillic — 13 of them hard negatives.

The classifier underneath the name detector scores **F1 71.7%** on held-out
tokens, and that ceiling is real — see [NER.md](NER.md). The pipeline scores
97.2% because structural context, not character evidence, is what settles
whether a capitalised word is a person.

## Real code — the measurement that mattered most

A self-authored corpus flatters its author. `bench/wild.js` scans public
repositories nobody wrote for this benchmark: **10,472 files, 23.4 MB** from
express, flask, axios, prettier and github/gitignore.

The first run produced **601 findings — one every 17 files.** Almost all were
wrong, and *not one of them* appeared in the synthetic corpus, which was
simultaneously reporting 100%.

```console
$ node bench/wild.js /path/to/checkouts
  total
    10,472 files, 23.4 MB of real source
    129 findings — one every 81 files
```

Seven false-positive classes, each found only by looking at real code:

| What fired | On what | Why it was wrong |
|---|---|---|
| `phone_india` ×411 | a Prettier formatting fixture of arbitrary integers | a bare ten-digit number is not a phone number |
| `credential_in_prose` | `password: urlPassword`, `credentials: isCredentialsSupported` | that is JavaScript, not a password |
| `prompt_injection` | a **.gitignore** explaining "ignore rules" | the imperative had no target |
| `prompt_injection` | a threat model saying "leak secrets" | descriptive prose, no destination |
| zero-width detection | Devanagari, Persian and emoji text | ZWJ and ZWNJ are *required* there |
| `payment_card` | `123 456 789 123 456 789…` | a 15-digit window starting `34` that passed Luhn by chance |
| `classification_marking` | "how every comment was **classified**" | a verb, not a marking |

**601 → 129, one every 81 files.** What remains: 103 email addresses in
`CODE_OF_CONDUCT` and `AUTHORS` files (correct — they are email addresses), 23
documentation passwords indistinguishable from real ones, 2 injection edge
cases, and one genuine private key in a `.pem` test fixture.

Every fix is locked behind a test that uses the exact string found in the wild.

## The third-party datasets, and why they are not here

[SecretBench](https://arxiv.org/pdf/2303.06729) (818 repositories, 97,479
candidates, 15,084 labelled true) and FPSecretBench (the false positives nine
tools reported on it) would make this claim independent.

**Neither can be run here.** Both require a signed data-protection agreement
with the authors and access through Google BigQuery, because they contain live
credentials and committers' email addresses. That is a reasonable restriction
and not one to route around.

So `bench/secretbench.js` exists and the data does not. It parses the BigQuery
CSV export and scores against it; the header of that file has the exact steps.
Expect the number to be lower than the figures above. Publishing that drop is
the entire point of running it.

## How the corpus is built

Cases are generated from a seeded PRNG rather than hard-coded. Two reasons:
lengths then match each detector's contract instead of being miscounted by
hand, and **no real credential is ever committed to this repository**.

Identity positives are produced by generating a random body and brute-forcing
the check digit until *the validator itself* accepts. A sample is valid because
the published algorithm says so, not because the author asserted it.

Hard negatives are the strings that break other scanners — and they are
generated until they genuinely fail their checksum, because a label that says
"not an Aadhaar" about a number that happens to have a valid Verhoeff digit is
a lie:

- git SHAs, sha256 digests, md5 etags, UUIDs
- epoch milliseconds and microseconds
- order numbers that fail Luhn; 15-digit numbers that pass Luhn but match no
  issuer range; 12-digit numbers that fail Verhoeff
- GSTIN- and CPF-shaped strings with wrong check characters
- MAC addresses, semver, IPs, parcel tracking numbers
- documentation placeholders: `API_KEY=your-api-key-here`, `password: changeme`,
  `Authorization: Bearer <your token here>`
- prose that discusses credentials without containing one, and a plain
  TypeScript stack trace

## Speed

| | |
|---|---|
| 46 KB, 95 detectors + tables + prose + injection | **3.2 ms (14.3 MB/s)** |
| 5,000 × 60 export | 504 ms (was 3,346 ms) |
| Prose corpus, 105 KB | 17.9 ms |

Four optimisations, each measured:

1. **A single-pass shape gate.** Twenty detectors have no literal to prefilter
   on, because their patterns are pure shape. One walk of the string yields the
   longest digit, uppercase, alphanumeric and base64 runs; a pattern needing
   thirteen consecutive digits never runs on a document whose longest run is
   four.
2. **Aho–Corasick** for the literal prefilter: one O(n) pass instead of ~250
   `String.includes` passes.
3. **Regexes compiled once** at module load, not 95 times per scan.
4. **Bounded table processing** — 2,000 rows split, the true count still
   reported.

An optimisation that can change a result is a bug, so two tests assert
equivalence: findings are identical with every prefilter stripped, and the
automaton returns exactly what `includes()` would.

## Where the precision comes from

Four mechanisms, in rough order of how much they contribute:

1. **Check digits.** Luhn, Verhoeff, mod-97, mod-36, mod-11, mod-89, CRC32.
2. **Issuer ranges.** Luhn alone accepts roughly **one in ten** random digit
   strings of the right length. That is not a bug in Luhn; it is what a single
   check digit buys. Requiring the number to also start in a range some card
   network actually issues, *at a length that network actually issues*, is what
   stops a 15-digit IMEI being reported as a payment card.
3. **Benign-shape rejection.** UUIDs, hex digests, epoch timestamps, repeated
   and sequential runs, and documentation placeholders are rejected before a
   finding is emitted (`src/negatives.js`).
4. **Required context.** Detectors with no distinctive shape of their own —
   Canadian SIN, Australian TFN and ABN, IMEI, Indian passport — additionally
   require a nearby word naming the identifier. Nine digits are nine digits
   until something says "SIN".

## The limit, stated honestly

**A check digit cannot reach zero false positives.** A single decimal check
digit means about 1 in 10 random numbers of that length validates. If someone
pastes a twelve-digit invoice number, there is a ~10% chance it is, arithmetically,
a valid Aadhaar, and nothing in this engine — or any other — can tell the
difference from the number alone.

What the layers above buy is a compounding of independent constraints: check
digit **and** issuer range **and** not-a-known-benign-shape **and**, where
needed, a context word. That is why the measured figure is 99.88% rather than
90%. It is not 100%, and a tool that claims 100% on real-world input is either
not measuring or not telling you.

## What these numbers do *not* say

- **The corpus is self-authored.** It is adversarial by intent and generated
  across unseen seeds, but it is not a third-party dataset. A rule that is wrong
  in a way I did not think to test will score perfectly here.
- **They measure the engine, not the extension.** Whether interception fires on
  a given site's composer is a separate question, covered by
  `scripts/render-ui.mjs`.
- **Not comparable to the table above.** Those figures come from real source
  repositories ([SecretBench](https://arxiv.org/pdf/2303.06729): 818 repos,
  97,479 candidates); this corpus is synthetic and prompt-shaped. Running
  Chhanni against SecretBench is the obvious next step and has not been done.

## Regression guard

`test/detect.test.js` fails the build if precision or recall drops below 99%
on four seeds, and separately if name precision drops below 90% or recall below
95% on the prose corpus. The benchmarks are not one-off claims; they are gates.

One caution it cannot cover: the GSTIN validator once had an off-by-one that
made it reject every real GSTIN. The benchmark scored **100%** throughout,
because the corpus generator called the same broken function to build its
samples. Only a known-good published GSTIN exposed it. A benchmark validates
consistency, not correctness — real-world vectors in the unit tests are what
validate correctness, and both are needed.
