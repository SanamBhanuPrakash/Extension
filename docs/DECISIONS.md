# Decisions

Short records of the choices that shaped this, including the ones with a cost.

---

### 1. Redact rather than block

**Context.** Every tool in this category interrupts. Most of them stop at "are
you sure?".

**Decision.** The primary action is *Redact and continue*, which swaps each
secret for a stable placeholder and lets the prompt through.

**Why.** A blocker gets uninstalled the first time it stands between someone and
their deadline. The model never needed the real key to explain a stack trace —
`<AWS_ACCESS_KEY_ID_1>` carries exactly as much meaning for the task at hand.

**Cost.** Redaction has to write back into a framework-controlled composer,
which is the most fragile code in the project.

---

### 2. Placeholders are stable within a document

**Decision.** The same secret appearing three times becomes the same token three
times.

**Why.** It preserves the structure the model needs — "the key on line 4 is the
same one used on line 22" survives redaction. Random tokens per occurrence
would destroy that and make the redacted prompt less useful than the original.

---

### 3. Checksums, not just patterns

**Decision.** Where a format carries its own verification, use it: Luhn,
Verhoeff, mod-97, CRC32, base64 decode.

**Why.** `\d{16}` matches order numbers, tracking IDs and timestamps. Luhn does
not. The entire difference between a tool people keep and one they disable in a
week is how often it is wrong.

**Cost.** Nine of thirty detectors can do this. The rest match a prefix nothing
else uses, which is strong but is not proof — and they are labelled `shape`
rather than `proof` everywhere they appear, including in the UI.

---

### 4. `PROOFS` is an explicit list, not inferred

**Context.** The first version derived "does this detector prove itself?" from
`rule.validate || rule.enrich`. That counted 11 — including the email rule,
whose only validation is excluding `example.com`.

**Decision.** An explicit map naming the proof method for each of the nine
detectors that genuinely verify. A test pins the count.

**Why.** The inferred number was inflated, and it was the central claim the
project makes about itself. A claim you cannot audit is a claim you should not
make.

---

### 5. No network permission, enforced by test

**Decision.** The manifest requests only `storage`. A test fails if any shipped
module references a network API.

**Why.** The user is handing their credentials to a credential scanner. "Trust
us" is not an answer; a permission that does not exist is.

**Cost.** No cloud policy, no central rule updates, no fleet reporting — all of
which an enterprise buyer would want. That is a different product, and it should
be a different product.

---

### 6. No bundler, no dependencies

**Decision.** Plain ESM, copied into the extension by a 20-line script.

**Why.** A reviewer can read the exact bytes that ship. For a tool making a
security claim, auditability beats convenience, and the dependency count is
itself part of the threat model.

**Cost.** MV3 content scripts cannot be ES modules, so `content.js` is an async
IIFE that dynamic-imports the engine from a web-accessible resource.

---

### 7. History is local and never synced

**Decision.** Policy goes in `storage.sync`; detection history goes in
`storage.local`.

**Why.** Settings are worth having on your other machine. A record of what you
nearly leaked is not worth replicating anywhere, even masked.

---

### 8. Scan on paste and Enter, never on keystroke

**Decision.** No input-event scanning in the content script.

**Why.** Typing must cost nothing. The two moments that matter are the two
moments text crosses a boundary, and both are catchable.

**Cost.** Text that arrives by drag-and-drop, or by a host-page action that
bypasses both events, is not seen until Enter.

---

### 9. Low severity never blocks

**Decision.** In the default mode, emails and phone numbers are reported but
never stop a send.

**Why.** Prompts contain email addresses constantly and almost always
legitimately. Blocking on them would train users to dismiss the panel without
reading it, which would break the detectors that matter.
