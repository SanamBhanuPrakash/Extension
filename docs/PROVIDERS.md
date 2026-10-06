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
node scripts/build.js
node test/provider/run.mjs --profile ~/.chhanni-test-profile --matrix docs/PROVIDERS.md
```

The first run opens a visible browser; sign in to whichever providers you want
covered. Logins persist in that profile. The harness rewrites this file with
the date stamped in.

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

| path | ChatGPT | Claude | Gemini | Copilot | Perplexity |
|---|---|---|---|---|---|
| paste | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED |
| type + Enter | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED |
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

## A pass expires

These are other people's products and their composers change without notice.
A dated `PASS` is evidence about that date. Re-run before a release, and treat
any cell older than the provider's last visible redesign as `NOT TESTED`.
