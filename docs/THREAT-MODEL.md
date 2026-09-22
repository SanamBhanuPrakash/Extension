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

## Explicitly out of scope

Each of these is a real way to leak that Chhanni does not address. They are
listed so nobody mistakes the tool for more than it is.

| Not covered | Why |
|---|---|
| **File and image uploads** | The extension watches the composer, not the upload path. Dragging in a `.env` or a screenshot of a dashboard bypasses it entirely. This is the biggest gap and the next thing to close. |
| **Sites not in the manifest** | A new AI product ships every week. The list will always be behind. |
| **Semantic leaks** | Describing unreleased pricing in careful prose is a leak. Nothing pattern-based can see it. |
| **Novel credential formats** | These fall through to the entropy rule, which needs a credential-ish word nearby. A bare unknown-format key with no context is missed. |
| **A determined user** | "Send as-is" exists on purpose. This is a guardrail, not a DLP control, and it should not be sold as one. |
| **Other extensions** | An extension with broader permissions can read the page and the composer. Chhanni cannot defend that boundary. |
| **The provider itself** | Once redacted text is sent, what the provider does with it is their policy, not this tool's. |

## Residual risk, stated plainly

Chhanni reduces the probability that a credential reaches a chat box. It does
not reduce it to zero, and it does not make an organisation compliant with
anything. The honest claim is narrower than the category usually sells: it
catches the common formats, it proves nine of them, it costs nothing to run,
and it is small enough that a sceptical reviewer can verify the no-network
promise themselves in a few minutes.
