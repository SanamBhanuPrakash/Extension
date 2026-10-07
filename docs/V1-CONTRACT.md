# The V1 contract

V1 is finished when the sixteen capabilities below are true, and not when
somebody runs out of ideas. Everything else is a later generation.

The status column is the current honest state, re-derived from the repository
rather than carried forward from an older audit. `node scripts/gate.js --full`
checks the mechanical half of it.

## What V1 must prove

| # | capability | status | evidence |
|---|---|---|---|
| 1 | text prompt inspection | done | 138 engine tests; 102 detectors; `bench/run.js` 100%/100% on the internal corpus |
| 2 | paste interception | done | `test/e2e/` — a credential pasted into four composer shapes never reaches the mock |
| 3 | typed-send interception | done | was broken for `high` until the tier table; two cases now assert paste and typed-send agree |
| 4 | click-send interception | done | `test/e2e/` — click, programmatic click |
| 5 | form-submit interception | done | `test/e2e/` — submit on a real form |
| 6 | controlled-editor transformation | done | `app-controlled.html` transmits state, not DOM; `app-rich.html` keeps `pre`/`li`/`href` |
| 7 | transformation verification | done | read back through the send path's accessor, rescanned, refused on mismatch |
| 8 | attachment inspection | done | picker, drop, paste; PDF/DOCX/XLSX/PPTX/ODF/RTF; EXIF stripped before delivery |
| 9 | partial and opaque coverage reporting | done | `coverage`, `rowsRead/rowsTotal`, `sweepLimit`, the popup's page-state line |
| 10 | image metadata inspection | done | EXIF read and removed; **pixels are never read and the UI says so** |
| 11 | encoded-secret detection | done | Base64, Base64url, percent, hex, entities, `\x` escapes; 0 new alarms on 88,166 files |
| 12 | response-side advisory detection | done | was dead on arrival (no debounce ceiling); now ≤3 s, tier-filtered |
| 13 | local-first privacy architecture | done | no `fetch`, two permissions, allowlist local-only with migration |
| 14 | deterministic packaging | done | `scripts/package.js --verify`; both packages byte-identical across builds |
| 15 | documented limitations | done | `LIMITATIONS.md`, 23 sections, gated by `check-docs.js` |
| 16 | **provider compatibility evidence** | **NOT MET** | `test/provider/run.mjs` exists and measures the right thing; 0 of the 10 `(V1)` cells in `PROVIDERS.md` are certified. **This is the V1 blocker.** |

## Explicitly not V1

Naming these is the point of the contract. Each is useful and none blocks a
release.

- **OCR.** Text that exists only as pixels is not read. The UI says so rather
  than implying otherwise, and `SYSTEM-DESIGN.md` §8 says where it attaches.
- **Perfect NER.** 97.8% precision on names is where it is. The failure mode
  is a false positive on an unusual name, which is a nuisance, not a leak.
- **Legacy Office formats.** `.doc`, `.xls`, `.ppt` are not read. They are
  named as unread rather than scanned badly.
- **Every AI provider.** Twenty-three sites are matched; five are the
  certification target. The rest work on the same shapes or they do not, and
  the popup says which tab is covered.
- **Normalisation of line continuations and fullwidth characters.** Needs an
  index map back to the original (decision 36). A wrong span means redaction
  removing the wrong characters, which is worse than a miss.
- **Compression.** A secret inside a gzip stream inline in a prompt is not
  read.
- **URL-structural detection, agent and tool boundaries, connector data.**
  V2 and later.

## Exit criteria

V1 ships when:

1. Every row above reads `done`.
2. `node scripts/gate.js --release` exits `0`.
3. `docs/PROVIDERS.md` carries a dated certification for all five providers
   on **both paths marked `(V1)`** — paste, and typed plus Enter — and no
   `FAIL` cell anywhere in the matrix.
4. Every `BLOCKED` criterion in the gate is either resolved or recorded in
   `RELEASE-GATE.md` as an accepted residual risk with a reason.

Point 3 is the only one not currently satisfiable from this machine, and it is
the whole of the remaining distance.

### Why ten cells and not fifty

The matrix has fifty. V1 asks for ten, and the line is drawn where it is for a
reason that is not convenience.

V1 asks one question of a real provider: **does the boundary work at all?**
Paste and typed-plus-Enter answer it. They are how every user actually sends,
and the harness can drive them on any provider without provider-specific
knowledge, so a `PASS` there is evidence about the product rather than about a
driver somebody wrote for one site.

The other forty cells answer a different question — *does it keep working
across every way a provider can be driven, after each redesign* — and each
needs a driver per provider per path. That is `V1.x` in `ROADMAP.md`, and it
is by construction never finished: these are other people's products and they
change without notice. A V1 criterion that waits for it is a V1 that never
ships, which is not a higher standard, just a stuck one.

What does **not** move across that line: a `FAIL` in any cell fails the gate
outright. A secret reaching a provider is the product failing, and the fact
that a roadmap assigns that path to a later release does not make the leak
later.
