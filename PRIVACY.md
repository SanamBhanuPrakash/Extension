# Privacy Policy

**Chhanni** — last updated 26 September 2026.

## The short version

Chhanni does not collect, transmit, sell or share any data. It has no server,
no analytics, no crash reporting and no network permission. Nothing you type,
paste or attach ever leaves your browser.

## What it does

Chhanni inspects text you paste or type into an AI chat page, and the files you
attach there, and tells you if it contains credentials, personal data or
confidential material. All of this happens inside your browser, on your device,
while you are looking at it.

Attachments are read in the page. A Word, Excel, PowerPoint or OpenDocument
file is decompressed and its text extracted; a PDF's text is extracted; a
photograph's EXIF metadata is read. None of it is uploaded anywhere, and no
library is downloaded to do it — the decompression is a browser feature
(`DecompressionStream`) and everything else is code in the extension package.

There is no OCR. Text that exists only as pixels — a screenshot, a scanned
contract — is not read, and Chhanni says so by name rather than staying
silent.

## What it stores

Two things, both in your own browser profile:

1. **Your settings** (`chrome.storage.sync`) — which detectors are on, how
   aggressively to interrupt, and any values you have allowlisted. If you are
   signed into your browser, your browser may sync these between your own
   devices. Chhanni cannot read them from anywhere else.

2. **A local history of what was caught** (`chrome.storage.local`) — up to 120
   recent detections. Each entry holds the detector's name, the severity, the
   site, the time, a **masked** preview (for example `AKI************PLE`), and
   a fingerprint. **The actual secret is never stored.** This history is
   deliberately kept out of browser sync, and you can erase it at any time from
   the toolbar popup with **Clear history**.

3. **A random value used to compute those fingerprints**
   (`chrome.storage.local`), generated once when the extension first runs. A
   fingerprint is SHA-256 of that value and the detected text, truncated. It
   exists so the popup can say "you have pasted the same key six times" without
   ever holding the key. Keeping the random value local and out of sync means
   fingerprints cannot be compared between your devices, or with anybody
   else's.

   To be precise rather than reassuring: a fingerprint is not a secret. For a
   short and predictable value, the masked preview — which deliberately keeps
   the first and last few characters, so you can recognise your own key — plus
   the site and the time already narrow things considerably. This store is
   designed so that a leak of it is not a leak of your credentials. It is not
   designed to survive somebody who already has your browser profile, and
   neither is anything else in that profile.

## What it does not do

- It does not make network requests. The extension requests no host permissions
  for network access and contains no `fetch`, `XMLHttpRequest`, `sendBeacon`,
  `WebSocket` or `EventSource` call. An automated test fails the build if one is
  ever added.
- It does not collect personally identifiable information, health information,
  financial information, authentication information, personal communications,
  location, web history, or website content.
- It does not use analytics, telemetry, advertising or tracking of any kind.
- It does not sell or share data with anyone, because it holds none to share.
- It does not use your data for any purpose unrelated to showing you what is in
  your own prompt.

## Permissions

| Permission | Why |
|---|---|
| `storage` | To remember your settings and your local detection history. |
| `scripting` | So that, if you press **"Watch this site too"** in the popup, Chhanni can start checking a site it does not ship with — your company's own AI tool, for instance. It is used for nothing else, and it grants no network access. |
| Host access to listed AI chat sites | To read the text in the composer *on that page only*, so it can be checked before you send it. The text is never transmitted. |
| Optional host access to a site you add | Requested only when you press that button, for the one site you are on. You can revoke it from the same popup, or from your browser's extension settings. |

There are no other permissions. In particular there is no `webRequest`, no
`declarativeNetRequest`, no `cookies`, no `history` and no `downloads`, and an
automated test fails the build if any of them is ever added.

## Your data, your control

Everything is local. Uninstalling the extension removes all of it. **Clear
history** in the popup erases the detection log immediately. Turning individual
detectors off, or switching the extension off entirely, is in Settings.

## Children

Chhanni is a developer and workplace tool. It is not directed at children and
collects no data from anyone, of any age.

## Changes

Material changes to this policy will be published in this file and in the
extension's store listing before they take effect. Because the extension
collects nothing, any future change that introduced collection would be a
fundamental change of character and would be announced as such.

## Contact

Open an issue on the project repository.
