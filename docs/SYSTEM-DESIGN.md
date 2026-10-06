# System design

This document exists because the project's real risk is no longer a missing
feature. It is that development becomes an endless sequence of audits and
fixes with no frozen shape to fix things *into*. What follows is the shape.

It is deliberately not a tour of the current files — `ARCHITECTURE.md` is
that. This is the long-lived structure: what the system is about, what the
pipeline is, which states must never be confused, and where provider-specific
knowledge is allowed to live.

---

## 1. What the product is

Not *a browser extension with 102 detectors*. The detector count is
engineering credibility, not a user outcome, and a competitor can match it in
a fortnight.

> **Chhanni is a local boundary between a person and an AI system.** Before
> information crosses from somebody's environment into an AI product, Chhanni
> inspects it, says what it found and what it could not read, offers to
> transform it, verifies the transformation, and controls whether it crosses.

Everything in this repository should attach to that sentence. The things that
make it hard to replace are not the regular expressions; they are **coverage
honesty**, **safe transformation**, and **verification against what the
provider actually received**.

Today there is one boundary: `person → AI web application`, in the browser,
for prompts and attachments.

The architecture should let these be added later without rewriting the middle:
a URL, an AI *response*, a tool argument, an agent action, connector data, an
export. **None of those are being built now.** The point of naming them is to
know where the extension points go.

---

## 2. The Artifact

The unit the system reasons about is an **artifact**: one thing crossing the
boundary, with everything known about it attached.

| field | meaning | today |
|---|---|---|
| `source` | where it came from | paste, drop, file picker, typed, page reply |
| `representation` | what kind of thing it is | text, rich text, file, image, clipboard HTML |
| `destination` | where it is going | the page's hostname |
| `content` | the extracted text, and the bytes where relevant | yes |
| `coverage` | what was read, and what was *not* | yes — `coverage`, `sweepLimit`, `rowsRead/rowsTotal` |
| `findings` | what was detected, with tier and provenance | yes — including `encoded` |
| `decision` | what policy says to do | yes — the mode table |
| `transformations` | the plan: spans, placeholders, rewritten bytes | yes — `redact()`/`pseudonymise()` spans |
| `verification` | whether the transformation actually took | yes — read back and rescan |
| `delivery` | held, released, or released as-is by choice | yes — the approval |

This is currently spread across `content.js` locals and the `scan()` result
rather than being one named object. **That is acceptable and is not scheduled
for a refactor.** The fields exist, they are complete, and a rename buys
nothing today. What matters is that no new capability may introduce a field
that lives outside this list — and that if a second representation needs a
second extractor, it attaches here rather than growing another branch in the
paste handler.

---

## 3. The pipeline

    DISCOVER        a composer, a drop, a picker, a reply
      ↓
    EXTRACT         bytes → text, per representation
      ↓
    NORMALISE       only where it is reversible and safe: decode Base64,
                    percent-encoding, hex, entities, string escapes
      ↓
    DETECT          102 detectors, prefiltered and shape-gated
      ↓
    CLASSIFY        severity, confidence, advisory, and **tier**
      ↓
    DECIDE          the mode table — one declaration, read by every path
      ↓
    TRANSFORM       on request: redact, or alias
      ↓
    VERIFY          read the composer back, rescan, refuse on mismatch
      ↓
    DELIVER or HOLD replay the send, or do not
      ↓
    RECORD          masked preview and salted digest, locally, never synced

Every stage exists today. The two that are newest are the two that most
distinguish this from a scanner: **NORMALISE** (a Kubernetes Secret is Base64,
so reading it is support for a format, not anti-evasion) and **VERIFY** (a
transformation that silently failed to take is worse than none, because the
panel has already said it worked).

---

## 4. The states that must never be conflated

This is the spine of the product and the source of most of its past bugs.

| state | the claim it licenses |
|---|---|
| `UNSEEN` | nothing has looked at this |
| `INSPECTING` | looking now — **not** "nothing found" |
| `CLEAN` | inspected in full, nothing found |
| `PARTIAL` | inspected in part, and the part is named |
| `FINDINGS` | something was found |
| `FAILED` | inspection threw — **not** clean |
| `TRANSFORMING` | a change has been asked for |
| `VERIFIED` | the change is present in what will be sent |
| `HELD` | it did not cross |
| `RELEASED` | it crossed, by decision |

