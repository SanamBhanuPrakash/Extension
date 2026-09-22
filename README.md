# Chhanni

**छन्नी** — *a sieve*.

A sieve for everything you paste into an AI.

> Your prompt leaves your machine the instant you press Enter. Chhanni looks at
> it first, on your device, and tells you what you are about to hand over.

---

## The problem, stated plainly

People paste production config into chat boxes. Not careless people — tired
people, at 11pm, debugging something. The fastest way to get help with a broken
deploy is to paste the whole `.env` and the whole stack trace, and that is
exactly what everyone does.

Samsung banned ChatGPT internally after engineers pasted source code into it.
Every company since has written a policy about this. A policy is not a control.

## What it does

```console
$ chhanni scan prompt.txt

prompt.txt
  :4     critical AWS access key ID            AKI************PLE
         Pairs with a secret key to give full API access to the account.
  :5     critical AWS secret access key        wJalrX************PLEKEY
  :6     critical Database URL with password   postgr************orders
  :7     critical Stripe live secret key       sk_liv************zAbCdE
         Live key — can move real money.
  :8     high     Slack incoming webhook       https:************bCdEfG
  :11    low      Email address                r.i************.in
  :11    low      Indian mobile number         987****210
  :12    critical Payment card number          424************242
         Visa, passes Luhn.
  :12    high     Indian PAN                   ABC****34E

blocked 9 in 1 file
```

The same engine runs in the browser extension, on the composer of ChatGPT,
Claude, Gemini, Copilot, Perplexity, DeepSeek, Mistral, Grok and Poe.

<img src="docs/images/panel.png" alt="The warning panel, grouped by severity" width="440">

Findings are grouped by what they let someone do, not listed flat. The
dangerous things sit at the top with a line explaining why they matter; the
email addresses collapse into one line at the bottom and never block a send.

## The product decision: redact, don't block

A blocker gets uninstalled the first time it stands between someone and their
deadline. So Chhanni's primary button is not *cancel* — it is **redact and
continue**:

```
  AWS_ACCESS_KEY_ID=<AWS_ACCESS_KEY_ID_1>
  AWS_SECRET_ACCESS_KEY=<AWS_SECRET_ACCESS_KEY_1>
  DATABASE_URL=<DB_CONNECTION_STRING_1>
  STRIPE_KEY=<STRIPE_LIVE_KEY_1>
  SLACK_WEBHOOK=<SLACK_WEBHOOK_1>

The error only shows up for one customer. Their record is:
  name: R. Iyer, email <EMAIL_1>, phone <PHONE_INDIA_1>
  card on file <PAYMENT_CARD_1>, PAN <PAN_INDIA_1>
```

The prompt still works. The model never needed your real key to explain a stack
trace. Placeholders are stable within a document — the same secret appearing
three times becomes the same token three times — so the model can still reason
about "the key on line 4".

## What it looks like

| Toolbar popup | Settings |
|---|---|
| <img src="docs/images/popup.png" alt="Popup showing catches, breakdown and recent activity" width="300"> | <img src="docs/images/settings.png" alt="Settings page with detectors and a live playground" width="300"> |

The popup answers the only question a security tool has to answer well — *is
this thing doing anything?* — with what it caught, which detectors fire most,
and how many **distinct** secrets that represents, since pasting the same key
six times is one mistake repeated, not six mistakes.

The settings page carries a live playground. Type anything into it and see
exactly what fires, with the verdict it would produce, before you trust it with
something real. Every detector is labelled `proof` or `shape` so you can see
which ones verify and which ones are matching a distinctive prefix.

These screenshots are generated, not mocked: `scripts/render-ui.mjs` drives real
Chromium, fires a real paste event at the real content script, clicks *Redact
and continue*, and asserts the composer comes back clean. It found two bugs that
the unit tests could not — a CSS specificity mistake that silently unstyled the
primary button, and a heading that enumerated all seven findings and pushed the
findings themselves below the fold.

## System design

Three documents, for anyone deciding whether to trust this with their
credentials:

- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — the module graph and why it
  is strictly layered, the two interception flows, how text is written back into
  a React- or ProseMirror-controlled composer without desyncing it, the storage
  split, and what scanning costs.
- **[docs/THREAT-MODEL.md](docs/THREAT-MODEL.md)** — trust boundaries, seven
  threats with their mitigations, and an explicit list of what is *not* covered.
  The primary adversary is the user's own hurry, which is why the tool
  interrupts rather than forbids.
- **[docs/DECISIONS.md](docs/DECISIONS.md)** — nine decision records, each with
  its cost. Including the one where the project's own headline claim turned out
  to be inflated and was corrected downward.

## Why this isn't just regexes

Because a tool that cries wolf gets turned off, and there is only one way to
stop crying wolf: make the match prove itself.

| Detector | The proof |
|---|---|
| Payment card | **Luhn** mod-10 — `1234567890123456` is not a card |
| Aadhaar | **Verhoeff** check digit, plus first digit 2–9 — a 12-digit invoice total is not an Aadhaar |
| IBAN | **mod-97** — the checksum the standard was designed around |
| GitHub token | **CRC32** — GitHub's v2 format carries its own checksum in the last 6 characters |
| US SSN | never-issued ranges: area `000`, `666`, `900+`, group `00`, serial `0000` |
| JWT | base64-decode the header and payload; report whether it is expired and whether it carries an email |
| AWS secret key | 40 base64 chars **and** a credential word within 48 characters **and** Shannon entropy ≥ 4.2 |
| Indian PAN | structural: 4th character must be a real holder-type code |
| Unknown formats | Shannon entropy, with documentation placeholders (`API_KEY=your-api-key-here`) excluded |

