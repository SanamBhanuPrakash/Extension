# Threat model

## What is being protected

| Asset | Where it is exposed |
|---|---|
| Live credentials — cloud keys, vendor tokens, database URLs, private keys | typed or pasted into a chat composer |
| Payment and identity data — cards, Aadhaar, SSN, IBAN, PAN | pasted while asking for help with a customer record |
| The detection history itself | `chrome.storage.local`, on the user's own profile |

## Trust boundaries

```
  ┌──────────────────────────────────────────────────────────┐
  │ host page (chatgpt.com, claude.ai, …)                    │
  │   page JavaScript, page DOM                              │
  │   ─ hostile by assumption ─                              │
  └──────────────┬───────────────────────────────────────────┘
                 │  shared DOM, separate JS world
  ┌──────────────▼───────────────────────────────────────────┐
  │ content script — isolated world                          │
  │   engine, panel, interception                            │
  └──────────────┬───────────────────────────────────────────┘
                 │  chrome.* IPC
  ┌──────────────▼───────────────────────────────────────────┐
  │ extension pages + storage                                │
  │   popup, settings, storage.sync, storage.local           │
  └──────────────────────────────────────────────────────────┘

  the network: not reachable from any of the above
```

## The primary adversary is not an attacker

It is the user's own hurry. Almost every real incident this tool addresses is
someone competent, under time pressure, pasting more than they meant to. That
shapes the design more than any attacker does:

- **It interrupts, it does not forbid.** "Send as-is" is always available and
  always one click. A control that cannot be overridden gets removed entirely,
  and then protects nothing.
- **It defaults to redaction, not cancellation.** The goal is that the person
  still gets their answer. If using the tool costs them the answer, they stop
  using the tool.
- **Low-severity findings never block a send.** An email address in a prompt is
  worth mentioning and not worth an interruption. Crying wolf is the failure
  mode that kills this category of product.

## Threats considered

### T1 — Secret reaches the provider before the user reacts

*Mitigated.* The paste handler runs in the capture phase and calls
`preventDefault()`, so flagged text never enters the composer at all. The
alternative (insert, then clean up) leaves the secret in the host app's state
tree and any draft autosave, however briefly.

### T2 — The host page reads what Chhanni found

*Mitigated by the platform.* Content scripts run in an isolated JavaScript
world; the page cannot reach the engine's variables or the findings array. The
panel is in the shared DOM, so the page can *see* the rendered masked previews —
which is why only masked previews are ever rendered.

### T3 — Chhanni itself exfiltrates

*Mitigated structurally, and tested.* The manifest requests exactly one
permission, `storage`. There is no `host_permissions` entry granting fetch
access, no background service worker, and no remote code. A test in the suite
fails the build if any shipped module references `fetch`, `XMLHttpRequest`,
`sendBeacon`, `WebSocket` or `EventSource`, and a second test asserts
`permissions === ['storage']`.

This is the threat most worth being paranoid about: the user is handing their
credentials to a credential scanner. The defence has to be checkable by a
stranger in under a minute, which is the reason for no bundler and no
dependencies.

### T4 — A fork adds telemetry

*Partially mitigated.* Nothing stops someone forking this and adding a network
call. What the design does is ensure the fork cannot ship anything useful by
accident: findings that leave the engine carry `preview` (masked) and
`fingerprint` (one-way FNV-1a), the CLI's `--json` output strips `match`
entirely, and the history store never receives a raw secret. A naive fork that
POSTs its data collects nothing usable.

`match` — the raw value — exists only in memory, only for the duration of a
redaction call.

### T5 — The history store leaks

*Mitigated by construction.* It holds masked previews and one-way fingerprints.
It is deliberately in `storage.local` rather than `storage.sync`, so a record of
what someone nearly leaked is not replicated to their other devices. It is
capped at 120 events and cleared from one button in the popup.

### T6 — Findings text is used for injection

*Mitigated.* Every string rendered in the panel, popup and settings is written
with `textContent`, never `innerHTML`. Matched values originate in
page-controlled text and are treated as hostile throughout.

### T7 — False positives train the user to click through

*Partially mitigated, and the hardest one.* Nine detectors verify with a
checksum, a decode or an entropy-plus-context test. Severity tiers keep
low-risk findings out of the blocking path. Measured against 57 files of
ordinary source and documentation, the engine reports zero findings.

But this threat is never closed. It degrades with every rule added, which is
why `PROOFS` is an explicit list rather than something inferred, why the count
is pinned by a test, and why the settings page labels each detector `proof` or
`shape` rather than presenting them as equally trustworthy.

