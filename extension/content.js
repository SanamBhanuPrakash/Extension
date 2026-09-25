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
  const { scan, groupFindings } = await import(url('engine/detect.js'));
  const { exposureScore, BAND_TEXT } = await import(url('engine/risk.js'));
  const { isComposer } = await import(url('engine/composer.js'));
  const { mergePolicy } = await import(url('engine/managed.js'));
  const { redact } = await import(url('engine/redact.js'));
  const store = await import(url('store.js'));

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

  /**
   * User settings, with any organisation policy merged over them.
   * `storage.managed` is populated by the browser from enterprise policy —
   * GPO, a macOS profile, Chrome Enterprise, Firefox policies.json. It is a
   * local read; no request leaves the machine.
   */
  async function loadPolicy() {
    let user = DEFAULTS;
    try {
      const stored = await chrome.storage.sync.get('policy');
      if (stored.policy) user = { ...DEFAULTS, ...stored.policy };
    } catch { /* first run; defaults are fine */ }
    let managed = null;
    try { managed = (await chrome.storage.managed.get(null)) || null; } catch { /* unmanaged */ }
    policy = mergePolicy(user, managed && Object.keys(managed).length ? managed : null);
  }
  await loadPolicy();
  chrome.storage.onChanged?.addListener(() => { loadPolicy().catch(() => {}); });

  // ------------------------------------------------------------- composer
  //
  // Identified by shape rather than by a hostname list. A new AI product ships
  // every week and a hand-maintained list is always behind — worse, the gap is
  // invisible, because the extension looks installed while watching nothing.
  const isEditable = (el) => {
    if (!el || (el.tagName !== 'TEXTAREA' && !el.isContentEditable)) return false;
    try { return isComposer(el); } catch { return true; }
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
  function showPanel({ result, title, onRedact, onProceed, onDismiss,
                       redactLabel, proceedLabel, unread }) {
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
      regs.appendChild(el('h3', null, 'Regulated under'));
      const chips = el('div', 'chhanni-chips');
      for (const name of regimeNames.slice(0, 5)) chips.appendChild(el('span', 'chhanni-chip', name));
      regs.appendChild(chips);
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
        row.appendChild(label);
        // Advisory findings are context, not secrets, so there is nothing to mask.
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
    if (unread && unread.length) {
      panel.appendChild(el('div', 'chhanni-also',
        `Not inspected: ${unread.join(', ')}. Images, PDFs and documents are not read.`));
    }

    // ── actions ─────────────────────────────────────────────────────
    const redactable = findings.filter((f) => !f.advisory).length;
    const actions = el('div', 'chhanni-actions');
    const redactBtn = el('button', 'chhanni-primary',
      redactLabel || (redactable
        ? `Redact ${redactable} and continue`
        : 'I understand, continue'));
    redactBtn.onclick = () => { closePanel(); record('redacted'); onRedact(); };
    const proceedBtn = el('button', 'chhanni-ghost', proceedLabel || 'Send as-is');
    proceedBtn.onclick = () => { closePanel(); record('sent'); onProceed(); };
    actions.append(redactBtn, proceedBtn);
    panel.appendChild(actions);

    const hint = el('div', 'chhanni-hint');
    hint.append(el('kbd', null, 'Enter'),
      document.createTextNode(redactable ? ' redact  \u00b7  ' : ' continue  \u00b7  '),
      el('kbd', null, 'Esc'), document.createTextNode(' back to editing'));
    panel.appendChild(hint);

    panel.appendChild(el('div', 'chhanni-foot',
      'Checked on this device. Nothing was sent anywhere.'));

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

  function showNotice(message) {
    clearTimeout(noticeTimer);
    noticeEl?.remove();
    noticeEl = el('div', 'chhanni-notice');
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

  const seenResponses = new Set();
  let responseTimer = null;

  function inspectResponses() {
    if (policy.watchResponses === false || policy.mode === 'off') return;
    // Only the most recent stretch of the page: an assistant reply is appended
    // at the end, and re-reading the whole transcript on every mutation would
    // be both slow and noisy.
    const body = document.body?.innerText || '';
    if (body.length < 40) return;
    const tail = body.slice(-12000);

    let result;
    try { result = scan(tail, { ...policy, ner: false, tables: false }); } catch { return; }

    const worth = result.findings.filter((f) =>
      f.ruleId === 'prompt_injection' || (!f.advisory && f.severity === 'critical'));
    if (!worth.length) return;

    // Fingerprints, so the same reply is not reported on every mutation.
    const key = worth.map((f) => f.fingerprint).sort().join('|');
    if (seenResponses.has(key)) return;
    seenResponses.add(key);
    if (seenResponses.size > 64) seenResponses.clear();

    const injection = worth.find((f) => f.ruleId === 'prompt_injection');
    if (injection) {
      showNotice('The reply on this page contains instructions aimed at an assistant. If you forward it, they travel with it.');
    } else {
      const labels = [...new Set(worth.map((f) => f.label))].join(', ');
      showNotice(`The reply contains ${labels}. It is now in this conversation\u2019s history.`);
    }
  }

  const observer = new MutationObserver(() => {
    clearTimeout(responseTimer);
    // Debounced well past a streaming response's cadence, so this runs once
    // when the reply settles rather than on every token.
    responseTimer = setTimeout(inspectResponses, 1200);
  });
  try {
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  } catch { /* no body yet; the page is not a chat */ }

  // ----------------------------------------------------------- intercept
  document.addEventListener('paste', (e) => {
    const target = e.target;
    if (!isEditable(target) || policy.mode === 'off') return;
    const text = e.clipboardData?.getData('text/plain');
    if (!text) return;

    const result = scan(text, policy);
    if (result.verdict === 'clean') return;

    e.preventDefault();
    e.stopPropagation();

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

    showPanel({
      result,
      title: headline(result, 'in what you pasted'),
      onRedact: () => insert(redact(text, result.findings).text),
      onProceed: () => insert(text),
    });
  }, true);

  const isSubmitKey = (e) => e.key === 'Enter' && !e.shiftKey && !e.isComposing && !e.altKey;

  // After "Send as-is" we re-dispatch the key; this stops us catching our own.
  let bypassUntil = 0;


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

  const TEXTUAL = /\.(?:env|json|ya?ml|txt|md|log|csv|tsv|sql|sh|bash|zsh|fish|conf|cfg|ini|toml|properties|pem|key|crt|cer|xml|html?|jsx?|tsx?|mjs|cjs|py|rb|go|java|php|rs|c|cc|cpp|h|hpp|cs|swift|kt|scala|pl|lua|r|tf|tfvars|tfstate|gradle|dockerfile|gitconfig|npmrc|netrc|pgpass|htpasswd)$/i;
  const MAX_FILE = 4 * 1024 * 1024;

  const isTextual = (file) =>
    file.size <= MAX_FILE &&
    (TEXTUAL.test(file.name) ||
     /^text\//.test(file.type) ||
     /^application\/(?:json|xml|x-yaml|x-sh|javascript|x-pem-file)/.test(file.type) ||
     (file.type === '' && !/\.(?:png|jpe?g|gif|webp|avif|pdf|zip|gz|tar|mp[34]|mov|docx?|xlsx?|pptx?)$/i.test(file.name)));

  /** Reads and scans each text-like file. Binary and oversized files are skipped. */
  async function inspect(files) {
    const reports = [];
    for (const file of files) {
      if (!isTextual(file)) { reports.push({ file, skipped: true, findings: [] }); continue; }
      let text;
      try { text = await file.text(); } catch { reports.push({ file, skipped: true, findings: [] }); continue; }
      if (text.includes('\u0000')) { reports.push({ file, skipped: true, findings: [] }); continue; }
      const result = scan(text, policy);
      reports.push({ file, text, ...result });
    }
    return reports;
  }

  /** Same name, same type, secrets replaced with stable placeholders. */
  function redactedCopy(report) {
    if (!report.findings.length || report.skipped) return report.file;
    const cleaned = redact(report.text, report.findings).text;
    return new File([cleaned], report.file.name, {
      type: report.file.type || 'text/plain',
      lastModified: report.file.lastModified,
    });
  }

  function fileListFrom(files) {
    const dt = new DataTransfer();
    for (const f of files) dt.items.add(f);
    return dt;
  }

  let fileBypassUntil = 0;

  /** Shared flow for both drop and file-input selection. */
  async function guardFiles(files, { onAllow, onCancel }) {
    const reports = await inspect(files);
    const all = reports.flatMap((r) => r.findings);
    const unreadable = reports.filter((r) => r.skipped);

    // Nothing found, but something could not be read: say so rather than
    // letting silence imply the file was checked. A screenshot of a dashboard
    // is a common leak and this extension cannot see inside it.
    if (!all.length) {
      if (unreadable.length && policy.mode !== 'off') {
        showNotice(`Chhanni cannot read ${unreadable.length === 1
          ? unreadable[0].file.name
          : `${unreadable.length} of these files`} \u2014 images, PDFs and documents are not inspected. Check it yourself before sending.`);
      }
      onAllow(files);
      return;
    }

    const dirty = reports.filter((r) => r.findings.length);
    const names = dirty.map((r) => r.file.name).join(', ');
    const unread = reports.filter((r) => r.skipped).map((r) => r.file.name);

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

    showPanel({
      result: merged,
      title: all.length === 1
        ? `${all[0].label} in ${names}`
        : `${all.length} things in ${dirty.length === 1 ? names : `${dirty.length} attached files`}`,
      redactLabel: `Attach redacted ${dirty.length === 1 ? 'copy' : 'copies'}`,
      proceedLabel: 'Attach as-is',
      unread,
      onRedact: () => onAllow(reports.map(redactedCopy)),
      onProceed: () => onAllow(files),
      onDismiss: onCancel,
    });
  }

  document.addEventListener('drop', (e) => {
    if (policy.mode === 'off' || Date.now() < fileBypassUntil) return;
    const files = [...(e.dataTransfer?.files || [])];
    if (!files.length) return;

    const target = e.target;
    e.preventDefault();
    e.stopPropagation();

    guardFiles(files, {
      onAllow: (allowed) => {
        fileBypassUntil = Date.now() + 2000;
        target.dispatchEvent(new DragEvent('drop', {
          dataTransfer: fileListFrom(allowed), bubbles: true, cancelable: true,
        }));
      },
      onCancel: () => {},
    });
  }, true);

  document.addEventListener('change', (e) => {
    const input = e.target;
    if (policy.mode === 'off' || Date.now() < fileBypassUntil) return;
    if (!(input instanceof HTMLInputElement) || input.type !== 'file') return;
    const files = [...(input.files || [])];
    if (!files.length) return;

    e.stopPropagation();
    // Detach the selection while we look at it, so nothing uploads underneath us.
    input.files = fileListFrom([]).files;

    guardFiles(files, {
      onAllow: (allowed) => {
        fileBypassUntil = Date.now() + 2000;
        input.files = fileListFrom(allowed).files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      },
      onCancel: () => { input.value = ''; },
    });
  }, true);

  document.addEventListener('keydown', (e) => {
    if (!isSubmitKey(e) || policy.mode === 'off' || Date.now() < bypassUntil) return;
    if (panel) return; // the panel owns Enter while it is open
    const target = e.target;
    if (!isEditable(target)) return;

    const result = scan(readComposer(target), policy);
    if (result.verdict === 'clean') return;
    // In warn mode only things that can actually be abused stop the send.
    if (policy.mode === 'warn' && result.verdict !== 'block') return;

    e.preventDefault();
    e.stopImmediatePropagation();
    const text = readComposer(target);

    showPanel({
      result,
      title: headline(result, 'about to be sent'),
      onRedact: () => writeComposer(target, redact(text, result.findings).text),
      onProceed: () => {
        bypassUntil = Date.now() + 2000;
        target.focus();
        target.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true,
        }));
      },
    });
  }, true);
})();
