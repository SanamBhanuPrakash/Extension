# Privacy Policy

**Chhanni** — last updated 25 September 2026.

## The short version

Chhanni does not collect, transmit, sell or share any data. It has no server,
no analytics, no crash reporting and no network permission. Nothing you type,
paste or attach ever leaves your browser.

## What it does

Chhanni inspects text you paste or type into an AI chat page, and text-like
files you attach there, and tells you if it contains credentials, personal data
or confidential material. All of this happens inside your browser, on your
device, while you are looking at it.

## What it stores

Two things, both in your own browser profile:

1. **Your settings** (`chrome.storage.sync`) — which detectors are on, how
   aggressively to interrupt, and any values you have allowlisted. If you are
   signed into your browser, your browser may sync these between your own
   devices. Chhanni cannot read them from anywhere else.

2. **A local history of what was caught** (`chrome.storage.local`) — up to 120
   recent detections. Each entry holds the detector's name, the severity, the
   site, the time, a **masked** preview (for example `AKI************PLE`), and
   a one-way hash. **The actual secret is never stored.** This history is
   deliberately kept out of browser sync, and you can erase it at any time from
   the toolbar popup with **Clear history**.

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
| Host access to listed AI chat sites | To read the text in the composer *on that page only*, so it can be checked before you send it. The text is never transmitted. |

There are no other permissions.

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