### T8 — The user is the carrier, not the leaker

*Partially mitigated.* Someone pastes a web page, a support ticket or a CV that
carries instructions aimed at the model rather than at the reader — OWASP
LLM01, and documented in the wild. The payloads that matter are the ones a
human skims past: text hidden by CSS, instructions in HTML comments, invisible
Unicode, and imperatives addressed to "the assistant".

Detection is advisory, because a document can legitimately *discuss* prompt
injection — this one does. The finding says what was found and the person
decides.

Scanning 87,306 real files taught the limits here. An early version flagged a
**.gitignore** explaining "ignore rules", a threat model discussing "leak
secrets", and API docs saying "send the token". A later one flagged Django's
lazy object for "pretending to be" the class it wraps, and an Ansible log line
for the words "no system message:".

Imperatives now require a deictic target; exfiltration requires a real
destination (a URL, a host or an email address, not "the server"); "pretend to
be" requires something that removes a restriction; and a directive keyword has
to sit at the start of a line the way a header does.

Two of the fixes were internationalisation bugs, and they are the ones worth
remembering. U+200B is not a smuggling character in Khmer, Thai, Lao, Myanmar
or Tibetan — it is the word separator, and Django's Khmer translation carries
fifty in one file. Bidirectional isolates are not an attack in Central Kurdish;
they are how a Latin placeholder sits inside an Arabic-script sentence. Only
the two *overrides*, U+202D and U+202E, force a reading order against the
characters' own direction, which is Trojan Source (CVE-2021-42574). Neither was
findable by reasoning about the code.

### T9 — Organisation policy becomes a telemetry pipe

*Mitigated by construction.* The obvious way to sell this to a company is a
cloud console: rules go down, findings come up. The second half of that
sentence would make every claim in this document false.

Policy arrives through `chrome.storage.managed`, which the browser populates
from Windows GPO, a macOS profile, Chrome Enterprise or Firefox
`policies.json`. It is a local read. No permission is added, and there is no
channel in the other direction. An organisation's internal codenames are
matched on the device and never appear in the published package.

## Explicitly out of scope

Each of these is a real way to leak that Chhanni does not address. They are
listed so nobody mistakes the tool for more than it is.

| Not covered | Why |
|---|---|
| **Text that exists only as pixels** | DOCX, XLSX, PPTX, ODT, PDF and RTF are read now, and an image gives up its EXIF. What no amount of parsing reaches is a screenshot's content: there is no OCR, and there will not be, because Tesseract's WASM build would either triple the package or require a network fetch. The panel names the file and says so. |
| **Closed shadow roots** | Open ones are handled through `composedPath()` and a capped sweep for response text. A closed root is unreachable by any API an isolated world has. |
| **Sites with no granted permission** | Composer detection is by shape rather than by hostname, so a product that ships after this version still works — but only where the user has granted access. The popup now states which of three states the current tab is in and offers to extend coverage to a site the person adds; the extension still cannot widen its own reach unasked. |
| **A determined user** | "Send as-is" exists on purpose. This is a guardrail, not a DLP control, and it should not be sold as one. |
| **Other extensions** | An extension with broader permissions can read the page and the composer. Chhanni cannot defend that boundary. |
| **The provider itself** | Once redacted text is sent, what the provider does with it is their policy, not this tool's. |

Two entries left this table in this version. **Semantic leaks** — "we are
acquiring Acme for $46M and the announcement is on the 12th" — are now six
advisory signals covering unannounced transactions, negotiating positions,
trade secrets before filing, workforce decisions, live litigation and internal
cost. They are advisory because there is nothing in them to replace with a
placeholder. **Novel credential formats** are now `unlabelled_secret`, which
needs no keyword at all. Neither is *solved*; both are better than silent, and
[LIMITATIONS.md](LIMITATIONS.md) says how much better.

## Residual risk, stated plainly

Chhanni reduces the probability that a credential reaches a chat box. It does
not reduce it to zero, and it does not make an organisation compliant with
anything. The honest claim is narrower than the category usually sells: it
catches the common formats, it proves twenty-eight of them arithmetically, it
reads the attachment rather than guessing from its name, it costs nothing to
run, and it is small enough that a sceptical reviewer can verify the no-network
promise themselves in a few minutes.

Everything it does not do is in [LIMITATIONS.md](LIMITATIONS.md), in fifteen
sections, because a boundary nobody states is a boundary everybody crosses.
