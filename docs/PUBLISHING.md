# Publishing

Two commands, no bundler, no build server, no dependency install.

```console
$ node scripts/build.js
chhanni: 27 engine modules -> extension/engine/
chhanni: dist/chrome   613 KB   (Chrome, Edge, Brave, Opera, Arc)
chhanni: dist/firefox  613 KB   (Firefox, Firefox for Android)

$ node scripts/package.js

dist/chhanni-chrome-0.4.0.zip   43 files, 270 KB
  sha256  6dc93a3caec30ac77730570a5dd5ea924da4199446311b29c9a3d7f2a0da5b11
dist/chhanni-firefox-0.4.0.zip  43 files, 270 KB
  sha256  945671d9dad25efd2362d38d688c34fe789c1d9fe1c845996e656a17764190cd
```

**Upload those two files and nothing else.** Packaging used to be a `zip -r`
printed at the end of the build and run by hand, which is the step where the
wrong directory gets shipped. `scripts/package.js` refuses to run if `dist/`
is a different version from `package.json` or has no `engine/` in it, and it
deletes any older package sitting beside the current one — a stale
`chhanni-chrome-0.3.0.zip` next to a 0.4.0 build is exactly how the wrong file
reaches a store.

### The digest is the point

Entries are sorted, timestamps are fixed and compression is deterministic, so
the same commit produces the same bytes. `node scripts/package.js --verify`
rebuilds and fails if the digest moves. Publish the digest with the release
tag: it is the only way a reviewer can check that what is on the store is what
is in the repository, which for a tool that reads credentials is worth more
than any sentence in a privacy policy.

### Loading it unpacked

`extension/` is the development tree, and `extension/engine/` is generated —
it is not in the repository. A clone loaded before `node scripts/build.js` has
run will install, show as enabled, report no error anywhere in Chrome's UI,
and guard nothing. The content script detects that case and says so on the
page rather than failing silently, but run the build first.

## What each store costs

| Store | Fee | Covers | Review |
|---|---|---|---|
| **Chrome Web Store** | **US$5, one time**, per developer account | Chrome, **Brave**, **Opera**, **Arc**, Vivaldi — all install from here | Usually a few days; can run to weeks |
| **Firefox Add-ons (AMO)** | **Free** | Firefox desktop and Firefox for Android | Automated, plus human review for some |
| **Microsoft Edge Add-ons** | **Free** | Edge | Typically under a week |
| Safari | Requires the Apple Developer Program (paid annually) and an Xcode conversion — confirm current terms with Apple before planning this | Safari macOS/iOS | — |

There is **no separate Brave store**. Brave, Opera, Arc and Vivaldi are
Chromium browsers that install from the Chrome Web Store, so the $5 covers
them. That is the whole fee picture: one payment, three stores, most of the
desktop browser market.

## Chrome Web Store requirements

The [2026 policy updates](https://developer.chrome.com/blog/cws-policy-updates-2026)
take effect **1 August 2026**. Chhanni is unusually easy to get through review,
because most of what reviewers scrutinise does not apply:

| Requirement | Status |
|---|---|
| Manifest V3 | Yes |
| Single purpose, clearly stated | Yes — detect sensitive data in a prompt before it is sent |
| Minimum permissions | `storage` only. No `<all_urls>`, no `webRequest`, no `tabs` beyond the popup's active-tab query |
| Justify every permission in the listing | Two: `storage` stores your settings, `scripting` registers the same content script on a site you add yourself. Neither grants network access |
| No remote code | None. No CDN, no `eval`, no hosted script — every byte ships in the package |
| Privacy policy URL | [`PRIVACY.md`](../PRIVACY.md) — publish it at a stable URL and link it |
| Data-use disclosure | "Does not collect or transmit user data" on every category |
| Obfuscated code prohibited | No bundler, no minifier; the shipped source is the written source |

**The data-use disclosure is the part most extensions get wrong and the part
Chhanni answers trivially.** Every category — personally identifiable
information, health information, financial information, authentication
information, personal communications, location, web history, user activity,
website content — is answered the same way: *not collected*. This is verifiable
from the package, because there is no network permission and a test in the
suite fails the build if any shipped module references a network API.

Three certifications are required. All three are true here:

- Data is not sold to third parties. *(There is no data.)*
- Data is not used or transferred for purposes unrelated to the item's single purpose.
- Data is not used or transferred to determine creditworthiness or for lending.

## Firefox

The Gecko build differs in exactly one field: `browser_specific_settings.gecko.id`,
which Firefox requires before it will install an MV3 extension. There is no
background service worker to convert, and no Chrome-only API in use — Firefox
aliases `chrome.*` to `browser.*`.

`strict_min_version` is set to 128.0, which is where Gecko's MV3 support and
`DataTransfer`-based file replacement are both reliable.

AMO runs automated review on upload. A reviewer may ask for source when a build
step is involved; `scripts/build.js` is twenty lines of file copying and the
answer to "where does this file come from" is always "`src/`".

## Listing copy

The store listing is where a five-second read is decided. Suggested short
description, at the 132-character limit Chrome imposes:

> Checks your prompts and attachments for credentials and personal data before
> you send them. Chhanni itself sends nothing anywhere.

130 characters, and it is what `extension/manifest.json` carries, so the
listing and the installed extension say the same thing.

Note what the second sentence is about. An earlier draft said "Nothing is sent
out", which is true of Chhanni and will be read as a claim about the user's
prompt — and the prompt is sent out, to the AI service, which is the entire
reason it was typed. Under the misleading-claims policy the test is whether
the outcome matches the expectation the listing set. It has to be Chhanni that
sends nothing, said in those words.

### The permission question, answered before it is asked

Both stores ask why each permission is needed, and a vague answer is the most
common cause of a rejection. The answers here are short because the permission
set is:

| Permission | The answer |
|---|---|
| `storage` | Settings and a local detection history, both in the user's own profile. Chhanni transmits neither; it has no network permission. |
| `scripting` | Used for exactly one thing: when the user presses "Watch this site too" in the popup, the extension registers its own content script on the one origin they just granted. It is never used to inject into a page the user has not asked for, and it grants no network access. |
| Host permissions (23 AI sites) | To read the composer on those pages so a prompt can be checked before it is sent. |
| `optional_host_permissions` | Requested per-origin, only on that button press, and revocable from the same popup. |

There is no remote code, no `eval`, no CDN and no network call of any kind. The
one thing a reviewer may query is `execCommand('insertText')`, which is
deprecated and is still the only way to write into a ProseMirror or Lexical
editor without desyncing its document model.

Screenshots: `docs/images/` holds renders generated by `scripts/render-ui.mjs`,
which drives real Chromium. Store screenshots must be 1280×800 or 640×400 —
regenerate at that size rather than scaling, or text will soften.

## Version and release

`scripts/build.js` reads the version from `package.json`, so both manifests
always agree. Bump it there and rebuild.

Stores do not allow a version to be replaced once published, and Chrome
enforces publication limits per day, so treat each submission as final.

## After publishing

Both stores email on rejection with a policy clause. The clause almost always
refers to permissions, remote code, or an unclear listing — the three things
this extension has deliberately minimised. If a rejection cites something else,
read it against `docs/THREAT-MODEL.md`, which documents exactly what the
extension does and does not do.
