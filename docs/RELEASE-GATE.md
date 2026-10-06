# The release gate

Run it:

```console
node scripts/gate.js           # everything that needs no browser
node scripts/gate.js --full    # plus the browser and performance suites
```

The exit code is the answer. A criterion this machine cannot check reports
`BLOCKED` with the reason — never a pass. A gate that quietly skipped what it
could not verify would be the same substitution this product exists to catch.

## Why this is a script and not a checklist

The project's real risk stopped being a missing feature some time ago. It is
that auditing becomes endless: each pass finds something, each fix is
correct, and there is no definition of done. Prose cannot fix that, because
prose is not run. Every criterion below is checked by executing the thing.

## The verdict

Exactly one of three, decided mechanically:

| verdict | when |
|---|---|
| `NOT READY` | any criterion `FAIL`s |
| `PRE-PRODUCTION` | nothing fails, something is `BLOCKED` |
| `INDUSTRY READY` | everything passes |

There is no "almost ready". A blocked criterion is not a soft pass; it is a
claim nobody has evidence for.

## Criteria

### ENGINEERING
- the engine suite passes
- hostile input does not crash a parser (20,000 fuzz cases)
- both store packages are byte-identical across builds
- content stops before the provider, in a real browser *(`--full`)*
- performance budgets are met *(`--full`)*

### CORE
- the mode semantics are declared once, not per handler
- a transformation is verified before the send is replayed
- no shipped module can reach the network
- every detector lands in exactly one tier

### PRIVACY
- nothing sensitive is written to synchronised storage
- the manifest asks for no network permission
- no remote code and no remote stylesheet
- a bundled font ships its licence

### DOCS
- no security-critical documentation drift
- the V1 contract exists and every item has a status
- every provider PASS is dated, and every cell is a real verdict

### PROVIDER
- every supported provider has a dated certification

### VALIDATION
- detection measured against an independent corpus
- alarm rate measured on third-party source

## Current state

`PRE-PRODUCTION` — 15 pass, 0 fail, 4 blocked.

The four blocked criteria, and what each would take:

| blocked | what it needs | who can do it |
|---|---|---|
| provider certification | accounts on five AI products, a browser with a display, and sending test messages | a person with those accounts, in about an hour |
| the browser suite *(without `--full`)* | `--full`, which launches Chromium | anyone; it is run in CI on every push |
| performance budgets *(without `--full`)* | as above | anyone |
| independent detection benchmark | SecretBench and FPSecretBench need a signed data-protection agreement and BigQuery access | a person who signs it |

Only the first and last are real gaps. **Provider certification is the V1
blocker** and nothing else is close to it in importance: every other claim in
this repository is tested, and that one is the difference between "a mock
recorded nothing" and "ChatGPT received nothing".

## Accepted residual risks

Recorded here rather than hidden, with the reason each is acceptable for a
free, local, advisory tool.

1. **No independent detection benchmark.** The internal corpus is
   self-authored, so its 100% is a statement about the corpus and not about
   the world. The counterweight is `bench/wild.js`: 88,166 files of
   third-party source, 0.39% alarm rate, which is a false-positive measurement
   on text nobody wrote for this benchmark. See `BENCHMARK.md`.
2. **No external security review.** This has been audited repeatedly from
   inside. An adversarial review by somebody with no stake is not the same
   thing and has not happened.
3. **Pixels are not read.** Stated everywhere it matters, never implied
   otherwise, and the single largest coverage gap in the product.
4. **Normalisation gaps.** A key split across a line continuation, or written
   in fullwidth characters, is not found. Decision 36 says why building it
   halfway would be worse.
