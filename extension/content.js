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
  const { scan } = await import(url('engine/detect.js'));
  const { redact } = await import(url('engine/redact.js'));
  const store = await import(url('store.js'));

  const DEFAULTS = { mode: 'warn', disabled: [], allow: [] };
  let policy = DEFAULTS;
  try {
    const stored = await chrome.storage.sync.get('policy');
    if (stored.policy) policy = { ...DEFAULTS, ...stored.policy };
  } catch { /* first run; defaults are fine */ }
  chrome.storage.onChanged?.addListener((c) => {
    if (c.policy?.newValue) policy = { ...DEFAULTS, ...c.policy.newValue };
  });

  // ------------------------------------------------------------- composer
  const COMPOSER = [
    '#prompt-textarea',
    'div[contenteditable="true"].ProseMirror',
    'div[contenteditable="true"][role="textbox"]',
    'rich-textarea div[contenteditable="true"]',
    'textarea[placeholder]',
    'textarea',
  ].join(',');

  const isEditable = (el) => el && (el.tagName === 'TEXTAREA' || el.isContentEditable);
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
   * The header is a count, not a list. Naming all seven findings produced a
   * four-line heading that pushed the actual findings below the fold — the
   * grouped body is what explains, so the header only has to land the alarm.
   */
  function headline(findings, where) {
    if (findings.length === 1) return `${findings[0].label} ${where}`;
    const blocking = findings.filter((f) => f.severity === 'critical' || f.severity === 'high').length;
    if (blocking && blocking < findings.length) {
      return `${findings.length} things ${where}, ${blocking} of them sensitive`;
    }
    return `${findings.length} things ${where}`;
  }
  const SEVERITY_TITLE = {
    critical: 'Can be used against you immediately',
    high: 'Sensitive',
    medium: 'Looks like a credential',
    low: 'Personal, lower risk',
  };

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    // textContent everywhere: findings echo page-controlled text.
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function showPanel({ findings, verdict, title, onRedact, onProceed, onDismiss,
                       redactLabel, proceedLabel }) {
    closePanel();
    panel = el('div', `chhanni-panel chhanni-${verdict}`);
    panel.setAttribute('role', 'alertdialog');
    panel.setAttribute('aria-modal', 'false');
    panel.setAttribute('aria-live', 'assertive');

    // Header
    const head = el('div', 'chhanni-head');
    head.append(el('i', 'chhanni-dot'), el('strong', null, title));
    const close = el('button', 'chhanni-x', '×');
    close.setAttribute('aria-label', 'Dismiss');
    close.onclick = () => { closePanel(); record('dismissed'); onDismiss?.(); };
    head.appendChild(close);
    panel.appendChild(head);

    // Findings, grouped by severity so the dangerous things are not buried
    // under a list of email addresses.
    const body = el('div', 'chhanni-body');
    const grouped = new Map();
    for (const f of findings) {
      if (!grouped.has(f.severity)) grouped.set(f.severity, []);
      grouped.get(f.severity).push(f);
    }
    for (const severity of SEVERITY_ORDER) {
      const group = grouped.get(severity);
      if (!group) continue;
      const section = el('div', `chhanni-group chhanni-sev-${severity}`);
      section.appendChild(el('h3', null, SEVERITY_TITLE[severity]));

      if (severity === 'low') {
        // The noisy tail collapses to one line and is hoisted out of the
        // scroll area, so it stays visible without scrolling past the
        // dangerous findings above it.
        const labels = [...new Set(group.map((f) => f.label))].join(', ');
        panel.dataset.alsoText = `Also found, lower risk: ${labels}.`;
        continue;
      } else {
        const list = el('ul');
        for (const f of group.slice(0, 6)) {
          const li = el('li');
          const row = el('div', 'chhanni-row');
          row.append(el('span', 'chhanni-label', f.label), el('code', null, f.preview));
          li.appendChild(row);
          if (f.note) li.appendChild(el('em', null, f.note));
          list.appendChild(li);
        }
        if (group.length > 6) list.appendChild(el('li', 'chhanni-more', `and ${group.length - 6} more`));
        section.appendChild(list);
      }
      body.appendChild(section);
    }
    panel.appendChild(body);
    if (panel.dataset.alsoText) {
      panel.appendChild(el('div', 'chhanni-also', panel.dataset.alsoText));
    }

    // Actions
    const actions = el('div', 'chhanni-actions');
    const redactBtn = el('button', 'chhanni-primary',
      redactLabel || `Redact ${findings.length} and continue`);
    redactBtn.onclick = () => { closePanel(); record('redacted'); onRedact(); };
    const proceedBtn = el('button', 'chhanni-ghost', proceedLabel || 'Send as-is');
    proceedBtn.onclick = () => { closePanel(); record('sent'); onProceed(); };
    actions.append(redactBtn, proceedBtn);
    panel.appendChild(actions);

    const hint = el('div', 'chhanni-hint');
    hint.append(el('kbd', null, 'Enter'), document.createTextNode(' redact  ·  '),
      el('kbd', null, 'Esc'), document.createTextNode(' back to editing'));
    panel.appendChild(hint);

    panel.appendChild(el('div', 'chhanni-foot',
      'Checked on this device. Nothing was sent anywhere.'));

    document.body.appendChild(panel);
    requestAnimationFrame(() => panel?.classList.add('chhanni-in'));
    redactBtn.focus();

    function record(action) {
      store.record(findings, { host: location.hostname, action }).catch(() => {});
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
      findings: result.findings,
      verdict: result.verdict,
      title: headline(result.findings, 'in what you pasted'),
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
      reports.push({ file, text, findings: result.findings, verdict: result.verdict });
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
    if (!all.length) { onAllow(files); return; }

    const dirty = reports.filter((r) => r.findings.length);
    const names = dirty.map((r) => r.file.name).join(', ');

    showPanel({
      findings: all,
      verdict: all.some((f) => f.severity === 'critical') ? 'block' : 'warn',
      title: all.length === 1
        ? `${all[0].label} in ${names}`
        : `${all.length} things in ${dirty.length === 1 ? names : `${dirty.length} attached files`}`,
      redactLabel: `Attach redacted ${dirty.length === 1 ? 'copy' : 'copies'}`,
      proceedLabel: 'Attach as-is',
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
      findings: result.findings,
      verdict: result.verdict,
      title: headline(result.findings, 'about to be sent'),
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
