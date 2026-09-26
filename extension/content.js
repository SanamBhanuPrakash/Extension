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
  const { extractDocument, rewriteMode, rewriteBytes, describeKind } =
    await import(url('engine/documents.js'));
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
                       redactLabel, proceedLabel, coverage, plan }) {
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
      const result = doc.text ? scan(doc.text, policy) : nothingFound();
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

  let fileBypassUntil = 0;

  /** Shared flow for both drop and file-input selection. */
  async function guardFiles(files, { onAllow, onCancel }) {
    let reports;
    try { reports = await inspect(files); } catch { onAllow(files); return; }

    const all = reports.flatMap((r) => r.findings);
    const coverage = coverageLines(reports);
    const strippable = reports.filter((r) => rewriteMode(r.doc).mode === 'strip');

    // Nothing found, but something could not be read: say so rather than
    // letting silence imply the file was checked.
    if (!all.length && !strippable.length) {
      if (coverage.length && policy.mode !== 'off') {
        showNotice(coverage.length === 1
          ? coverage[0]
          : `Chhanni could not read ${coverage.length} of these files. Check them yourself before sending.`);
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
