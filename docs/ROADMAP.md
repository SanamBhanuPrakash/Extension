# Roadmap

Where this goes, and why — written so the next decision can be argued with
rather than guessed at.

## The thesis

[Cyberhaven's 2026 figures](https://www.cyberhaven.com/blog/sensitive-data-flowing-into-ai-tools):
**77% of employees paste into AI tools**, 34.8% of ChatGPT inputs contain
sensitive data — up from 11% in 2023 — and **82% of those pastes go through
personal accounts**, roughly 14 a day, at least three of them sensitive.
One organisation in five has already had a breach tied to shadow AI.

Two things follow.

**First, the leak is not happening in the enterprise console.** It is happening
in a personal account, on a personal login, outside whatever the security team
bought. A control that only exists inside a managed browser profile does not
see 82% of the problem. A control that costs nothing, installs in one click and
sends nothing anywhere can.

**Second, the leak is not mostly source code.** 32.8% is code and credentials;
**18.2% is M&A documents and investment models**, and the rest is customer
data, financials and HR records. A tool that only reads regexes over API keys
serves less than a third of the actual exposure — which is the state this
project was in two versions ago.

## Generations, not a list of ideas

The old shape of this file was "Now" and "Next", and the trouble with "Next"
is that it never empties: every audit adds to it and nothing ever leaves. So
the plan is finite and in generations, each with a stated exit. Work that does
not belong to the current generation is written down and **not started**.

The authority on what is in V1 is `V1-CONTRACT.md`; the authority on whether
it can ship is `scripts/gate.js`. This file is the ordering.

---

### V1 — a local boundary for prompts and attachments

**Problem.** 77% of employees paste into AI tools and 82% of those pastes go
through personal accounts, where nothing an organisation bought can see them.

**Capability.** Inspect what crosses from a browser into an AI product, say
what was found and what could not be read, transform it on request, verify
the transformation, and control whether it crosses.

**User value.** The thing you were about to send is caught, you fix it in one
click, and the task still works.

**Security invariant.** No surface claims a stronger state than it has:
`DETECTED ≠ INSPECTED ≠ TRANSFORMED ≠ VERIFIED ≠ PREVENTED ≠ DELIVERED`.

**Not included.** OCR, URL-structural detection, AI-response transformation,
tool arguments, agent actions, any backend, any account.

**Exit.** The sixteen rows of `V1-CONTRACT.md` read `done`, and
`scripts/gate.js --full` reports no `FAIL`. One row does not: provider
certification. That single row is the distance to V1.

---

### V1.x — reliability, and keeping up with five moving products

**Problem.** AI frontends change their composers without notice. A dated
`PASS` is evidence about that date and nothing else.

**Capability.** Drivers for all ten paths in `test/provider/run.mjs`; the
provider adapter boundary made real at the first point a provider needs
behaviour that cannot be expressed as a shape (`SYSTEM-DESIGN.md` §6).

**User value.** It keeps working after ChatGPT redesigns.

**Security invariant.** Provider-specific knowledge never enters the engine.

**Not included.** New representations. No new detectors unless a measured gap
demands one.

**Exit.** All five providers certified across all ten paths, re-certified on a
schedule rather than on a hunch.

---

### V2 — more kinds of artifact

**Problem.** Prompts are not the only thing that crosses. A screenshot of a
dashboard, a presigned URL, a rich-text paste from a document.

**Capability.** New `representation` extractors behind the existing pipeline:
URL structure (query secrets, bearer fragments, presigned signatures, data
URIs), and pixels via local OCR — with a `coverage` state that is honest when
it cannot read them.

**User value.** The commonest blind spot — "I just pasted a screenshot" —
stops being a blind spot.

**Security invariant.** An extractor may only *add* findings. It may never
clear one, lower a severity, or turn `partial` into `clean`.

**Not included.** Any cloud OCR. Any model that runs off the device.

**Exit.** A screenshot of a credential is caught locally, or the UI says it
was not read. Both outcomes are acceptable; silence is not.

---

### V3 — the response and the downstream

**Problem.** What the model sends back is also data crossing a boundary: into
the conversation's history, into a copy-paste, into a file somebody saves.

**Capability.** The response scanner grown from advisory to a boundary with
its own destination and transformations — including restoring aliases in a
reply so the model's answer is usable without the model having seen the real
identities.

**User value.** Pseudonymisation becomes round-trip rather than one-way.

**Security invariant.** Restoring an alias happens locally and only in memory.

**Not included.** Any storage of the mapping.

**Exit.** An aliased conversation can be held end to end without the real
values ever leaving the device.

---

### V4 — tools, agents and browser actions

**Problem.** An agent that can call a tool can carry data out in an argument,
and a confirmation prompt asks *whether* an action may proceed while nothing
inspects *what is in the arguments*.

**Capability.** The same engine on a tool argument and an agent action, with a
destination and a confirmation gate. Decision 31 records why nothing is built
yet: `document.modelContext` does not exist in any shipping browser.

**User value.** The boundary follows the data when the browser starts acting
on its own.

**Security invariant.** Deterministic inspection of arguments, never a model
judging a model.

**Not included.** Anything before there is an API to attach to.

**Exit.** A tool call carrying a credential is held the same way a paste is.

---

### V5 — local policy for organisations

**Problem.** A team wants a floor without a console, a vendor or a data
pipeline.

**Capability.** Managed policy is already read from the browser's own
enterprise channel. This generation is codenames, required detectors, locked
modes and an audit trail that stays on the device.

**User value.** An organisation can set a floor without anybody's data
leaving.

**Security invariant.** Policy is *delivered* to the device and nothing is
reported back. No telemetry, in any generation, ever.

**Not included.** A dashboard. A server. An account.

**Exit.** A policy can be deployed by GPO or a plist and verified locally.

---

## Explicitly not doing

- **A cloud console, telemetry, or a "we analyse your prompts to improve
  detection" clause.** That is the product several well-funded companies
  already sell. Competing with them on their terms means losing on their terms.
- **Blocking that cannot be overridden.** "Send as-is" stays. A control people
  cannot override is a control people uninstall.
- **Claiming compliance.** Chhanni names the regime a finding sits under. It
  does not make anyone compliant with anything, and should never be sold as if
  it did.

## How to argue with this

Every item above is a claim about where the exposure is, and each is checkable.
If the next Cyberhaven report says the mix has moved, the order should move
with it. The benchmark is the gate for anything that touches detection: a
feature that lowers precision below 99% does not ship, however good the demo.

---

## Change control

This section exists because the failure mode of this project is not a missing
feature. It is that an interesting finding arrives, becomes a new roadmap item,
and the roadmap never empties.

**A finding is not a plan.** Every one gets a class:

| class | means | may interrupt the current generation |
|---|---|---|
| **P0** | a release blocker: a silent fail-open, a misleading clean state, an unverified transformation reported as verified | yes, immediately |
| **P1** | required for V1 reliability or security | yes |
| **P2** | V1.x | no |
| **P3** | a later generation | no |
| **OUT** | does not attach to the boundary | not built |

Only P0 and P1 interrupt. Everything else is written down and left.

**Every change answers five questions.** If it cannot, it is not ready:

1. What invariant does this protect?
2. What test proves it, and does that test fail when the change is reverted?
3. What existing behaviour could this break?
4. What documentation must change with it?
5. Does it move toward the frozen architecture in `SYSTEM-DESIGN.md`, or away?

Question 2 is the one that is usually skipped and the one that has caught the
most. Several times in this project a test passed against the broken code it
was written for — a selector that matched the wrong element, an assertion
impossible by construction, an input that produced no finding at all. **A test
that does not fail when the fix is reverted is not evidence.**

**Before building anything, six questions:**

- Does it improve the core pain point?
- Does it reduce a real, measured blind spot?
- Does it make the boundary more trustworthy?
- Does it make the product more useful *after* detection?
- Does it make the system harder to bypass by accident?
- Does it make the thing worth keeping installed?

If the honest answer is no, it does not get built. In particular: no detector
added to raise a count, no screen added to have a screen, no model added to be
able to say there is a model, no telemetry added to obtain a metric.

## What makes it stick

Not notifications, badges, streaks or nagging. The retention argument is a
sequence somebody experiences for themselves:

> I was about to send something I shouldn't have.
> Chhanni caught it.
> I fixed it in one click.
> **The task still worked.**
> I trust it enough to leave installed.

Every line of that is an engineering property — a low false-positive rate,
low latency, a safe transformation, preserved task utility, accurate coverage
— and not a growth mechanic. The fourth line is the one most easily lost, and
it is why aliasing leads over redaction when nothing abusable was found, and
why a formatted prompt keeps its formatting.
