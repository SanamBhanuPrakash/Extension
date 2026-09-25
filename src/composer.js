/**
 * Finding the composer on a site nobody has added to the manifest yet.
 *
 * A new AI product ships every week, and a hand-maintained host list is always
 * behind. Worse, the gap is invisible: the extension looks installed and
 * working while quietly watching nothing.
 *
 * So the composer is identified by *shape* instead. An AI chat composer is a
 * large, empty, focusable text surface at the bottom of a page, next to a
 * send control. That description is stable across products in a way that a
 * hostname list is not.
 *
 * This runs only where the user has granted access. It widens coverage within
 * a permission, never the permission itself.
 */

/** Known selectors first — cheap, exact, and right on the sites we know. */
const KNOWN = [
  '#prompt-textarea',
  'div[contenteditable="true"].ProseMirror',
  'div[contenteditable="true"][role="textbox"]',
  'rich-textarea div[contenteditable="true"]',
  'textarea[data-testid*="prompt" i]',
  'textarea[placeholder*="message" i]',
  'textarea[placeholder*="ask" i]',
];

const SEND_HINT = /\b(send|submit|ask|generate|run|prompt)\b/i;

function isVisible(el) {
  if (!el.isConnected) return false;
  const rect = el.getBoundingClientRect();
  if (rect.width < 120 || rect.height < 18) return false;
  const style = getComputedStyle(el);
  return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0.1;
}

/** Is there something that looks like a send button near this element? */
function hasSendControl(el) {
  const scope = el.closest('form') || el.parentElement?.parentElement || el.parentElement;
  if (!scope) return false;
  for (const candidate of scope.querySelectorAll('button, [role="button"], input[type="submit"]')) {
    const label = `${candidate.getAttribute('aria-label') || ''} ${candidate.getAttribute('title') || ''} ${candidate.getAttribute('data-testid') || ''} ${candidate.textContent || ''}`;
    if (SEND_HINT.test(label)) return true;
    // An icon-only button with no text is the common case; accept a small
    // square control sitting inside the composer's own container.
    if (!candidate.textContent.trim() && candidate.getBoundingClientRect().width <= 64) return true;
  }
  return false;
}

/**
 * Scores an editable element on how much it looks like a chat composer.
 * @returns {number} 0 to 1
 */
export function composerScore(el) {
  if (!el || !isVisible(el)) return 0;
  const isTextarea = el.tagName === 'TEXTAREA';
  if (!isTextarea && !el.isContentEditable) return 0;
  if (el.closest('[aria-hidden="true"]')) return 0;

  let score = 0.2;
  const rect = el.getBoundingClientRect();
  const viewport = window.innerHeight || 800;

  // Sits in the lower half of the viewport, where composers live.
  if (rect.top > viewport * 0.45) score += 0.25;
  // Wide enough to be a prose surface rather than a form field.
  if (rect.width >= 260) score += 0.2;
  // Multi-line, or growable.
  if (rect.height >= 34 || el.isContentEditable) score += 0.15;
  if (hasSendControl(el)) score += 0.25;

  const placeholder = `${el.getAttribute('placeholder') || ''} ${el.getAttribute('aria-label') || ''} ${el.dataset?.placeholder || ''}`;
  if (/\b(message|ask|prompt|chat|question|anything)\b/i.test(placeholder)) score += 0.3;

  // A search box is wide and focusable too, and is not a composer.
  if (el.type === 'search' || /\bsearch\b/i.test(placeholder)) score -= 0.5;
  if (el.closest('[role="search"], form[action*="search" i]')) score -= 0.5;
  // Login forms are the one place a false positive would be actively harmful.
  if (el.closest('form[action*="login" i], form[action*="signin" i]')) return 0;

  return Math.max(0, Math.min(1, score));
}

/** True when this element should be treated as a prompt composer. */
export function isComposer(el, threshold = 0.65) {
  if (!el) return false;
  for (const selector of KNOWN) {
    try { if (el.matches(selector)) return true; } catch { /* invalid selector on this engine */ }
  }
  return composerScore(el) >= threshold;
}

/** The most composer-like editable element currently on the page. */
export function findComposer(root = document) {
  for (const selector of KNOWN) {
    const el = root.querySelector(selector);
    if (el && isVisible(el)) return el;
  }
  let best = null;
  let bestScore = 0;
  for (const el of root.querySelectorAll('textarea, [contenteditable="true"]')) {
    const s = composerScore(el);
    if (s > bestScore) { best = el; bestScore = s; }
  }
  return bestScore >= 0.65 ? best : null;
}