**30 detectors. 9 of them prove the match rather than trusting its shape.**

Nine, not thirty, and the project says so in its own UI. The other twenty-one
match a prefix or structure that nothing else uses — `AKIA`, `xoxb-`,
`-----BEGIN ... PRIVATE KEY-----` — which is strong but is not proof, and is
labelled `shape` rather than `proof` everywhere it appears. `chhanni rules`
prints the proof method for every detector that has one.

Measured, not claimed: scanned against 57 files of ordinary application source
and documentation, Chhanni reports **zero findings**. Against a prompt carrying
nine real credential and identifier formats, it finds all nine. A plain
TypeScript stack trace comes back clean.

Where a detector cannot prove itself, it says so. Every finding carries a
`confidence` of `certain`, `likely` or `possible`, and the ones that shipped as
`possible` are the ones you should expect to allowlist.

## It makes no network calls

Not "we don't store your data". There is no `fetch` in the extension. The
manifest requests no network permission — only `storage`, for your own settings.
A tool that inspects your credentials has no business holding a network handle.

That is also why the engine never hands a raw secret to anything that persists:
findings carry a masked `preview` and a one-way FNV-1a `fingerprint`, and
`--json` output strips the matched value entirely. Someone will fork this and
add telemetry; the fork should be safe by construction.

## Install

**Extension** (unpacked, Chrome/Edge/Brave):

```console
git clone <this repo> && cd chhanni
node scripts/build-extension.js     # copies the engine in; no bundler, no deps
```

Then `chrome://extensions` → Developer mode → **Load unpacked** → pick
`extension/`.

**CLI** — no install, no dependencies:

```console
node bin/chhanni.js scan .
node bin/chhanni.js redact < prompt.txt
node bin/chhanni.js rules
```

Exit codes are `0` clean, `1` findings, `2` findings at blocking severity, so
the same rules that guard your chat box can guard your commits:

```sh
# .git/hooks/pre-commit
git diff --cached --name-only -z | xargs -0 node bin/chhanni.js scan --quiet
```

**Library**:

```js
import { scan, redact } from 'chhanni';

const { findings, verdict } = scan(userText);
if (verdict === 'block') return redact(userText, findings).text;
```

Zero runtime dependencies. Node ≥ 20. Same module runs in the browser.

## Configuration

The options page toggles individual detectors, sets how aggressive the
interruption is, and holds an allowlist for values you legitimately share — a
sample key in your docs, a shared test fixture. Settings live in your browser
profile.

In code, pass a policy:

```js
scan(text, {
  block: ['critical'],
  warn:  ['high', 'medium'],
  disabled: ['email', 'phone_india'],
  allow: ['sk_test_EXAMPLEKEYFROMOURDOCS00'],
});
```

## What it does not do

Worth being straight about, because the gaps are where people get hurt:

- **It reads the composer, not your uploads.** Drag a `.env` file or a screenshot
  of your dashboard into the chat and Chhanni does not see it. This is the
  biggest hole and the next thing to close.
- **It only runs on the sites in the manifest.** A new AI product ships every
  week; that list will always be behind.
- **It matches formats, not meaning.** Describing your unreleased pricing
  strategy in careful prose is a leak Chhanni cannot see. Nothing pattern-based
  can.
- **Novel credential formats** fall through to the entropy rule, which needs a
  credential-ish word next to the value. A bare unknown-format key with no
  context will be missed.
- **Indian PAN has no public check-digit algorithm**, so that detector is
  structural only and reports at `likely`, not `certain`.
- **It is advisory.** It interrupts you; it cannot stop a determined paste, and
  it is not an enterprise DLP control.

## Tests

```console
$ node --test test/*.test.js
# tests 27
# pass 27
# fail 0
```

The suite covers every checksum against known-good and known-bad vectors, true
positives for each credential family, and — the part that matters — explicit
false-positive tests: order numbers that fail Luhn, invoice totals that fail
Verhoeff, never-issued SSN ranges, documentation placeholders like
`API_KEY=your-api-key-here`, and a plain stack trace.

## Layout

```
src/checksums.js         Luhn, Verhoeff, mod-97, CRC32, entropy — imports nothing
src/rules.js             the 30 detectors, plus category and proof metadata
src/detect.js            scanning, overlap resolution, masking, fingerprinting
src/redact.js            stable placeholders, reversible
bin/chhanni.js           CLI
extension/content.js     interception and the in-page panel
extension/popup.*        toolbar dashboard
extension/options.*      settings and the live playground
extension/store.js       local-only history; masked previews, never secrets
extension/engine/        copied from src/ at build time, not in version control
scripts/build-extension  the whole build: a file copy
scripts/make-icons.js    the toolbar PNGs, drawn from a vector description
scripts/render-ui.mjs    visual + end-to-end verification (optional dependency)
docs/                    architecture, threat model, decisions
test/                    node:test, no runner to install
```

One engine, three surfaces. The rule that stops the paste is the same rule that
fails the build.

## Licence

MIT.
