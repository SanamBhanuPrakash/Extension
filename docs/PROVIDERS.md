# Provider compatibility

This is the canonical matrix, and today it is almost entirely empty. That is
the honest state, not an oversight.

**No provider has been certified.** `test/provider/run.mjs` exists, measures
the right thing — the request body the provider's own code sent, read from the
network — and has never been run against a signed-in account, because doing so
needs accounts, a browser with a display, and sending messages to a paid
service. Nothing in CI can produce this evidence.

Until a row below is filled in, the correct reading of this project is: **the
interception logic is tested thoroughly against mock providers, and it is not
known what ChatGPT receives.** Those are different claims and this file exists
so the second one cannot be quietly mistaken for the first.

## How to fill it in

```console
npm install --no-save playwright-core
npm run certify -- --signin     # opens a tab per provider, waits while you log in
npm run certify                 # measures, and rewrites the matrix below
```

The first command opens a visible browser with one tab per provider, says
which ones you are already signed in to, and **stops** while you sign in to
the rest. Skip any you have no account for — they stay `NOT TESTED`, which is
the truth. Logins persist in the profile directory, so this is a one-time
step; the second command needs no pause and rewrites the matrix below with
the date stamped in.

`docs/SHIP.md` gate 1 is the same thing with the decision table for what each
outcome means.

## Cell meanings

| cell | means |
|---|---|
| `PASS` | the harness drove this path and the provider's request body did **not** contain the sentinel |
| `FAIL` | the sentinel was in the request body. The product failed, not the test |
| `NOT TESTED` | the harness could not drive this path, or no account was signed in |
| `UNSUPPORTED` | the provider has no such path (no form submit, no file picker) |

`PASS` is never inferred from "no request was observed". A send that never
happened proves nothing, and a panel that looked correct proves less.

## The matrix

Measured: **never**. Sentinel: `AKIAIOSFODNN7EXAMPLE` (AWS's published
documentation key).

The two rows marked `(V1)` are the ones V1 must certify: they are how every
user sends, and they are drivable without provider-specific knowledge. The
other eight are V1.x, and need a per-provider driver each. `scripts/gate.js`
reads that marker, so this is the boundary and not a note about it.

| path | ChatGPT | Claude | Gemini | Copilot | Perplexity |
|---|---|---|---|---|---|
| paste (V1) | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED |
| type + Enter (V1) | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED |
| type + click Send | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED |
| programmatic click | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED |
| form submit | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED |
| redact then send | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED |
| image paste | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED |
| file picker | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED |
| re-render after redaction | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED |
| while a reply streams | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED |

Two of the ten paths have drivers in the harness today — paste, and typed plus
Enter. The other eight need per-provider drivers, because guessing at somebody
else's re-render behaviour produces a cell that reads `PASS` when in truth
nothing happened.

## What V1 needs from this file, and what it does not

V1 asks one question of a real provider: **does the boundary work at all?**
Ten cells answer it — five providers across the two `(V1)` rows. Until all
ten read `PASS` (or `UNSUPPORTED`, for a path a provider genuinely lacks),
`scripts/gate.js` reports the provider criterion `BLOCKED` and V1 cannot
ship.

The remaining forty cells are V1.x. They are not a lower standard; they are a
different question — *does it keep working across every way a provider can be
driven, after each redesign* — and answering it needs a driver per provider
per path. Holding V1 for them would make the release criterion permanent,
because V1.x is by construction never finished.

One rule crosses the boundary: a `FAIL` in **any** cell fails the gate
outright. A secret reaching a provider is the product failing, and no roadmap
boundary excuses it.

## A pass expires

These are other people's products and their composers change without notice.
A dated `PASS` is evidence about that date. Re-run before a release, and treat
any cell older than the provider's last visible redesign as `NOT TESTED`.
