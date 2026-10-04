/**
 * Chhanni content script.
 *
 * Two interception points, because secrets get into a prompt two ways:
 * people paste them, or they type them and hit send. Both are handled in the
 * capture phase so we run before the page's own submit handler.
 *
 * Everything runs locally. There is no network call in this file and the
 * manifest requests no network permission — not as a privacy nicety, but
 * because a tool that inspects your credentials has no business holding a
 * network handle.
 */
(async () => {
  const url = (p) => chrome.runtime.getURL(p);

  // ────────────────────────────────────────────────────────────── frames
  //
  // The manifest asks for all_frames, because a composer inside an iframe is
  // still a composer and a top-frame-only content script sees straight past
  // it. Several products already put the editor in one; more will.
  //
  // The cost is that every ad slot, analytics pixel and 1x1 tracker on these
  // pages loads this script too. So a subframe pays for the engine only once
  // it actually contains something a person can type into — which an ad slot
  // never does. Until then it holds one idle MutationObserver and nothing
  // else.
  const EDITABLE = 'textarea, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]';

  /**
   * querySelector does not cross a shadow boundary.
   *
   * That one sentence was a hole big enough to drive the whole extension
   * through. The gate below holds a subframe until it contains something a
   * person can type into; `all_frames` puts us in the frame and the shadow-DOM
   * handling elsewhere reads the composer once we are running. Both features
   * worked. They did not compose: a composer inside an iframe inside a shadow
   * root left `document.querySelector` returning null forever, so the promise
   * never resolved, the engine never loaded, and that frame was unguarded for
   * the life of the page — with no error anywhere. Measured against a control
   * with the same composer outside a shadow root, which loaded normally.
   *
   * Bounded, because this runs on every mutation in every subframe of a page
   * we do not control.
   */
  const MAX_ROOTS_SCANNED = 100;
  const deepHasEditable = (root, depth = 0) => {
    try {
      if (root.querySelector(EDITABLE)) return true;
      if (depth > 4) return false;
      let seen = 0;
      for (const node of root.querySelectorAll('*')) {
        const sub = node.shadowRoot;          // null for closed roots
        if (!sub) continue;
        if (++seen > MAX_ROOTS_SCANNED) return false;
        if (deepHasEditable(sub, depth + 1)) return true;
      }
    } catch { /* detached or cross-origin */ }
    return false;
  };
  const hasEditable = () => {
    try { return deepHasEditable(document); } catch { return false; }
  };
  if (window !== window.top && !hasEditable()) {
    await new Promise((resolve) => {
      let obs;
      try {
        obs = new MutationObserver(() => {
          if (!hasEditable()) return;
          obs.disconnect();
          resolve();
        });
        obs.observe(document.documentElement, { childList: true, subtree: true });
      } catch { /* no documentElement yet: this frame is not a chat */ }
    });
  }

  // ───────────────────────────────────────────────── listener-first bootstrap
  //
  // The engine used to be eight sequential dynamic imports and two storage
  // round-trips, all awaited *before* the first listener was attached.
  // Measured on three cold profiles: 1,986 / 1,973 / 1,982 ms from navigation
  // to the first `addEventListener`. For two seconds the page was live, the
  // extension looked installed, and nothing was watching. Somebody who copies
  // a key, opens the tab and pastes lands inside that window.
  //
  // So the listeners go on first and the engine loads underneath them. While
  // it is loading, anything that would carry content out is held rather than
  // passed, because "not ready" is not the same as "nothing found" — the same
  // rule the whole product is built on, applied to its own startup.
  let engineState = 'loading';            // loading | ready | failed
  let engineError = null;

  const looksEditable = (el) =>
    !!el && (el.tagName === 'TEXTAREA' || el.isContentEditable === true);

  /** Cheap, engine-free: does this element carry text a person typed? */
  const rawValue = (el) => {
    try { return el.tagName === 'TEXTAREA' ? el.value : el.innerText; } catch { return ''; }
  };

  let bootNotice = null;
  function holdNotice() {
    if (bootNotice && bootNotice.isConnected) return;
    bootNotice = document.createElement('div');
    bootNotice.className = 'chhanni-notice chhanni-in';
    bootNotice.dataset.chhanniKind = 'starting';
    bootNotice.setAttribute('role', 'status');
    bootNotice.textContent = 'Chhanni is still starting \u2014 that was held, not checked. Try again in a moment.';
    try { document.body.appendChild(bootNotice); } catch { /* no body yet */ }
    setTimeout(() => { bootNotice?.remove(); bootNotice = null; }, 6000);
  }

  function holdWhileLoading(e) {
    if (engineState !== 'loading') return;
    let carries = false;
    try {
      if (e.type === 'paste' || e.type === 'drop') carries = true;
      else if (e.type === 'change') carries = e.target instanceof HTMLInputElement && e.target.type === 'file';
      else if (e.type === 'keydown') carries = e.key === 'Enter' && !e.shiftKey && !e.isComposing && looksEditable(e.target);
      else if (e.type === 'submit') carries = true;
      else if (e.type === 'click') {
        // Only a control that plausibly sends something non-empty. Holding an
        // arbitrary click for two seconds would break the page.
        const btn = e.target?.closest?.('button, [role="button"], input[type="submit"]');
        const scope = btn && (btn.closest('form') || btn.parentElement?.parentElement);
        carries = !!scope && [...scope.querySelectorAll(EDITABLE)].some((el) => rawValue(el).trim().length > 0);
      }
    } catch { carries = false; }
    if (!carries) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    holdNotice();
  }

  const BOOT_EVENTS = ['paste', 'drop', 'change', 'keydown', 'submit', 'click'];
  for (const type of BOOT_EVENTS) {
    try { document.addEventListener(type, holdWhileLoading, true); } catch { /* no document */ }
  }
  const releaseHold = () => {
    for (const type of BOOT_EVENTS) {
      try { document.removeEventListener(type, holdWhileLoading, true); } catch {}
    }
  };

  // Parallel, not sequential: eight round-trips to the extension's own
  // resources have no reason to queue behind each other.
  let scan, groupFindings, RULES, exposureScore, BAND_TEXT, SCORE_NOTE, REGIME_NOTE,
      isComposer, isSendControl, SEND_SELECTOR, mergePolicy, redact, pseudonymise,
      extractDocument, rewriteMode, rewriteBytes, describeKind, store;
  try {
    const [detectM, riskM, regM, compM, manM, redM, docM, storeM] = await Promise.all([
      import(url('engine/detect.js')), import(url('engine/risk.js')),
      import(url('engine/regulations.js')), import(url('engine/composer.js')),
      import(url('engine/managed.js')), import(url('engine/redact.js')),
      import(url('engine/documents.js')), import(url('store.js')),
    ]);
    ({ scan, groupFindings, RULES } = detectM);
    ({ exposureScore, BAND_TEXT, SCORE_NOTE } = riskM);
    ({ REGIME_NOTE } = regM);
    ({ isComposer, isSendControl, SEND_SELECTOR } = compM);
    ({ mergePolicy } = manM);
    ({ redact, pseudonymise } = redM);
    ({ extractDocument, rewriteMode, rewriteBytes, describeKind } = docM);
    store = storeM;
  } catch (err) {
    // extension/engine/ is generated by scripts/build.js and is not in the
    // repository. A clone loaded with "Load unpacked" before running the build
    // reaches exactly here — and Chrome shows the extension as enabled with no
    // error anywhere in its UI. Saying nothing would leave a security tool
    // that is installed, trusted, and inert.
    engineState = 'failed';
    engineError = err;
    releaseHold();
    if (window === window.top) {
      const warn = () => {
        const box = document.createElement('div');
        box.className = 'chhanni-notice chhanni-in';
        box.dataset.chhanniKind = 'engine-failed';
        box.setAttribute('role', 'alert');
        box.textContent = 'Chhanni is not running on this page: its engine did not load, so nothing is being checked. '
          + 'Reload the extension — and if you are running it unpacked, run `node scripts/build.js` first.';
        try { document.body.appendChild(box); } catch {}
      };
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', warn, { once: true });
      else warn();
    }
    return;
  }

  // panel.css is injected by the manifest, but a relative url() inside it
  // would resolve against the host page's origin. The face is declared here
  // instead, against the real extension URL.
  try {
    const face = new FontFace('Inter var', `url(${url('fonts/inter.woff2')})`,
      { weight: '100 900', display: 'block' });
    face.load().then((f) => document.fonts.add(f)).catch(() => {});
  } catch { /* no FontFace support: panel.css falls back to system sans */ }

  const DEFAULTS = { mode: 'warn', disabled: [], allow: [] };
  let policy = DEFAULTS;
  let salt = '';

  /**
   * User settings, with any organisation policy merged over them.
   * `storage.managed` is populated by the browser from enterprise policy —
   * GPO, a macOS profile, Chrome Enterprise, Firefox policies.json. It is a
   * local read; no request leaves the machine.
   */
  /**
   * A random string mixed into every fingerprint, generated once per install
   * and kept in local storage — never in sync, so it does not travel between
   * this person's devices and cannot correlate them.
   *
   * Without it, a fingerprint of a low-entropy value such as an email address
   * is recoverable by anyone willing to hash candidates, however strong the
   * hash. With it there is no shared table to build. Chhanni logs nothing
   * anyway; this is for the fork that adds logging.
   */
  async function loadSalt(existing) {
    try {
      if (typeof existing === 'string' && existing.length >= 22) return existing;
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      const fpSalt = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
      await chrome.storage.local.set({ fpSalt });
      return fpSalt;
    } catch { return ''; }
  }

  /**
   * Policy arrives from two places neither of which this code controls: a
   * synced value that may predate the current schema, and an administrator's
   * GPO or plist. `storage.managed` is populated by the browser from
   * enterprise policy — GPO, a macOS profile, Chrome Enterprise, Firefox
   * policies.json. Both are local reads; no request leaves the machine.
   *
   * A scalar where an array belongs used to be fatal — `new Set(5)` throws,
   * `mergePolicy` threw at load and killed the whole content script, and
   * `scan()` threw per-paste and let the paste through. Both were reachable
   * by a typo, with no attacker involved. Coerce at the boundary and the rest
   * of the engine can keep assuming arrays.
   */
  const ARRAY_FIELDS = ['disabled', 'allow', 'block', 'warn', 'requiredDetectors', 'neverAllow', 'codenames'];
  function sanitisePolicy(raw) {
    const out = (raw && typeof raw === 'object') ? { ...raw } : {};
    for (const key of ARRAY_FIELDS) {
      if (!(key in out)) continue;
      const v = out[key];
      if (Array.isArray(v)) out[key] = v.filter((x) => typeof x === 'string');
      else if (typeof v === 'string') out[key] = [v];
      else delete out[key];               // fall back to the default for that field
    }
    if (out.mode !== undefined && !['strict', 'warn', 'off'].includes(out.mode)) delete out.mode;
    return out;
  }

  /**
   * Policy, in the order it can actually be had.
   *
   * This used to be two awaits before the engine would admit to being ready:
   * `storage.sync` for the person's settings and `storage.managed` for an
   * administrator's. The second one is the problem, and the measurement is
   * stark. `storage.managed.get(null)` resolves through an IPC to the browser
   * process whose reply is dispatched on the renderer's main thread, and on a
   * busy page that thread is not available:
   *
   *   1500-turn thread, renderer idle            3.0 s
   *   1500-turn thread, a reply streaming
   *     and an indicator ticking, 4x throttle   57.8 s
   *
   * Fifty-eight seconds. Not of being wrong — the holding listeners are
   * already attached by then, so nothing leaks — but of a tool that answers
   * every paste with "still starting, that was held". A person who opens a
   * long conversation and pastes something is told to wait a minute, and what
   * they will actually do is switch Chhanni off. Correct and unusable is one
   * of the ways a security product gets uninstalled.
   *
   * Nothing can be done about the renderer being busy. What can be done is to
   * stop an administrator's policy, which nine profiles in ten do not have,
   * from being on the critical path for the nine:
   *
   *   never seen managed policy   go ready on the person's own settings, and
   *                               read managed in the background. If it turns
   *                               out to exist, remember that for next time.
   *   seen it before              wait for it, because this profile is in a
   *                               managed fleet and the administrator's
   *                               policy is the one that counts — with a cap,
   *                               so a stalled policy service cannot hold the
   *                               page open forever.
   *
   * The window this leaves is one page load, once per profile, on the first
   * visit after an administrator deploys a policy — and `storage.onChanged`
   * fires for the managed area too, so even that load picks the policy up as
   * soon as it lands rather than at the next navigation.
   */
  const MANAGED_WAIT_MS = 4000;
  let policyPending = false;

  async function userPolicy() {
    try {
      const stored = await chrome.storage.sync.get('policy');
      if (stored.policy) return { ...DEFAULTS, ...sanitisePolicy(stored.policy) };
    } catch { /* first run; defaults are fine */ }
    return DEFAULTS;
  }

  async function readManaged() {
    try {
      const got = await chrome.storage.managed.get(null);
      return got && Object.keys(got).length ? sanitisePolicy(got) : null;
    } catch { return null; }      // unmanaged, or the area is unavailable
  }

  function applyPolicy(user, admin) {
    try {
      policy = mergePolicy(user, admin);
    } catch {
      // A policy we cannot merge is not a reason to stop protecting the page.
      policy = { ...DEFAULTS };
    }
    policy.fingerprintSalt = salt;
  }

  /** Re-read everything. Used by storage.onChanged, where waiting is free. */
  async function loadPolicy() {
    applyPolicy(await userPolicy(), await readManaged());
  }

  const boot = await (async () => {
    try { return await chrome.storage.local.get(['fpSalt', 'managedSeen']); }
    catch { return {}; }
  })();
  salt = await loadSalt(boot.fpSalt);
  const user = await userPolicy();

  /**
   * When the managed read lands, re-read everything rather than merging over
   * the settings captured at boot.
   *
   * The first version of this closed over `user` and applied `mergePolicy(user,
   * admin)` whenever the managed read resolved — which on a slow page can be a
   * minute later. If the person changed a setting in that minute, the merge
   * would have quietly put the old value back. Policy is cheap to re-read once
   * managed is warm, so re-read it.
   */
  const mergeWhenManagedLands = (pending) => pending
    .then(async (admin) => {
      policyPending = false;
      if (!admin) return;
      await loadPolicy();
      // Remember, so every later load on this profile waits for it.
      try { chrome.storage.local.set({ managedSeen: true }); } catch { /* quota */ }
    })
    .catch(() => { policyPending = false; });

  if (boot.managedSeen) {
    // This profile has had an administrator's policy before, so it is the one
    // that counts and it is worth waiting for — but not indefinitely.
    const pending = readManaged();
    const admin = await Promise.race([
      pending,
      new Promise((r) => setTimeout(() => r(undefined), MANAGED_WAIT_MS)),
    ]);
    if (admin === undefined) {
      // Still coming. Go on without it and merge it when it arrives, rather
      // than discarding the read and leaving the popup saying "pending" for
      // the life of the page.
      policyPending = true;
      applyPolicy(user, null);
      mergeWhenManagedLands(pending);
    } else {
      applyPolicy(user, admin);
    }
  } else {
    applyPolicy(user, null);
    policyPending = true;
    mergeWhenManagedLands(readManaged());
  }

  chrome.storage.onChanged?.addListener((changes, area) => {
    // Our own writes land in `local` — the fingerprint salt and the
    // managed-seen flag — and neither is policy. Re-reading on them would
    // mean every first run issues a second managed read for nothing.
    if (area === 'local' && !(changes && 'policy' in changes)) return;
    loadPolicy().catch(() => {});
  });

  // Everything the handlers need is in place. Stand the holding listeners down.
  engineState = 'ready';
  releaseHold();

  // ───────────────────────────────────────────── three outcomes, not two
  //
  // The old shape was binary: `scan()` returned, and anything it threw escaped
  // the listener before `preventDefault()` ran, so the paste went through. A
  // malformed policy was enough to do it, and the user saw a perfectly normal
  // paste. That is the worst failure a tool like this can have, because it is
  // indistinguishable from success.
  //
  //   clean              inspected, nothing found      -> pass silently
  //   finding            inspected, something found    -> stop, show, offer redact
  //   could not inspect  no information at all         -> stop, say so, explicit override
  //
  // The third one did not exist. "We could not determine whether this is
  // dangerous" is not evidence that it is safe, and it must never be rendered
  // as silence.
  /**
   * The severities that make the panel appear, for the extension.
   *
   * The engine's library default puts `low` in neither the block nor the warn
   * set, which is right for a CLI that prints every finding regardless of
   * verdict. In the extension the verdict is the only thing that decides
   * whether the user ever sees anything, so leaving `low` out meant a pasted
   * email produced a finding, a verdict of 'clean', and silence — in every
   * mode, including the one whose label reads "Everything found — including
   * emails and phone numbers". Measured across all three modes: a lone email
   * and a lone phone number raised no panel on paste, no panel on send, and
   * were sent.
   *
   * A settings page naming the two things that can never fire is not a wording
   * problem. It is the interface claiming coverage the engine does not have,
   * which is the one failure this project exists not to have.
   *
   * With `low` in the warn set both labels become true: the panel appears on
   * paste for anything at all, and the send is interrupted by `block` in warn
   * mode or by anything found in strict mode.
   */
  const scanPolicy = () => ({
    ...policy,
    block: ['critical'],
    warn: ['high', 'medium', 'low'],
  });

  function safeScan(text, opts) {
    const p = scanPolicy();
    try { return { ok: true, result: scan(text, opts ? { ...p, ...opts } : p) }; }
    catch (err) { return { ok: false, err }; }
  }

  /**
   * Approval bound to the exact thing that was approved.
   *
   * "Send as-is" used to open a two-second window during which *any* Enter went
   * through unchecked — measured: a completely different secret, typed and sent
   * inside the window, left with no panel. So an approval became a decision
   * about one specific thing, keyed to a 32-bit FNV-1a digest of it.
   *
   * That digest is gone. FNV-1a is a fast non-cryptographic hash with no
   * collision resistance by design — on a page that is allowed to be hostile,
   * a second input colliding with the approved one is something the page can
   * solve for rather than search for, and the reward is one unscanned send.
   * There is no reason to take that risk: the text is already in memory, so it
   * is compared exactly. Identity for the composer, identity for each File,
   * `===` for the string.
   *
   * The short expiry is a backstop for a re-dispatch that never lands, not the
   * mechanism. One shot, then gone.
   */
  let approval = null;
  const APPROVAL_MS = 4000;

  function approveSend(via, text, target) {
    approval = { kind: `send:${via}`, text, target, until: Date.now() + APPROVAL_MS };
  }
  function approvedSend(via, text, target) {
    const a = approval;
    if (!a || a.kind !== `send:${via}` || Date.now() > a.until) return false;
    if (a.target !== target || a.text !== text) return false;
    approval = null;
    return true;
  }

  function approveFiles(kind, files) {
    approval = { kind, files: [...files], until: Date.now() + APPROVAL_MS };
  }
  function approvedFiles(kind, files) {
    const a = approval;
    if (!a || a.kind !== kind || Date.now() > a.until || !a.files) return false;
    if (a.files.length !== files.length) return false;
    // Object identity: these are the very File objects handed back, not a
    // description of them that something else could reproduce.
    for (let i = 0; i < files.length; i++) if (a.files[i] !== files[i]) return false;
    approval = null;
    return true;
  }

  /** The panel for "we could not look at this", with the override made explicit. */
  function showCannotInspect({ what, detail, onProceed, onCancel }) {
    closePanel();
    panel = el('div', 'chhanni-panel chhanni-block chhanni-band-elevated');
    panel.setAttribute('role', 'alertdialog');
    panel.setAttribute('aria-live', 'assertive');

    const head = el('div', 'chhanni-head');
    const gauge = el('div', 'chhanni-gauge');
    gauge.append(el('b', null, '?'), el('span', null, '/100'));
    gauge.setAttribute('aria-label', 'Exposure unknown');
    const headText = el('div', 'chhanni-headtext');
    headText.append(el('strong', null, 'Chhanni could not check this.'));
    headText.append(el('p', null, what));
    headText.append(el('span', 'chhanni-scorenote', 'Not inspected is not the same as clean.'));
    head.append(gauge, headText);
    const close = el('button', 'chhanni-x', '\u00d7');
    close.setAttribute('aria-label', 'Dismiss');
    close.onclick = () => { closePanel(); onCancel?.(); };
    head.appendChild(close);
    panel.appendChild(head);

    const body = el('div', 'chhanni-body');
    const block = el('div', 'chhanni-coverage');
    block.appendChild(el('h3', null, 'What went wrong'));
    const list = el('ul');
    list.appendChild(el('li', null, detail));
    block.appendChild(list);
    body.appendChild(block);
    panel.appendChild(body);

    const actions = el('div', 'chhanni-actions');
    const cancelBtn = el('button', 'chhanni-primary', 'Stop and let me look');
    cancelBtn.onclick = () => { closePanel(); onCancel?.(); };
    const proceedBtn = el('button', 'chhanni-ghost', 'Send without checking');
    proceedBtn.onclick = () => { closePanel(); onProceed?.(); };
    actions.append(cancelBtn, proceedBtn);
    panel.appendChild(actions);
    panel.appendChild(el('div', 'chhanni-foot', 'Checked on this device. Chhanni made no network request.'));

    document.body.appendChild(panel);
    requestAnimationFrame(() => panel?.classList.add('chhanni-in'));
    cancelBtn.focus();
    onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); closePanel(); onCancel?.(); }
    };
    document.addEventListener('keydown', onKey, true);
  }

  // ------------------------------------------------------------- composer
  //
  // Identified by shape rather than by a hostname list. A new AI product ships
  // every week and a hand-maintained list is always behind — worse, the gap is
  // invisible, because the extension looks installed while watching nothing.
  const isEditable = (el) => {
    if (!el || (el.tagName !== 'TEXTAREA' && !el.isContentEditable)) return false;
    try { return isComposer(el); } catch { return true; }
  };

  /**
   * The element a person actually typed into.
   *
   * An event that crosses a shadow boundary is retargeted: paste into a
   * <textarea> inside an open shadow root arrives with `e.target` set to the
   * *host* element, which is a plain <div> and fails every editability test.
   * Verified in Chromium, not assumed. composedPath()[0] is the real one.
   *
   * A closed shadow root is not reachable at all — not by composedPath, not by
   * innerText, not by any API available to an extension's isolated world. That
   * is a genuine blind spot and it is written down in docs/LIMITATIONS.md
   * rather than papered over.
   */
  const eventTarget = (e) => {
    try {
      const path = e.composedPath && e.composedPath();
      if (path && path.length) return path[0];
    } catch { /* fall through */ }
    return e.target;
  };
  const readComposer = (el) => (el.tagName === 'TEXTAREA' ? el.value : el.innerText);

  /**
   * These composers are React- or ProseMirror-controlled. Assigning .value or
   * .innerText desyncs the framework's own state and the next keystroke
   * restores the secret. React listens for the native setter plus a bubbling
   * input event; ProseMirror listens for execCommand.
   */
  function writeComposer(el, value) {
    if (el.tagName === 'TEXTAREA') {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype, 'value',
      ).set;
      setter.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    document.execCommand('insertText', false, value);
  }

  /** Rule ids whose value has a shape worth preserving as an alias. */
  const ALIASABLE = new Set(['person_name', 'postal_address', 'email', 'phone_india']);

  // ---------------------------------------------------------------- panel
  let panel = null;
  let onKey = null;

  function closePanel() {
    if (onKey) { document.removeEventListener('keydown', onKey, true); onKey = null; }
    panel?.remove();
    panel = null;
  }

  const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low'];

  /**
   * The subtitle under the score. A count, never an enumeration: naming all
   * seven findings produced a four-line heading that pushed the findings
   * themselves below the fold.
   */
  function headline(result, where) {
    if (result.table) return `${result.table.rows.toLocaleString()} records ${where}`;
    const groups = result.groups;
    if (!groups.length) return `Nothing found ${where}`;
    if (groups.length === 1 && groups[0].occurrences === 1) return `${groups[0].label} ${where}`;
    const total = groups.reduce((n, g) => n + g.occurrences, 0);
    const sensitive = groups
      .filter((g) => g.severity === 'critical' || g.severity === 'high')
      .reduce((n, g) => n + g.occurrences, 0);
    return sensitive && sensitive < total
      ? `${total} things ${where}, ${sensitive} of them sensitive`
      : `${total} things ${where}`;
  }

  /**
   * What the scanner did not look at, when an input was too large to read
   * whole. Two million bytes is the ceiling; past it Chhanni reads the front
   * and the back and says how much fell between, rather than reporting a
   * clean result over a document it only partly opened.
   */
  function scanCoverage(result, what = 'This') {
    const c = result && result.coverage;
    if (!c) return [];
    const size = (n) => `${(n / 1048576).toFixed(1)} MB`;
    return [`${what} is ${size(c.total)} \u2014 Chhanni read the first ${size(c.head)} and the last ${size(c.tail)}. The ${size(c.skipped)} between them was not read.`];
  }

  const SEVERITY_TITLE = {
    critical: 'Can be used against you immediately',
    high: 'Sensitive',
    medium: 'Worth knowing about',
    low: 'Personal, lower risk',
  };

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    // textContent everywhere: findings echo page-controlled text.
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /**
   * The panel leads with one number.
   *
   * Asked to judge a list of nine items in the two seconds before pressing
   * Enter, most people press Enter. A 0-100 score with one sentence under it
   * is a decision someone can actually make at speed; the detail below is for
   * whoever wants it.
   */
  function showPanel({ result, title, onRedact, onProceed, onDismiss, onPseudonymise,
                       redactLabel, proceedLabel, coverage, plan, destination, sendText }) {
    closePanel();
    const { risk, band, table, groups, findings, regimeNames } = result;
    const verdict = result.verdict;

    panel = el('div', `chhanni-panel chhanni-${verdict} chhanni-band-${risk.band}`);
    panel.setAttribute('role', 'alertdialog');
    panel.setAttribute('aria-live', 'assertive');

    // ── score header ────────────────────────────────────────────────
    const head = el('div', 'chhanni-head');
    const gauge = el('div', 'chhanni-gauge');
    gauge.append(el('b', null, String(risk.score)), el('span', null, '/100'));
    gauge.setAttribute('aria-label', `Exposure score ${risk.score} out of 100`);

    const headText = el('div', 'chhanni-headtext');
    headText.append(el('strong', null, band || title));
    headText.append(el('p', null, title));
    // The number looks precise. It is a ranking, and it says so — under the
    // headline, where it is read once rather than crowding the digits.
    headText.append(el('span', 'chhanni-scorenote', SCORE_NOTE));
    gauge.title = SCORE_NOTE;
    head.append(gauge, headText);

    const close = el('button', 'chhanni-x', '\u00d7');
    close.setAttribute('aria-label', 'Dismiss');
    close.onclick = () => { closePanel(); record('dismissed'); onDismiss?.(); };
    head.appendChild(close);
    panel.appendChild(head);

    const body = el('div', 'chhanni-body');

    // ── bulk disclosure, when there is one ──────────────────────────
    if (table) {
      const bulk = el('div', 'chhanni-bulk');
      bulk.append(el('h3', null, 'Bulk disclosure'), el('p', null, table.description));
      body.appendChild(bulk);
    }

    // ── which law this touches ──────────────────────────────────────
    if (regimeNames && regimeNames.length) {
      const regs = el('div', 'chhanni-regimes');
      // Not "Regulated under", which reads as a finding of fact about your
      // organisation. Chhanni cannot see the jurisdiction, the purpose or the
      // lawful basis, and a chip that looks like a verdict is worse than no
      // chip at all.
      regs.appendChild(el('h3', null, 'Rules about this kind of data'));
      const chips = el('div', 'chhanni-chips');
      for (const name of regimeNames.slice(0, 5)) chips.appendChild(el('span', 'chhanni-chip', name));
      regs.appendChild(chips);
      regs.appendChild(el('p', 'chhanni-regnote', REGIME_NOTE));
      body.appendChild(regs);
    }

    // ── findings, collapsed by detector and grouped by severity ─────
    const bySeverity = new Map();
    for (const g of groups) {
      if (!bySeverity.has(g.severity)) bySeverity.set(g.severity, []);
      bySeverity.get(g.severity).push(g);
    }
    for (const severity of SEVERITY_ORDER) {
      const group = bySeverity.get(severity);
      if (!group) continue;
      if (severity === 'low') {
        const labels = [...new Set(group.map((g) => g.label))].join(', ');
        panel.dataset.alsoText = `Also found, lower risk: ${labels}.`;
        continue;
      }
      const section = el('div', `chhanni-group chhanni-sev-${severity}`);
      section.appendChild(el('h3', null, SEVERITY_TITLE[severity]));
      const list = el('ul');
      for (const g of group.slice(0, 6)) {
        const li = el('li');
        const row = el('div', 'chhanni-row');
        const label = el('span', 'chhanni-label', g.label);
        if (g.occurrences > 1) label.appendChild(el('i', 'chhanni-count', `\u00d7${g.occurrences}`));
        // Advisory and blocking findings need to be told apart at a glance.
        // "Payment card number" is a value that can be replaced; "Possible
        // inside information" is what the text is *about*, and redacting it
        // would destroy the question being asked.
        if (g.advisory) label.appendChild(el('i', 'chhanni-tag', 'context'));
        row.appendChild(label);
        row.appendChild(el('code', g.advisory ? 'chhanni-quote' : null, g.preview));
        li.appendChild(row);
        if (g.note) li.appendChild(el('em', null, g.note));
        list.appendChild(li);
      }
      if (group.length > 6) list.appendChild(el('li', 'chhanni-more', `and ${group.length - 6} more`));
      section.appendChild(list);
      body.appendChild(section);
    }
    panel.appendChild(body);

    if (panel.dataset.alsoText) {
      panel.appendChild(el('div', 'chhanni-also', panel.dataset.alsoText));
    }
    // What was *not* read, named file by file. Silence here would be the
    // worst outcome this extension can produce: a screenshot nobody could
    // look inside, reported the same way as one that came back clean.
    if (coverage && coverage.length) {
      const block = el('div', 'chhanni-coverage');
      block.appendChild(el('h3', null, 'What Chhanni could not read'));
      const list = el('ul');
      for (const line of coverage.slice(0, 4)) list.appendChild(el('li', null, line));
      if (coverage.length > 4) {
        list.appendChild(el('li', 'chhanni-more', `and ${coverage.length - 4} more`));
      }
      block.appendChild(list);
      panel.appendChild(block);
    }

    // ── actions ─────────────────────────────────────────────────────
    const redactable = findings.filter((f) => !f.advisory).length;
    const advisory = findings.length - redactable;

    // ── what actually leaves, if you press the primary button ──
    //
    // A findings count answers "how bad". It does not answer the question the
    // person is actually asking, which is "what is about to reach the model".
    // Those are different, and the second one is the only one they can act on.
    if (destination || sendText !== undefined) {
      const recv = el('div', 'chhanni-receive');
      recv.appendChild(el('h3', null, destination ? `What ${destination} will receive` : 'What the model will receive'));
      const lines = el('ul');
      if (redactable) {
        lines.appendChild(el('li', null,
          `${redactable} value${redactable === 1 ? '' : 's'} replaced with ${onPseudonymise ? 'a placeholder or an alias' : 'a placeholder'}`));
      }
      if (advisory) {
        lines.appendChild(el('li', null,
          `${advisory} thing${advisory === 1 ? '' : 's'} marked “context” stay as written`));
      }
      if (typeof sendText === 'string') {
        const kept = Math.max(0, sendText.length - findings.filter((f) => !f.advisory)
          .reduce((n, f) => n + (f.end - f.start), 0));
        lines.appendChild(el('li', null, `${kept.toLocaleString()} characters of your message, unchanged`));
      }
      for (const line of (coverage || []).slice(0, 2)) {
        lines.appendChild(el('li', 'chhanni-receive-gap', `Not inspected — ${line}`));
      }
      recv.appendChild(lines);
      panel.appendChild(recv);
    }

    const actions = el('div', 'chhanni-actions');
    const redactBtn = el('button', 'chhanni-primary',
      redactLabel || (redactable
        ? `Redact ${redactable} and continue`
        : 'I understand, continue'));
    redactBtn.onclick = () => { closePanel(); record('redacted'); onRedact(); };
    const proceedBtn = el('button', 'chhanni-ghost', proceedLabel || 'Send as-is');
    proceedBtn.onclick = () => { closePanel(); record('sent'); onProceed(); };
    // Aliases, where the shape of the value is the thing the model needs.
    // Offered only when at least one finding is identity-shaped, because
    // "Person_A" helps and a pseudonymised API key does not exist.
    const aliasable = onPseudonymise && findings.some((f) => !f.advisory && ALIASABLE.has(f.ruleId));
    if (aliasable) {
      const aliasBtn = el('button', 'chhanni-second', 'Use aliases');
      aliasBtn.title = 'Replace names, emails, phone numbers and addresses with stable stand-ins, so the model can still follow who is who.';
      aliasBtn.onclick = () => { closePanel(); record('redacted'); onPseudonymise(); };
      actions.append(redactBtn, aliasBtn, proceedBtn);
    } else {
      actions.append(redactBtn, proceedBtn);
    }
    panel.appendChild(actions);

    // Exactly what the redact button will do to each file. A .docx cannot be
    // rewritten in place, and promising otherwise would be the lie that
    // makes someone stop trusting the tool.
    if (plan && plan.length) {
      const block = el('div', 'chhanni-plan');
      const list = el('ul');
      for (const line of plan.slice(0, 4)) list.appendChild(el('li', null, line));
      if (plan.length > 4) list.appendChild(el('li', 'chhanni-more', `and ${plan.length - 4} more`));
      block.appendChild(list);
      panel.appendChild(block);
    }

    if (advisory) {
      const block = el('div', 'chhanni-plan');
      const list = el('ul');
      list.appendChild(el('li', null, redactable
        ? `Redacting replaces ${redactable} value${redactable === 1 ? '' : 's'}. The ${advisory} marked \u201ccontext\u201d stay \u2014 they are what the text is about, not values in it.`
        : `Nothing here can be replaced with a placeholder. These ${advisory} are what the text is about, not values in it. This is a decision, not a fix.`));
      block.appendChild(list);
      panel.appendChild(block);
    }

    const hint = el('div', 'chhanni-hint');
    hint.append(el('kbd', null, 'Enter'),
      document.createTextNode(redactable ? ' redact  \u00b7  ' : ' continue  \u00b7  '),
      el('kbd', null, 'Esc'), document.createTextNode(' back to editing'));
    panel.appendChild(hint);

    // Precise about the subject. Chhanni made no request; the prompt itself is
    // still on its way to whichever provider this page belongs to the moment
    // the person continues, and "nothing was sent anywhere" would be read as a
    // claim about that. It is the one sentence on this surface that the reader
    // has no way to check, so it has to be the one that is exactly true.
    panel.appendChild(el('div', 'chhanni-foot',
      'Checked on this device. Chhanni made no network request.'));

    document.body.appendChild(panel);
    requestAnimationFrame(() => panel?.classList.add('chhanni-in'));
    redactBtn.focus();

    function record(action) {
      store.record(findings.filter((f) => !f.advisory), { host: location.hostname, action })
        .catch(() => {});
    }

    onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); closePanel(); record('dismissed'); onDismiss?.(); }
      else if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault(); e.stopImmediatePropagation();
        closePanel(); record('redacted'); onRedact();
      }
    };
    document.addEventListener('keydown', onKey, true);
  }


  // ═══════════════════════════════════════════════════ what comes back
  //
  // Nobody scans the response. Two things there are worth catching:
  //
  //   1. the model echoing your own credential back into a transcript that is
  //      now shared, logged and often exported; and
  //   2. an indirect prompt-injection payload arriving in the answer, aimed at
  //      whatever reads it next — a teammate, or an agent with tools.
  //
  // This is a notice, not a panel. The text has already arrived; blocking it
  // would be theatre. What the person can still do is not paste it onward.

  let noticeEl = null;
  let noticeTimer = null;

  /**
   * @param {string} message
   * @param {string} kind  what this notice is about, as a stable handle for
   *   tests and for the panel's own hit-testing. Three unrelated things wear
   *   the `chhanni-notice` class — the boot hold, the engine-failure banner
   *   and this — and a test that asserted on the class alone passed against
   *   a build where the response scanner never ran at all.
   */
  function showNotice(message, kind = 'general') {
    clearTimeout(noticeTimer);
    noticeEl?.remove();
    noticeEl = el('div', 'chhanni-notice');
    noticeEl.dataset.chhanniKind = kind;
    noticeEl.setAttribute('role', 'status');
    noticeEl.append(el('span', 'chhanni-notice-dot'), el('span', null, message));
    const close = el('button', 'chhanni-notice-x', '\u00d7');
    close.setAttribute('aria-label', 'Dismiss');
    close.onclick = () => { noticeEl?.remove(); noticeEl = null; };
    noticeEl.appendChild(close);
    document.body.appendChild(noticeEl);
    requestAnimationFrame(() => noticeEl?.classList.add('chhanni-in'));
    noticeTimer = setTimeout(() => { noticeEl?.remove(); noticeEl = null; }, 14000);
  }

  // ─────────────────────────────────────────────────────── the clean state
  //
  // Silence meant six different things: everything is fine, the extension is
  // not running, the site is not watched, the engine is still loading, the
  // scan failed, or the page changed shape. A security tool cannot let its
  // success and its failure look identical — and this audit found two cases
  // where the difference mattered and nobody could see it.
  //
  // So a check that found nothing says so, once, briefly, and gets out of the
  // way. It is deliberately not a badge that sits there: a permanent green
  // tick is read as a guarantee, and what this can honestly report is "I
  // looked at this, just now, and here is how much of it I saw".
  let cleanPill = null;
  let cleanTimer = null;

  function markClean(result) {
    if (policy.showClean === false) return;
    const gaps = scanCoverage(result, 'This');
    clearTimeout(cleanTimer);
    cleanPill?.remove();
    cleanPill = el('div', `chhanni-clean${gaps.length ? ' chhanni-clean-partial' : ''}`);
    cleanPill.setAttribute('role', 'status');
    cleanPill.append(el('span', 'chhanni-clean-tick', gaps.length ? '\u25cb' : '\u2713'));
    cleanPill.appendChild(el('span', null, gaps.length
      ? 'Checked \u2014 part of it was too large to read'
      : 'Checked \u2014 nothing found'));
    try { document.body.appendChild(cleanPill); } catch { return; }
    requestAnimationFrame(() => cleanPill?.classList.add('chhanni-in'));
    cleanTimer = setTimeout(() => { cleanPill?.remove(); cleanPill = null; }, gaps.length ? 4200 : 1900);
  }

  const seenResponses = new Set();

  /**
   * The page's rendered text, including open shadow roots.
   *
   * `document.body.innerText` stops at a shadow boundary — measured in
   * Chromium, where text inside an open root is rendered on screen and absent
   * from innerText. A chat UI built on web components would therefore have had
   * its entire transcript invisible to the response scanner.
   *
   * The sweep is capped, and the caps are the point of `sweepLimit`. A limit
   * that is hit silently turns "we stopped looking" into "nothing found",
   * which is the one failure mode this whole product exists to prevent. So
   * each cap records why it fired, and the popup says so.
   */
  const MAX_SWEEP_NODES = 20000;
  const MAX_SHADOW_ROOTS = 200;

  /** null when the last read was complete; otherwise why it was not. */
  let sweepLimit = null;

  function visibleText() {
    sweepLimit = null;
    let text = '';
    try { text = document.body?.innerText || ''; } catch { sweepLimit = 'dom'; return ''; }
    let nodes;
    try { nodes = document.body?.querySelectorAll('*'); } catch { sweepLimit = 'dom'; return text; }
    if (!nodes) { sweepLimit = 'dom'; return text; }
    if (nodes.length > MAX_SWEEP_NODES) { sweepLimit = 'nodes'; return text; }
    let roots = 0;
    for (const node of nodes) {
      const root = node.shadowRoot;   // null for closed roots, and for most nodes
      if (!root) continue;
      if (++roots > MAX_SHADOW_ROOTS) { sweepLimit = 'roots'; break; }
      try { text += '\n' + (root.textContent || ''); } catch { /* detached */ }
    }
    return text;
  }

  /**
   * When a pass runs.
   *
   * A trailing debounce is right: a streamed reply mutates the DOM dozens of
   * times a second and scanning per token would be absurd. What was missing
   * was a ceiling. The timer was cleared and reset on *every* mutation, so a
   * page that mutates more often than the interval reset it forever and the
   * scanner never ran at all — not late, never.
   *
   * That is not hypothetical. Every product on the match list keeps something
   * moving in the DOM: a typing indicator, a caret, a shimmer, a token
   * counter. Measured in Chromium against a 600-turn fixture with an
   * indicator ticking every 400 ms, a reply carrying a credential streamed in
   * full and no notice appeared for the fifteen seconds the test waited. The
   * feature shipped, was documented, and was dead on the pages it was for.
   *
   * So: the same debounce, with a hard ceiling. A pass runs within MAX_WAIT_MS
   * of the first mutation that is still unscanned, whatever else arrives.
   */
  const DEBOUNCE_MS = 1200;

  /**
   * How often a pass may run, decided by what a pass costs here.
   *
   * A fixed ceiling is a bet on the machine, and this file has already paid
   * for one of those. Reading the page's text is the expensive part and it
   * scales with the conversation: 12 ms on a 1500-turn thread on a desktop,
   * 64 ms with the renderer throttled 4x. A three-second ceiling is 0.4% of
   * the main thread in the first case and 2% in the second, and on a machine
   * slower still it would keep climbing.
   *
   * So the ceiling is derived from the measurement instead of asserted: a
   * pass times itself, and the interval is set so the scanner never takes
   * more than SHARE of one core. On a short thread that floors at three
   * seconds; on a 1.7 MB thread on a slow machine it stretches, and the
   * notice about a credential in a reply arrives later. That is the honest
   * trade — later, and stated in the popup, rather than a page that stutters
   * while somebody is reading it.
   */
  const MIN_WAIT_MS = 3000;
  const MAX_WAIT_CAP_MS = 20000;
  const SHARE = 0.02;
  let passCost = 0;
  let maxWait = MIN_WAIT_MS;
  let responseTimer = null;
  let ceilingTimer = null;

  function notePassCost(ms) {
    // Weighted toward history rather than the latest sample: one slow pass
    // during a layout storm should not retune the whole session.
    passCost = passCost ? passCost * 0.7 + ms * 0.3 : ms;
    maxWait = Math.min(MAX_WAIT_CAP_MS, Math.max(MIN_WAIT_MS, Math.round(passCost / SHARE)));
  }

  function schedulePass(delay = DEBOUNCE_MS) {
    clearTimeout(responseTimer);
    responseTimer = setTimeout(runPass, delay);
    if (ceilingTimer === null) ceilingTimer = setTimeout(runPass, maxWait);
  }

  function runPass() {
    clearTimeout(responseTimer);
    clearTimeout(ceilingTimer);
    responseTimer = null;
    ceilingTimer = null;
    const t0 = performance.now();
    try { inspectResponses(); } catch { /* never let a pass break the page */ }
    notePassCost(performance.now() - t0);
  }

  /**
   * What gets scanned, in what order, and how much is promised.
   *
   * Three measurements shaped this, and the second one was the author's own
   * fix making things worse.
   *
   * The mark used to start at zero and walk forward one window per pass. That
   * is the right instinct for completeness and exactly backwards for urgency:
   * on a 1.7-million-character thread the reply that *just arrived* was the
   * seventy-first thing the scanner looked at. Measured notice latency on a
   * streamed reply carrying a credential — 3.0 s at 50 turns, 4.9 s at 600,
   * 10.6 s at 1500 — a number that grew with the length of a transcript that
   * was already on screen before the page loaded.
   *
   * Inverting it fixed the latency, and the first attempt paid for that by
   * backfilling the whole transcript from an idle callback. On this machine
   * that was free. With the renderer throttled 4x — a shared CI runner, a
   * Chromebook, a laptop with a build running — it was 5,705 ms of main-thread
   * blocking on a 1500-turn page, because 71 chunks of 24 KB is seconds of
   * scanning however politely it is scheduled, and an idle callback that
   * overruns a frame is a long task like any other.
   *
   * So the budget is explicit and small:
   *
   *   a pass reads forward from where the text last ended, which is the new
   *   text and nothing else, in slices small enough to stay a short task;
   *
   *   the transcript that was already there is read newest-first, because
   *   that is where anything worth saying is, up to MAX_HISTORY_BYTES; and
   *
   *   whatever is above that line is not read, and the popup says so. A cap
   *   that is stated is a limitation. A cap that is silent is this product
   *   telling the same lie it exists to catch.
   */
  const RESCAN_OVERLAP = 1000;
  const PASS_BYTES = 6000;        // one scan unit; small enough not to jank
  const SLICE_BUDGET_MS = 20;     // how long one pass may hold the thread
  const MAX_HISTORY_BYTES = 120000;

  let growthFrom = -1;      // -1 until the first pass sets the waterline
  let waterline = 0;        // text length at the first pass: below it is old
  let historyFrom = 0;      // the history cursor, descending from waterline
  let historyFloor = 0;     // and where it stops
  let historyHandle = null;

  /**
   * How much of this conversation has not been read.
   *
   * Derived, not stored. An earlier version recorded the budget's floor once
   * and reported that, which was wrong in the direction that matters: on a
   * page that never goes idle the walk does not progress, and a fixed number
   * would have claimed the recent history was read when the cursor had not
   * moved at all. Everything below the cursor is unread, whether because the
   * budget stops there or because the page has been too busy to get to it.
   */
  const unreadHistory = () => (growthFrom < 0 ? 0 : Math.max(0, historyFrom));

  /**
   * The page's text, read as rarely as it can be.
   *
   * `document.body.innerText` forces a synchronous layout of the whole
   * document: 19 ms on a 1500-turn thread on this machine, 115 ms with the
   * renderer throttled 4x. That is the single most expensive thing this file
   * does, and the first two attempts at the scanner both paid it far more
   * often than they needed to — once per chained pass, and once per history
   * slice, which together were most of the blocking the budgets caught.
   *
   * So there are two caches with two different lifetimes, because there are
   * two different claims being made:
   *
   *   the live page   may have changed since the last read, so the cache is
   *                   good for CACHE_MS — long enough to cover a chain of
   *                   passes 60 ms apart, short enough that a mutation-driven
   *                   pass a second later gets fresh text.
   *   the history     is the transcript below the waterline, which by
   *                   definition was there before the page finished loading
   *                   and does not change. One snapshot serves the whole
   *                   walk, and is dropped when it ends.
   */
  let cached = '';
  let cachedAt = 0;
  const CACHE_MS = 400;

  function pageText(force) {
    const t = Date.now();
    if (!force && cached && t - cachedAt < CACHE_MS) return cached;
    cached = visibleText();
    cachedAt = t;
    return cached;
  }

  function inspectResponses() {
    if (policy.watchResponses === false || policy.mode === 'off') return;
    // Not forced. A pass chained 60 ms behind the last one is reading text
    // that has grown by perhaps twenty characters, and `growthFrom` never
    // advances past what was actually read, so anything the stale read missed
    // is still ahead of the mark for the next pass.
    const body = pageText(false);
    if (body.length < 40) return;

    // A shorter page means a new conversation, or virtual scrolling recycling
    // what was there. Either way the marks no longer refer to this text.
    //
    // What does *not* follow is that the dedupe set should be emptied. It is
    // keyed on a finding's value and the text around it, so keeping it is what
    // stops a page that wobbles in length — a "stop generating" button coming
    // and going is enough — from announcing the same key over and over. Only a
    // page that has lost most of its text is a different conversation, and
    // only then is announcing the same key again the right thing to do.
    if (body.length < growthFrom) {
      if (body.length < growthFrom / 2) seenResponses.clear();
      resetMarks();
    }

    if (growthFrom < 0) {
      growthFrom = Math.max(0, body.length - PASS_BYTES);
      waterline = growthFrom;
      historyFrom = waterline;
      historyFloor = Math.max(0, waterline - MAX_HISTORY_BYTES);
      queueHistory();
    }

    // Forward through whatever arrived, in slices, for as long as one pass is
    // allowed to hold the thread. Only the mark advances, so a reply that grew
    // faster than the budget is finished by the next slice rather than skipped.
    const until = Date.now() + SLICE_BUDGET_MS;
    while (growthFrom < body.length) {
      const from = Math.max(0, growthFrom - RESCAN_OVERLAP);
      const to = Math.min(body.length, from + PASS_BYTES);
      if (to <= growthFrom) break;
      growthFrom = to;
      examine(body.slice(from, to));
      if (Date.now() >= until) break;
    }
    if (growthFrom < body.length) schedulePass(60);
  }

  /**
   * The transcript that was already on screen.
   *
   * Newest first, because a credential in the reply above the one that just
   * arrived is worth saying and one from two weeks ago is not news. Idle
   * work, one slice at a time, because it was there before the page finished
   * loading and so has no claim on a frame the person is using.
   *
   * It still gets read, within the budget, because a credential in a reply
   * from yesterday is in the history being sent back to the model today.
   */
  let historyText = null;      // one snapshot for the whole walk

  /**
   * A budget in milliseconds, not only in characters.
   *
   * 120,000 characters is a fixed amount of work and therefore a variable
   * amount of time: free on a desktop, and on a 1500-turn thread at 4x
   * throttle it put 92 ms of blocking into five seconds of a page doing
   * nothing. A byte budget decides how much is read; a CPU budget decides
   * what that is allowed to cost, and only the second one holds on a machine
   * nobody has measured. Whatever is not reached stays unread, and
   * `unreadHistory()` reports it rather than the budget's floor.
   */
  const HISTORY_CPU_MS = 400;
  let historySpent = 0;

  /**
   * Forget where we were.
   *
   * All five pieces of state, because four of them were a bug: an earlier
   * version reset the scan mark and left the history walk's cursor, its
   * snapshot, its spent budget and its outstanding idle callback alone. A
   * profile that had already spent its 400 ms on one conversation would then
   * never read the history of the next one, and the pending callback made
   * `queueHistory()` return immediately for the rest of the page's life.
   */
  function resetMarks() {
    growthFrom = -1;
    historyFrom = 0;
    historyFloor = 0;
    historyText = null;
    historySpent = 0;
    if (historyHandle !== null) {
      try {
        if (typeof cancelIdleCallback === 'function') cancelIdleCallback(historyHandle);
        else clearTimeout(historyHandle);
      } catch { /* already run */ }
      historyHandle = null;
    }
  }

  function queueHistory() {
    if (historyHandle !== null || historyFrom <= historyFloor) return;
    if (historySpent >= HISTORY_CPU_MS) return;
    const run = () => {
      historyHandle = null;
      if (policy.watchResponses === false || policy.mode === 'off') { historyText = null; return; }
      const t0 = performance.now();
      if (historyText === null) historyText = pageText(false);
      const body = historyText;
      if (body.length < waterline) { historyText = null; return; }   // the page changed under us
      const to = historyFrom;
      const from = Math.max(historyFloor, to - PASS_BYTES);
      if (to <= from) { historyText = null; return; }
      historyFrom = from;
      try {
        examine(body.slice(from, Math.min(body.length, to + RESCAN_OVERLAP)));
      } catch { /* keep going */ }
      historySpent += performance.now() - t0;
      if (historyFrom <= historyFloor || historySpent >= HISTORY_CPU_MS) { historyText = null; return; }
      queueHistory();
    };
    // No `timeout`. An idle callback with one is not idle work: it fires
    // whether or not there is a spare frame, which is how the first version
    // of this walk put 290 ms of blocking into five seconds of a page doing
    // nothing. Without one, a page too busy to spare a frame simply has not
    // read its history yet, and `unreadHistory()` reports exactly that.
    historyHandle = typeof requestIdleCallback === 'function'
      ? requestIdleCallback(run)
      : setTimeout(run, 300);
  }

  /**
   * What a reply is worth mentioning for.
   *
   * This was `critical` only, and the rule table says why that was too narrow.
   * A Slack incoming webhook is `high`. So is a SendGrid key, a Twilio key, a
   * Notion token, a Grafana token, an IBAN — twenty-one shapes that are
   * unmistakably live credentials, every one of which the model could echo
   * back into a conversation, and about every one of which Chhanni said
   * nothing at all. "Critical" is a severity ranking for the person's own
   * outgoing message; it was never a definition of what matters in a reply.
   *
   * Three exclusions, each for a reason rather than for tidiness:
   *
   *   advisory      the ten context detectors — a negotiating position, a
   *                 legal hold, a customer list — are judgements about
   *                 sensitivity, not matches. An assistant discussing a
   *                 negotiation would trip one every time.
   *   generic       `jwt` and `bearer_header` match a shape, not a vendor. A
   *                 reply explaining how JWTs work contains JWTs.
   *   prose         a postal address in an answer is usually the answer.
   *
   *   confidence `possible` is excluded too: for text the person did not
   *   write, a maybe is not worth interrupting them for.
   *
   * The same set tells the engine what not to compute. The findings this
   * filter discards were being produced on every pass and thrown away.
   */
  const REPLY_RULES = new Set((RULES || []).filter((r) => {
    if (r.synthetic || r.advisory) return false;
    if (r.severity === 'critical') return true;        // includes prompt_injection
    if (r.severity !== 'high') return false;
    if (r.category === 'generic' || r.category === 'prose') return false;
    return r.confidence !== 'possible';
  }).map((r) => r.id));
  const REPLY_DISABLED = (RULES || []).filter((r) => !REPLY_RULES.has(r.id)).map((r) => r.id);

  /** Scan one window of page text and say something if it matters. */
  function examine(chunk) {
    let result;
    const off = Array.isArray(policy.disabled) ? policy.disabled : [];
    try {
      result = scan(chunk, {
        ...policy, ner: false, tables: false, disabled: [...off, ...REPLY_DISABLED],
      });
    } catch { return; }

    const worth = result.findings.filter((f) => !f.advisory && REPLY_RULES.has(f.ruleId));
    if (!worth.length) return;

    /**
     * What makes two findings the same event.
     *
     * Keying on the fingerprints alone meant the same secret in two genuinely
     * different replies was one event, and the second was silently dropped —
     * which is the wrong way round for a tool whose entire job is to say when
     * something sensitive has appeared. A finding is identified by its value
     * *and* the text it sits in, so a re-render of the same reply is quiet and
     * a second reply carrying the same key is not.
     */
    const context = (f) => chunk
      .slice(Math.max(0, f.start - 30), f.start + (f.end - f.start) + 30)
      .replace(/\s+/g, ' ').trim();
    const key = worth.map((f) => `${f.fingerprint}@${context(f)}`).sort().join('|');
    if (seenResponses.has(key)) return;
    // Oldest out, rather than wiping the lot: clearing meant the first
    // sixty-four findings all notified a second time.
    seenResponses.add(key);
    if (seenResponses.size > 64) seenResponses.delete(seenResponses.values().next().value);

    const injection = worth.find((f) => f.ruleId === 'prompt_injection');
    if (injection) {
      showNotice('The reply on this page contains instructions aimed at an assistant. If you forward it, they travel with it.', 'reply');
    } else {
      const labels = [...new Set(worth.map((f) => f.label))].join(', ');
      showNotice(`The reply contains ${labels}. It is now in this conversation’s history.`, 'reply');
    }
  }

  const observer = new MutationObserver(() => schedulePass());
  try {
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    // A page that is already long when we arrive has a transcript nobody has
    // read. Without this, a thread opened fresh and left alone is never
    // scanned at all, because nothing mutates.
    schedulePass(DEBOUNCE_MS);
  } catch { /* no body yet; the page is not a chat */ }

  /**
   * What the popup is allowed to say about this tab.
   *
   * The popup can report which sites are watched from the manifest, which is
   * a fact about configuration. It cannot see whether the scanner actually
   * managed to read this page, which is a fact about this tab — and that is
   * the one a person needs, because the honest answer is sometimes "only
   * partly". Answered by the top frame only; a subframe replying too would
   * make the result a race.
   */
  if (window === window.top) {
    try {
      chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
        if (!msg || msg.type !== 'chhanni:page-state') return undefined;
        reply({
          engine: engineState,
          watchingResponses: policy?.watchResponses !== false && policy?.mode !== 'off',
          sweepLimit,
          // Characters of transcript above the history budget. Not a
          // performance statistic: it is the part of this conversation
          // Chhanni has not read and is not going to.
          historyUnread: unreadHistory(),
          // True while an administrator's policy has not been read yet, so
          // what is running is the person's own settings.
          policyPending,
        });
        return true;
      });
    } catch { /* no runtime messaging in this context */ }
  }

  // ----------------------------------------------------------- intercept
  document.addEventListener('paste', (e) => {
    const target = eventTarget(e);
    if (!isEditable(target) || policy.mode === 'off') return;

    // ── a clipboard can carry a file, and a screenshot is the commonest one ──
    //
    // This read `getData('text/plain')` and returned when it was empty, which
    // is exactly what an image clipboard produces. Measured: a pasted PNG
    // reached the page as an attachment with no panel, no coverage line and no
    // mention. Meanwhile the drop and file-picker paths already knew how to
    // inspect an image. The clipboard was simply a third door into the same
    // room, and nobody was watching it.
    const pasted = [...(e.clipboardData?.files || [])];
    if (pasted.length) {
      if (approvedFiles('paste-files', pasted)) return;
      e.preventDefault();
      e.stopPropagation();
      guardFiles(pasted, {
        onAllow: (allowed) => {
          // A synthetic ClipboardEvent cannot carry clipboardData in Chromium —
          // verified, it comes back null — so the paste cannot simply be
          // replayed. Hand the files over as a drop, which every composer that
          // accepts a pasted image also accepts, and keep a one-shot approval
          // so that pressing Ctrl+V again works if this page does not.
          approveFiles('paste-files', allowed);
          try {
            target.dispatchEvent(new DragEvent('drop', {
              dataTransfer: fileListFrom(allowed), bubbles: true, cancelable: true,
            }));
          } catch { /* the approval above is the fallback */ }
        },
        onCancel: () => {},
      });
      return;
    }

    const text = e.clipboardData?.getData('text/plain');
    if (!text) return;

    // ── what the composer keeps is not always what text/plain shows ──
    //
    // Chromium's paste sanitiser drops a display:none span, so that vector is
    // not real. An href and an alt attribute both survive, and neither appears
    // in text/plain or in innerText — measured: a pasted link carrying a key
    // in its query string landed in a contenteditable composer with nothing to
    // see at either interception point. Products that serialise the composer
    // to Markdown then send the URL.
    //
    // So the HTML flavour is scanned too, as *extra* text rather than instead:
    // the plain text is what the person sees and must still be reported
    // normally, and the attributes are the part nobody can see.
    let hidden = '';
    try {
      const html = e.clipboardData?.getData('text/html') || '';
      if (html && html.length < 1_000_000) {
        const attrs = [];
        const re = /\s(?:href|src|alt|title|data-[\w-]+)\s*=\s*("[^"]*"|'[^']*')/gi;
        let m;
        while ((m = re.exec(html)) !== null && attrs.length < 500) {
          attrs.push(m[1].slice(1, -1));
        }
        const extra = attrs.join('\n');
        // Only the part that is not already visible in the plain text.
        if (extra && !text.includes(extra)) hidden = extra;
      }
    } catch { /* no HTML flavour on this clipboard */ }

    const insert = (value) => {
      if (target.tagName === 'TEXTAREA') {
        const start = target.selectionStart ?? target.value.length;
        const end = target.selectionEnd ?? start;
        writeComposer(target, target.value.slice(0, start) + value + target.value.slice(end));
      } else {
        target.focus();
        document.execCommand('insertText', false, value);
      }
    };

    const scanned = safeScan(hidden ? `${text}\n${hidden}` : text);
    if (!scanned.ok) {
      e.preventDefault();
      e.stopPropagation();
      showCannotInspect({
        what: 'This paste was held, not checked.',
        detail: `The scanner failed on this text: ${String(scanned.err?.message || scanned.err).slice(0, 160)}`,
        onProceed: () => insert(text),
      });
      return;
    }

    const result = scanned.result;
    if (result.verdict === 'clean') { markClean(result); return; }

    e.preventDefault();
    e.stopPropagation();

    showPanel({
      result,
      title: headline(result, 'in what you pasted'),
      coverage: scanCoverage(result, 'What you pasted'),
      destination: location.hostname,
      sendText: text,
      // Findings located in the hidden attributes have offsets past the end of
      // the visible text; redacting against `text` would corrupt it. Replace
      // within the visible part, and drop the markup entirely when the only
      // problem was in an attribute — pasting the plain text is the fix.
      onRedact: () => insert(redact(text, result.findings.filter((f) => f.end <= text.length)).text),
      onPseudonymise: () => insert(pseudonymise(text, result.findings.filter((f) => f.end <= text.length)).text),
      onProceed: () => insert(text),
    });
  }, true);

  const isSubmitKey = (e) => e.key === 'Enter' && !e.shiftKey && !e.isComposing && !e.altKey;


  // ═══════════════════════════════════════════════════════════ attachments
  //
  // The documented biggest gap in every tool of this kind: people do not only
  // paste secrets, they attach them. A dragged .env or a downloaded
  // credentials.json never touches the composer, so a composer-only scanner
  // sees nothing.
  //
  // Text-like attachments are read locally, scanned with the same engine, and —
  // this is the part no other tool offers — can be replaced in place by a
  // redacted copy that still carries everything the model needs to help.

  const MAX_FILE = 16 * 1024 * 1024;
  const mb = (n) => `${(n / 1048576).toFixed(n < 10485760 ? 1 : 0)} MB`;

  const nothingFound = () => ({
    findings: [], groups: [], advisories: [], table: null,
    regimeNames: [], verdict: 'clean', counts: {},
  });

  /**
   * Reads every attachment as bytes and extracts whatever text it holds.
   *
   * Routing is by magic number, not by extension. A `.txt` that is really a
   * ZIP and a `.jpg` that is really a PDF are exactly the cases where being
   * wrong matters, and an extension is only a claim the file makes about
   * itself.
   */
  async function inspect(files) {
    const reports = [];
    for (const file of files) {
      if (file.size > MAX_FILE) {
        reports.push({
          file, ...nothingFound(), status: 'opaque', kind: 'oversize', text: '',
          reason: `${mb(file.size)} is past the ${mb(MAX_FILE)} Chhanni will read inside a page, so this file was not inspected at all.`,
        });
        continue;
      }
      let bytes;
      try { bytes = new Uint8Array(await file.arrayBuffer()); } catch {
        reports.push({
          file, ...nothingFound(), status: 'opaque', kind: 'unreadable', text: '',
          reason: 'The browser would not hand this file over, so it was not inspected.',
        });
        continue;
      }
      let doc;
      try { doc = await extractDocument(bytes, file.name); } catch {
        doc = { status: 'opaque', kind: 'unreadable', text: '',
                reason: 'This file could not be parsed, so it was not inspected.' };
      }
      const result = doc.text ? scan(doc.text, scanPolicy()) : nothingFound();
      reports.push({
        file, bytes, ...result,
        text: doc.text || '', status: doc.status, kind: doc.kind,
        note: doc.note || null, reason: doc.reason || null,
        strippable: doc.strippable || false, doc,
      });
    }
    return reports;
  }

  /** Same file, rewritten as honestly as its format allows. */
  function redactedCopy(report) {
    if (!report.bytes) return report.file;
    const plan = rewriteMode(report.doc);
    if (plan.mode === 'none') return report.file;
    // Nothing found and nothing to strip: hand back exactly what was given.
    if (plan.mode !== 'strip' && !report.findings.length) return report.file;

    const cleaned = report.text ? redact(report.text, report.findings).text : '';
    const out = rewriteBytes(report.bytes, report.doc, cleaned);
    if (!out) return report.file;
    const name = out.name(report.file.name);
    const type = plan.mode === 'convert' ? 'text/plain'
      : (report.file.type || (plan.mode === 'text' ? 'text/plain' : ''));
    return new File([out.bytes], name, { type, lastModified: report.file.lastModified });
  }

  /** One line per file that was not fully read, naming the file and the reason. */
  function coverageLines(reports) {
    const out = [];
    for (const r of reports) {
      if (r.status === 'readable') continue;
      const detail = [r.note, r.reason].filter(Boolean).join(' ');
      out.push(detail ? `${r.file.name} \u2014 ${detail}` : r.file.name);
    }
    // A single attachment can also be too large to read whole.
    for (const r of reports) out.push(...scanCoverage(r, r.file.name));
    return out;
  }

  /** One line per file the redact button will change, saying how. */
  function planLines(reports) {
    const out = [];
    for (const r of reports) {
      const plan = rewriteMode(r.doc);
      if (plan.mode === 'strip') {
        out.push(`${r.file.name} \u2014 ${plan.explain}`);
      } else if (r.findings.length && (plan.mode === 'convert' || plan.mode === 'none')) {
        out.push(`${r.file.name} \u2014 ${plan.explain}`);
      }
    }
    return out;
  }

  function fileListFrom(files) {
    const dt = new DataTransfer();
    for (const f of files) dt.items.add(f);
    return dt;
  }

  /** Shared flow for drop, file-input selection and a pasted image. */
  async function guardFiles(files, { onAllow, onCancel }) {
    let reports;
    try {
      reports = await inspect(files);
    } catch (err) {
      // This used to be `catch { onAllow(files); return; }` — an inspection
      // that crashed handed the files straight on, silently. The whole point
      // of the four-status model is that "could not read" is an outcome the
      // user gets to see, and that has to hold when the failure is ours.
      showCannotInspect({
        what: files.length === 1 ? files[0].name : `${files.length} files were held, not checked.`,
        detail: `Inspection failed: ${String(err?.message || err).slice(0, 160)}`,
        onProceed: () => onAllow(files),
        onCancel,
      });
      return;
    }

    const all = reports.flatMap((r) => r.findings);
    const coverage = coverageLines(reports);
    const strippable = reports.filter((r) => rewriteMode(r.doc).mode === 'strip');

    // Nothing found, but something could not be read: say so rather than
    // letting silence imply the file was checked.
    //
    // In strict mode a notice is not enough. "Everything found" reads as a
    // promise about findings, and an artifact nobody could open has none by
    // definition — measured: a 20 MB opaque binary was accepted in strict mode
    // with a toast. The mode that calls itself safest is the one where "I could
    // not look at this" has to be a decision rather than a notification.
    if (!all.length && !strippable.length) {
      if (coverage.length && policy.mode === 'strict') {
        showCannotInspect({
          what: files.length === 1 ? files[0].name : `${files.length} files`,
          detail: coverage.length === 1 ? coverage[0]
            : `${coverage.length} of these could not be read: ${coverage.slice(0, 3).join('; ')}`,
          onProceed: () => onAllow(files),
          onCancel,
        });
        return;
      }
      if (coverage.length && policy.mode !== 'off') {
        showNotice(coverage.length === 1
          ? coverage[0]
          : `Chhanni could not read ${coverage.length} of these files. Check them yourself before sending.`,
        'coverage');
      }
      onAllow(files);
      return;
    }

    const dirty = reports.filter((r) => r.findings.length);
    const names = dirty.map((r) => r.file.name).join(', ');

    // Merge the per-file scans into one result the panel can render.
    const merged = {
      findings: all,
      groups: groupFindings(all),
      verdict: all.some((f) => f.severity === 'critical') ? 'block' : 'warn',
      risk: exposureScore(all, reports.find((r) => r.table)?.table || null),
      table: reports.find((r) => r.table)?.table || null,
      regimeNames: [...new Set(reports.flatMap((r) => r.regimeNames || []))],
    };
    merged.band = BAND_TEXT[merged.risk.band];

    // When nothing was readable and the only problem is metadata, this is not
    // a warning, it is a one-click fix — so the button says what it does. A
    // photograph's EXIF still produces findings (an Artist field is a person's
    // name), which is why this tests where the text came from rather than
    // whether there was any.
    const metadataOnly = strippable.length > 0 && reports.every((r) => r.status !== 'readable');
    // The score band reads "nothing worth stopping for" at this level, which
    // contradicts a panel that is, visibly, stopping. When the reason we are
    // here is metadata, say that instead.
    if (metadataOnly) merged.band = 'An image carries more than its picture.';
    const title = metadataOnly
      ? `${strippable.length === 1 ? strippable[0].file.name : `${strippable.length} images`} carr${strippable.length === 1 ? 'ies' : 'y'} metadata`
      : all.length === 1
        ? `${all[0].label} in ${names}`
        : `${all.length} things in ${dirty.length === 1 ? names : `${dirty.length} attached files`}`;

    showPanel({
      result: merged,
      title,
      redactLabel: metadataOnly
        ? 'Remove the metadata and attach'
        : `Attach redacted ${dirty.length === 1 && !strippable.length ? 'copy' : 'copies'}`,
      proceedLabel: 'Attach as-is',
      coverage,
      plan: planLines(reports),
      onRedact: () => onAllow(reports.map(redactedCopy)),
      onProceed: () => onAllow(files),
      onDismiss: onCancel,
    });
  }

  document.addEventListener('drop', (e) => {
    if (policy.mode === 'off') return;
    const files = [...(e.dataTransfer?.files || [])];
    if (!files.length) return;
    if (approvedFiles('drop', files)) return;

    const target = eventTarget(e);
    e.preventDefault();
    e.stopPropagation();

    guardFiles(files, {
      onAllow: (allowed) => {
        approveFiles('drop', allowed);
        target.dispatchEvent(new DragEvent('drop', {
          dataTransfer: fileListFrom(allowed), bubbles: true, cancelable: true,
        }));
      },
      onCancel: () => {},
    });
  }, true);

  document.addEventListener('change', (e) => {
    const input = eventTarget(e);
    if (policy.mode === 'off') return;
    if (!(input instanceof HTMLInputElement) || input.type !== 'file') return;
    const files = [...(input.files || [])];
    if (!files.length) return;
    if (approvedFiles('pick', files)) return;

    e.stopPropagation();
    // Detach the selection while we look at it, so nothing uploads underneath us.
    input.files = fileListFrom([]).files;

    guardFiles(files, {
      onAllow: (allowed) => {
        approveFiles('pick', allowed);
        input.files = fileListFrom(allowed).files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      },
      onCancel: () => { input.value = ''; },
    });
  }, true);

  // ══════════════════════════════════════════════════════ sending a message
  //
  // There are three ways a person sends what they have typed, and until now
  // exactly one of them was watched.
  //
  //   Enter          guarded
  //   click Send     not guarded  — measured: the key went straight through
  //   submit a form  not guarded  — measured: the key went straight through
  //
  // Enter is the one a developer tests with. It is not the one most people
  // use, and on a touch device it does not exist at all. So the decision now
  // lives in one function and all three paths call it, which is also the only
  // way to be sure they cannot drift apart again.

  /**
   * @param {Event} e            the event to cancel if we stop
   * @param {Element} target     the composer being sent
   * @param {() => void} resend  replays the original action after approval
   * @param {string} via         names the path, so an approval for one is not an approval for another
   */
  function guardSubmission(e, target, resend, via) {
    if (panel) { e.preventDefault(); e.stopImmediatePropagation(); return; }
    const text = readComposer(target);
    if (!text || !text.trim()) return;

    // Bound to this text, on this path. "Send as-is" used to open a two-second
    // window in which any Enter went through unchecked — measured with a
    // completely different secret, which left with no panel.
    if (approvedSend(via, text, target)) return;

    const scanned = safeScan(text);
    if (!scanned.ok) {
      e.preventDefault();
      e.stopImmediatePropagation();
      showCannotInspect({
        what: 'This message was held, not checked.',
        detail: `The scanner failed on it: ${String(scanned.err?.message || scanned.err).slice(0, 160)}`,
        onProceed: () => { approveSend(via, text, target); resend(); },
      });
      return;
    }

    const result = scanned.result;
    if (result.verdict === 'clean') { markClean(result); return; }
    // In warn mode only things that can actually be abused stop the send.
    if (policy.mode === 'warn' && result.verdict !== 'block') return;

    e.preventDefault();
    e.stopImmediatePropagation();

    showPanel({
      result,
      title: headline(result, 'about to be sent'),
      coverage: scanCoverage(result, 'This message'),
      destination: location.hostname,
      sendText: text,
      onRedact: () => writeComposer(target, redact(text, result.findings).text),
      onPseudonymise: () => writeComposer(target, pseudonymise(text, result.findings).text),
      onProceed: () => { approveSend(via, text, target); resend(); },
    });
  }

  document.addEventListener('keydown', (e) => {
    if (!isSubmitKey(e) || policy.mode === 'off') return;
    const target = eventTarget(e);
    if (!isEditable(target)) return;
    guardSubmission(e, target, () => {
      target.focus();
      target.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true,
      }));
    }, 'enter');
  }, true);

  /** The composer this send control belongs to, if any. */
  function composerFor(control) {
    const roots = [];
    const form = control.closest('form');
    if (form) roots.push(form);
    if (control.parentElement?.parentElement) roots.push(control.parentElement.parentElement);
    const host = control.getRootNode?.();
    if (host && host !== document) roots.push(host);
    roots.push(document);
    for (const root of roots) {
      let candidates;
      try { candidates = root.querySelectorAll(EDITABLE); } catch { continue; }
      for (const el of candidates) {
        try {
          if (isEditable(el) && readComposer(el).trim()) return el;
        } catch { /* detached */ }
      }
    }
    return null;
  }

  document.addEventListener('click', (e) => {
    // Deliberately not gated on e.isTrusted. A page — or an agent driving it —
    // calling .click() on the send button is a real way for content to leave,
    // and measured: a synthetic submit went straight through. The one-shot,
    // content-bound approval is what stops our own replay from looping, which
    // is a tighter guarantee than trusting the event's provenance.
    if (policy.mode === 'off') return;
    const hit = eventTarget(e);
    if (!hit || !hit.closest) return;
    // Never act on our own surface.
    if (hit.closest('.chhanni-panel, .chhanni-notice')) return;
    let control;
    try { control = hit.closest(SEND_SELECTOR); } catch { return; }
    if (!control || !isSendControl(control)) return;
    const target = composerFor(control);
    if (!target) return;
    guardSubmission(e, target, () => { try { control.click(); } catch { /* detached */ } }, 'click');
  }, true);

  document.addEventListener('submit', (e) => {
    if (policy.mode === 'off') return;
    const form = eventTarget(e)?.closest?.('form') || e.target;
    if (!form || form.tagName !== 'FORM') return;
    const target = composerFor(form);
    if (!target) return;
    guardSubmission(e, target, () => {
      try { if (typeof form.requestSubmit === 'function') form.requestSubmit(); else form.submit(); }
      catch { /* detached */ }
    }, 'submit');
  }, true);
})();
