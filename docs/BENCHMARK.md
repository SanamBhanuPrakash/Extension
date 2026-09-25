# Benchmark

```console
$ node bench/run.js

Chhanni benchmark
seed 20260925 · 424 cases · 241 positive · 183 hard negative

  precision   100.0%   241 true / 0 false positives
  recall      100.0%   0 missed
  F1          100.0%

  46,206 byte document scanned in 5.8ms (8 MB/s), 92 detectors
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
| Precision | **99.88%** (2,406 true / 3 false positives) |
| Recall | **99.54%** (11 missed) |
| F1 | **99.71%** |

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
on four seeds. The benchmark is not a one-off claim; it is a gate.

One caution it cannot cover: the GSTIN validator once had an off-by-one that
made it reject every real GSTIN. The benchmark scored **100%** throughout,
because the corpus generator called the same broken function to build its
samples. Only a known-good published GSTIN exposed it. A benchmark validates
consistency, not correctness — real-world vectors in the unit tests are what
validate correctness, and both are needed.
