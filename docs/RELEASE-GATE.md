# The release gate

Run it:

```console
node scripts/gate.js           # everything that needs no browser
node scripts/gate.js --full    # plus the browser and performance suites
node scripts/gate.js --release # --full, and BLOCKED is not good enough
```

A criterion this machine cannot check reports `BLOCKED` with the reason —
never a pass. A gate that quietly skipped what it could not verify would be
the same substitution this product exists to catch.

## The exit code, and which question it answers

| code | means |
|---|---|
| `0` | the question the flags asked was answered yes |
| `1` | a criterion `FAIL`ed — something in this repository is broken |
| `2` | `--release` only: nothing is broken, something is unproven |

The flags ask different questions, so the same repository state can exit `0`
and `2` depending on which you ran:

- **Without `--release`**, the question is *did I break anything*. That is
  what CI and a development loop want, and a `BLOCKED` criterion is not a
  regression, so it exits `0`.
- **With `--release`**, the question is *can this ship*. An unproven claim is
  not a shippable one, so `BLOCKED` exits `2`.

`--release` implies `--full`. Deciding whether something can ship with the
browser and performance suites unrun would block on the gate's own laziness
and then report it as an unproven claim about the product.

This distinction is a correction, not a refinement. The gate used to print
`PRE-PRODUCTION` and exit `0`, above a document that said the exit code was
the answer to "can this ship". It was not: a script that announces the thing
cannot ship and then reports success to its caller is exactly the kind of
substitution — a reassuring surface over a weaker state — that the rest of
this repository is built to refuse. `1` beats `2` when both apply, because a
broken repository is a more urgent answer than an unproven one.

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
- every provider is certified on both V1 send paths, dated

### VALIDATION
- detection measured against an independent corpus
- alarm rate measured on third-party source

## Current state

`PRE-PRODUCTION`. With `--full`: 17 pass, 0 fail, 2 blocked — so
`node scripts/gate.js --full` exits `0` and `node scripts/gate.js --release`
exits `2`. Without `--full` the browser and performance criteria are two more
`BLOCKED`, which is the gate declining to claim what it did not run.

The two real blocked criteria, and what each would take:

| blocked | what it needs | who can do it |
|---|---|---|
| provider certification | accounts on five AI products, a browser with a display, and sending test messages | a person with those accounts, in about an hour |
| independent detection benchmark | SecretBench and FPSecretBench need a signed data-protection agreement and BigQuery access | a person who signs it |

**Provider certification is the V1 blocker** and nothing else is close to it
in importance: every other claim in this repository is tested, and that one is
the difference between "a mock recorded nothing" and "ChatGPT received
nothing".

It is ten cells, not fifty. The gate asks for the two send paths marked
`(V1)` in `docs/PROVIDERS.md` — paste, and typed plus Enter — across five
providers. The other forty cells need a driver per provider per path and
belong to V1.x; demanding them for V1 would make the criterion permanent,
because V1.x is by construction never finished. A `FAIL` in any cell, V1 or
not, still fails the gate outright.

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
