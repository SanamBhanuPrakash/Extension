# Benchmark

```console
$ node bench/run.js

Chhanni benchmark
seed 20260925 · 424 cases · 241 positive · 183 hard negative

  precision   100.0%   241 true / 0 false positives
  recall      100.0%   0 missed
  F1          100.0%

  46,206 byte document scanned in 4.8ms (9.6 MB/s), 102 detectors
```

Every figure below is reproducible from this repository. Where a number is
about time it is from the machine that produced the commit; run it on yours.
What none of these numbers prove is in [LIMITATIONS.md](LIMITATIONS.md) § 7.

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

## Result on the generated corpus

Across ten consecutive seeds, **4,244 cases** — 2,414 positive, 1,830 hard
negative:

| | |
|---|---|
| Precision | **100.00%** (2,414 true / 0 false positives) |
| Recall | **100.00%** (0 missed) |
| F1 | **100.00%** |

| seed | cases | tp | fp | fn |
|---|---|---|---|---|
| 20260925 | 424 | 241 | 0 | 0 |
| 20260926 | 425 | 242 | 0 | 0 |
| 20260927 | 423 | 240 | 0 | 0 |
| 20260928 | 424 | 241 | 0 | 0 |
| 20260929 | 425 | 242 | 0 | 0 |
| 20260930 | 424 | 241 | 0 | 0 |
| 20260931 | 425 | 242 | 0 | 0 |
| 20260932 | 425 | 242 | 0 | 0 |
| 20260933 | 424 | 241 | 0 | 0 |
| 20260934 | 425 | 242 | 0 | 0 |

Reproduce any row with `node bench/run.js --seed 20260927`.

**Read that 100% as a warning, not a result.** A corpus written by the author
of the rules cannot find the mistakes the author did not think of. Seed
20260927 is the proof: sweeping ten seeds for this table surfaced a real miss
— the leading twelve digits of a Google OAuth client id were being read as an
Aadhaar number, and beat the OAuth detector in overlap resolution. One guard
later the sweep is clean, and the corpus never would have told us on its own.

The number that carries weight is the one below.

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
repositories nobody wrote for this benchmark:

> React · Django · Next.js · the AWS Terraform provider · Ansible · Prometheus
> · kubernetes/client-go · Flask · Express · axios · prettier · the Rust book
> · github/gitignore
>
> **87,306 files, 407.1 MB.**

### It measures alarms, not findings

A findings count is the wrong number. A file full of example email addresses
produces findings and no alarm, because `low` on its own is not a reason to
interrupt anybody. The number that decides whether a person keeps this
installed is how often the panel actually appears.

```console
$ node bench/wild.js /path/to/checkouts --show
  total
    87,306 files, 407.1 MB of real source
    7,863 findings — one every 11 files
    337 would raise the panel — one every 259 files, 0.39%
    212 of those at blocking severity
```

|  | alarms | one every | blocking |
|---|---|---|---|
| before this round of fixes | 405 | 216 files | 282 |
| after | **337** | **259 files** | **212** |

Better precision *and* seven more detector classes, which is the trade this
benchmark exists to police.

### The false-positive classes it found

Each is a real line from a real repository, and each is now pinned by a test
carrying that exact string:

| What fired | On what | Why it was wrong |
|---|---|---|
| `aadhaar` 135 → 46 | `namespace='11111111-2222-3333-4444-…'` | the middle of a UUID. Also AWS account numbers (also twelve digits), coordinates and timestamps. Verhoeff accepts one random twelve-digit number in ten, and this fires at *critical* |
| `payment_card` 96 → 9 | `(0.0, -0.6358599286615808)` | the fractional part of a latitude: sixteen digits that pass Luhn in a Discover range. `\b` does not help, because `.` is not a word character |
| `isin` 21 → 0 | `{4724A46A-3F20-5AAA-8180-CBD31D08E478}` | the last group of an uppercase UUID. An ISIN starts with an ISO 3166 country code; `CB` is not one |
| `iban` | `export TOKEN=BB7120133083564` | mod-97 accepts about one string in 97 of the right shape. This is an Indian driving licence number, and Barbados IBANs are 28 characters. Every country's length is fixed and published |
| `classification_marking` 53 → 15 | `This is for internal use only.` | how every library labels a private API. Ansible's config says it nine times |
| `health_information` 7 → 0 | `a prescribed notification` (Go), `symptoms of bugs` (the Rust book) | medical words doing non-medical work — at *critical* severity |
| `prompt_injection` 19 → 7 | `pretends to be the class it wraps` | Django's lazy object. Also `send the token to` in axios's docs, and `no system message:` in an Ansible log line |
| `legal_hold` 20 → 8 | `remove any legal hold on the object` | S3 Object Lock has a setting with that name |
| invisible characters | Django's **Khmer** translation | U+200B is Khmer's word separator — and Thai's, Lao's, Myanmar's and Tibetan's |
| bidi overrides | Django's **Central Kurdish** translation | isolates U+2066–U+2069 are how a Latin placeholder sits inside an Arabic-script sentence. Only the two *overrides* are Trojan Source |

The last two are internationalisation bugs. Neither was findable by reasoning
about the code; both needed real multilingual text.

### Tuning a detector against it

`unlabelled_secret` — the detector for a credential in a format nobody has
published — was tuned entirely against this corpus:

| | findings | files |
|---|---|---|
| first draft | 5,064 | — |
| + wordiness and class-transition statistics | 3,272 | 32 |
| + Go module checksums (`h1:`) excluded | 242 | 18 |
| final | **234** | **18 of 87,306** |

Two thirds of everything it reported lived in eleven `go.sum` files, which is
what a lockfile is: a page of content hashes.

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
| 46 KB, 102 detectors + tables + prose + injection | **4.8 ms (9.6 MB/s)** |
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
needed, a context word — and, for Aadhaar specifically, a floor of five
distinct digits, because a twelve-digit test fixture reaches for
`4444-5555-6666` and a real Aadhaar drawn from the space has four or fewer
distinct digits about once in ten thousand.

That compounding is why the measured figure on 87,306 real files is one alarm
every 259 files. It is not zero, and a tool that claims zero false positives on
real-world input is either not measuring or not telling you.

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
- **The wild corpus is source code.** Fifteen large public repositories are not
  a sample of what people paste into an AI tool. Real prompts carry more prose,
  more spreadsheets and more documents, and nobody has published a corpus of
  them.
- **There is no telemetry, by design** — so there is no measurement of
  real-world false negatives at all. That is a real cost of the privacy
  position. See [LIMITATIONS.md](LIMITATIONS.md) § 7.

## Regression guard

`test/detect.test.js` fails the build if precision or recall drops below 99%
on four seeds, and separately if name precision drops below 90% or recall below
95% on the prose corpus. The benchmarks are not one-off claims; they are gates.

Above them sit 96 unit tests, including one per false-positive class found in
the wild, each carrying the exact string from the repository that produced it,
and a document suite that runs the extractors against real DOCX, XLSX, PPTX,
ODT, PDF, JPEG and PNG fixtures built by `tools/make-fixtures.py`.

One caution it cannot cover: the GSTIN validator once had an off-by-one that
made it reject every real GSTIN. The benchmark scored **100%** throughout,
because the corpus generator called the same broken function to build its
samples. Only a known-good published GSTIN exposed it. A benchmark validates
consistency, not correctness — real-world vectors in the unit tests are what
validate correctness, and both are needed.
