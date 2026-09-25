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

### 3a. Measure, and publish the number

**Context.** Every product in this category claims accuracy and none publish a
figure. The only public numbers are academic, and they are poor: 25–75%
precision across nine secret-detection tools.

**Decision.** Ship `bench/` — a seeded, reproducible corpus — print precision
and recall from one command, and write down what the number does not cover.

**Why.** It is the only claim in this project a stranger can check in thirty
seconds, and it is the one differentiator an incumbent cannot take by
out-spending: they would have to publish too.

**Cost.** A self-authored corpus flatters its author. Stated in BENCHMARK.md
rather than hidden, along with the fact that a check digit can never reach zero
false positives.

---

### 3b. The benchmark is a gate, not a press release

**Decision.** `test/detect.test.js` fails the build below 99% precision or recall.

**Why.** A number measured once is marketing. A number enforced on every commit
is a property of the system.

**Cost, learned the hard way.** The GSTIN validator had an off-by-one that made
it reject every real GSTIN, and the benchmark reported 100% throughout — the
corpus generator called the same broken function to build its samples. A
benchmark validates *consistency*, not *correctness*. Known-good real-world
vectors in the unit tests are what validate correctness. Both are needed, and
neither substitutes for the other.

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


---

### 10. Issuer ranges on top of Luhn

**Context.** A 15-digit IMEI was being reported as a payment card. It passed
Luhn — because IMEIs carry a Luhn check digit too.

**Decision.** A card must also begin in a range some network actually issues,
*at a length that network actually issues*. 15 digits is a card only if it
starts 34 or 37.

**Why.** Luhn alone accepts about 1 in 10 random digit strings. One check digit
buys one order of magnitude; that is all it can buy. The second, independent
constraint is what makes the detector trustworthy.

**Cost.** A card on an exotic unlisted BIN is missed. The range table is
deliberately conservative, and that trade is the right way round for a tool that
gets uninstalled when it is wrong.

---

### 11. Redact the attachment, don't block the upload

**Decision.** For text-like attachments, offer a new `File` with the same name
and type and the secrets replaced — not merely a refusal.

**Why.** Identical reasoning to redact-don't-block, one layer out. The person
still gets to send their config and still gets their answer.

**Cost.** Binary files cannot be handled this way, so a screenshot of a
dashboard passes untouched. Documented as a gap rather than papered over.

---

### 12. Glass, and a fallback for when it is unavailable

**Decision.** Real `backdrop-filter` surfaces, with an `@supports` fallback that
goes opaque.

**Why.** The panel appears unannounced over someone's work. A translucent layer
reads as something placed *on* the page rather than part of it — which is
exactly what it is, and it keeps the host page's content visible underneath so
the interruption feels like a pause rather than a takeover.

**Cost.** An extension page has nothing behind it to blur, so the popup and
settings paint a soft colour field for the glass to work against. Without it,
`backdrop-filter` is a no-op and the effect is just a flat card.
