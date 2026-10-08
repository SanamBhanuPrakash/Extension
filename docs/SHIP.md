# Ship

This document exists because the project had every artifact a release needs
and no release. It is a checklist, not an argument. Nothing here is a new
idea; everything here is a step somebody has to take.

## The promise, frozen

> Before sensitive text reaches an AI website, Chhanni finds it on your
> machine and either tells you, replaces it, or stops the send — according to
> a setting you control.

That is the whole product. Anything that is not that promise is after the
listing is live.

## What is already true

Not to be re-proved. `node scripts/gate.js --full` is the authority, and it
reports 17 pass, 0 fail, 2 blocked.

- detection, paste, typing, Enter, click, form submit, attachments
- redaction and aliasing, verified against the composer before the send is replayed
- rich editors keep their formatting
- nothing sensitive in synchronised storage; two permissions; no network code
- 148 unit tests, 44 browser cases, 20,000 fuzz cases, byte-identical packages
- store listing copy, privacy disclosures, screenshots and promo tile: `docs/store/`

## The two gates, and they are both human

Everything else is done. These two need a person, and neither is long.

### Gate 1 — certify the providers · ~25 minutes, once

This is the V1 blocker and the only claim in the repository with no evidence
behind it. It needs a desktop, five accounts, and your attention.

```console
git clone https://github.com/SanamBhanuPrakash/Extension && cd Extension
npm install --no-save playwright-core
npm run certify -- --signin     # opens five tabs; log in; press Enter
npm run certify                 # measures, writes docs/PROVIDERS.md
```

Sign in to as many as you have. Skip the rest — they read `NOT TESTED`,
which is the truth. Free accounts are fine; the harness sends two short
messages per provider.

What the result means:

| outcome | what to do |
|---|---|
| all ten `(V1)` cells `PASS` | the blocker is cleared. Go to Gate 2 |
| any cell `FAIL` | **stop.** A secret reached a provider. That is a bug, and it is the most valuable bug this project will ever get |
| some `NOT TESTED` | certify the rest, or ship covering fewer providers and say which |

Then commit the matrix. `node scripts/gate.js --release` should exit `0`.

### Gate 2 — publish · ~1 hour, once

```console
node scripts/package.js         # writes both zips
```

1. Chrome Web Store developer account — $5, one time, [here](https://chrome.google.com/webstore/devconsole).
2. Publish `PRIVACY.md` at a stable URL. GitHub Pages on this repo is enough;
   the listing form requires a link, not a PDF.
3. Upload `dist/chhanni-chrome-0.4.0.zip`. Paste the copy from
   `docs/PUBLISHING.md` §Listing copy, the screenshots from `docs/store/`.
4. Permission justifications — two, both already written in
   `docs/PUBLISHING.md`: `storage` keeps your settings, `scripting` registers
   the same content script on a site you add yourself.
5. Data use — answer *not collected* to every category and sign all three
   certifications. This is verifiable from the package and a test fails the
   build if any shipped module touches a network API.
6. Submit. Review is usually days, sometimes longer.

Firefox is the same zip minus one manifest field, on AMO, free. Do it second.

## The freeze

Between now and a live listing, a change is allowed only if it is one of:

- a `FAIL` cell from Gate 1
- a blocker a store reviewer names in writing
- a crash or a wrong-data bug found by using it

Everything else goes in a list and waits. Not because it is wrong — because
the project has a month of evidence that there is always one more defensible
improvement, and that the supply of them does not run out before the time
does.

## Two loops, kept apart

Merging these is what cost the month. Every product change became a security
analysis, which became an architecture question, which became a document,
which became a guard on the document.

```
PRODUCT                          ASSURANCE
a user hit something             a threat exists
  -> change it                     -> test for it
  -> test the change               -> fix what the test finds
  -> ship                          -> keep the regression test
  (days)                           (its own cadence, not a release gate)
```

The gate is where they meet, and the gate already exists. Assurance work does
not block a release unless it produces a `FAIL`.

## What "industry grade" means here

Not "every provider, every format, every attack, every browser". That has no
end, and a product can die inside it.

> A clearly stated promise, a clearly stated boundary, and evidence that the
> promise holds inside the boundary.

Two of those three are done. Gate 1 is the third.

## After the listing is live

In this order, and one at a time:

1. Whatever real use breaks. This outranks everything below.
2. The other eight provider paths — V1.x in `ROADMAP.md`, forty cells.
3. Re-certification when a provider redesigns.
4. The independent benchmark, if the data agreement is ever worth signing.

Everything further out is in `ROADMAP.md` and stays there.
