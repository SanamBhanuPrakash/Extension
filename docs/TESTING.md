# Testing Chhanni on your own machine

Two things cannot be proved in CI, and they are the two that matter most.

The first is whether the extension behaves the same in the browser you actually
use. Brave, Edge, Opera, Arc and Vivaldi are Chromium at the same extension API
level, so the automated suite is meaningful in all of them — but "should be
fine" is not a test result.

The second is **the one that cannot be automated at all**: whether a real AI
product receives what Chhanni says it sent. The suite below asserts against a
mock provider that records what it would transmit. A mock cannot tell you what
ChatGPT's React state contains after a redaction. Section 2 is how you find
that out, by hand, in ten minutes.

---

## 1. The automated suite, in your browser

```console
node scripts/build.js
node test/e2e/run.mjs --browser brave
```

`--browser` takes `brave`, `chrome`, `edge`, or a full path:

```console
node test/e2e/run.mjs --browser "C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe"
```

Playwright is not a dependency of this project. Install it once, without
saving it:

```console
npm install --no-save playwright
npx playwright install chromium
```

Fifteen cases run. They assert on what a mock provider *received*, never on
whether a panel appeared — "the panel was shown" and "the key did not leave"
are different claims and only the second one is the product.

The run begins with a preflight that sends a clean message and requires it to
arrive, then pastes a known credential and requires it to be stopped. If either
is wrong the suite refuses to run, because every assertion in it is of the form
"this did not happen", and that shape passes trivially in a browser where the
extension never loaded. Playwright's headless shell cannot load extensions at
all and does not say so; this is how that gets caught.

### What to expect in Brave

Shields is a browser feature below the layer an extension can reach, and it
blocks third-party network requests from extension pages. Chhanni makes none,
so there is nothing for it to block. The one documented cross-browser
difference worth watching is `chrome.storage.sync` from a content script, which
has been restricted in some Chromium forks; Chhanni falls back to defaults when
that read fails, so the symptom would be settings silently not applying rather
than a crash. If the suite passes in Brave and your settings persist across a
reload, that path is fine.

---

## 2. The real-provider check, by hand

This is the release-blocking class of bug that no mock can find:

> Chhanni replaces what the user **sees** with `<AWS_ACCESS_KEY_ID_1>`, and the
> framework's internal state still holds the original key — so the panel is
> honest, the textarea is clean, and the provider receives the secret anyway.

ChatGPT, Claude and Gemini all use controlled editors (ProseMirror, Lexical,
React). `writeComposer()` in `extension/content.js` goes out of its way to
write through the native setter and `execCommand` for exactly this reason, and
that code has never been run against any of them.

**Do not use a real credential for this.** Use a string that is detected but
worthless:

```
AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE
```

That is AWS's own published documentation key. It is detected as `certain` and
grants nothing.

### The procedure

For each of ChatGPT, Claude and Gemini:

1. Open DevTools → **Network**, and filter to `Fetch/XHR`.
2. Paste the line above into the composer. The panel should appear.
3. Press **Redact and continue**.
4. Check the composer shows `AWS_ACCESS_KEY_ID=<AWS_ACCESS_KEY_ID_1>`.
5. Send the message.
6. In the Network tab, find the request that carries the conversation —
   usually the largest `POST` at that moment — and open its **payload**.
7. Search the payload for `AKIAIOSFODNN7EXAMPLE`.

**If that string appears in the request body, this is a P0 and the extension
must not ship.** The DOM was corrected and the application state was not.

Repeat step 2-7 for each path, because they take different code:

| | |
|---|---|
| paste, then redact, then click **Send** | |
| paste, then redact, then press **Enter** | |
| **type** the key by hand, then click **Send** | the click interceptor |
| **type** the key by hand, then press **Enter** | the keydown interceptor |
| paste, then **Use aliases** | pseudonymisation |
| paste something harmless | must send normally, with no panel |

The last row matters as much as the others. A guard that blocks ordinary
messages gets uninstalled within a day.

### What else to look at while you are there

- **Attach a photo** with EXIF. The panel should offer to remove the metadata,
  and the upload in the Network tab should be smaller than the file on disk.
- **Paste a screenshot.** Chhanni should say it read the metadata and not the
  pixels. That is the honest answer; there is no OCR.
- **Watch the composer after redacting.** Type one more character. If the
  original key reappears, the framework re-synced from its own state and the
  write-back did not take.

### Recording the result

Whatever happens, write it down in `docs/LIMITATIONS.md` under § 4. If a
provider's composer cannot be written to safely, that belongs in the limitations
document on the day it is discovered, not after someone trusts it.