And the six claims that are routinely treated as one:

    DETECTED      a key was found
    INSPECTED     everything was looked at
    TRANSFORMED   the value was replaced
    VERIFIED      the replacement is in what will be sent
    PREVENTED     the send did not happen
    DELIVERED     the provider received the transformed version

Each arrow between them is a place this project has had a defect. `DETECTED →
TRANSFORMED` was the redaction that covered one column in five.
`TRANSFORMED → VERIFIED` was "Redact and continue" writing to a composer and
not checking. `VERIFIED → DELIVERED` is the one still open, and it is why
`test/provider/run.mjs` exists: a mock recording nothing and ChatGPT receiving
nothing are different claims.

**Rule.** No surface may render a state as the state to its right.

---

## 5. The policy engine

One declaration, in `content.js`, read by every path:

|  | raises the panel on paste | stops the send |
|---|---|---|
| `strict` | anything found | dangerous or personal |
| `warn` | anything found | dangerous |
| `off` | nothing | nothing |

The stop column is by **tier**, not severity, because severity ranks how bad a
finding is and the tier answers whether it is abusable by whoever receives it.
Those come apart (`email` is `low` and personal; `us_ssn` is `critical` and
dangerous), and conflating them is what made the product interrupt for an
email address the way it interrupts for an API key.

Also fixed by policy, not by handler:

- **Incomplete inspection** is a decision in `strict` and a notice in `warn`.
- **A parser failure** holds the content with an explicit override, in both.
- **Managed policy** can tighten and cannot loosen; it is read off the
  readiness path (decision 33) and merged when it lands.
- **The allowlist** is local-only and never synchronised (decision 40).

---

## 6. The provider boundary

AI frontends change constantly. Provider-specific knowledge must not spread
into the engine.

The conceptual adapter surface, which today is a set of functions in
`content.js` and `composer.js` rather than a registry:

    detectComposer()     which element a person types into
    readComposer()       its text, plus a position map
    writeComposer()      a whole-value write that the framework hears
    replaceSpans()       a per-range write that preserves structure
    detectSend()         which control sends
    replaySend()         re-fire the action that was cancelled
    handleAttachment()   deliver rewritten bytes
    observeCompatibility()  what the provider actually received

**Why this is not a registry yet.** Every function above is already
provider-independent: `composer.js` matches on shapes (`textarea`,
`contenteditable`, an aria-label that is not stop/cancel/attach) rather than
on hostnames, and there is not one `if (host === 'chatgpt.com')` in the
codebase. Introducing per-provider modules before any provider needs one would
add a layer with nothing in it.

**The trigger for building it:** the first time a provider needs behaviour
that cannot be expressed as a shape. When `test/provider/run.mjs` finds that
case, the adapter becomes real, and the engine must not change to accommodate
it.

---

## 7. Verification model

A transformation is not trusted because it was applied. It is trusted because
it was read back.

    plan      = transform(text, findings)      // spans and output, computed once
    applied   = replaceSpans(el, plan.spans)   // or writeComposer, as a fallback
    got       = readComposer(el)               // the same accessor the send uses
    recheck   = scan(got)
    release  ⟺ got === plan.text ∧ ¬stops(recheck)

The same `plan` object serves the preview and the send. Not a recomputation
that ought to agree — the same object, so divergence is impossible rather than
unlikely.

Three failures are distinguished, because they are different news: the editor
rejected the write; the change did not remove what stopped the send; the
composer could not be edited in place and replacing it wholesale would have
destroyed the formatting.

---

## 8. What the future attaches to

Each of these is a new `representation` or a new `destination`, and nothing
else. That is the test of whether this design holds.

| future boundary | what it needs | what it must not need |
|---|---|---|
| a URL | an extractor that parses structure, a transformer that replaces a component | a change to DETECT |
| an image's pixels | an extractor (OCR), a `coverage` state for "not read" | a change to the pipeline |
| an AI response | a destination of "this conversation's history" | a second scanner |
| a tool argument | a source and a destination | a second policy engine |
| an agent action | a destination, and a confirmation gate | a change to the Artifact |

If adding one of these requires changing DETECT, the policy engine, or the
Artifact's field list, the design was wrong and the change should be resisted
until it can be expressed here.
