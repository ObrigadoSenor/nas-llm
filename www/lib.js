// nas-llm UI helpers: inline-SVG icon set + markdown rendering.
// No build step — these are native ES modules imported by app.js.
import { marked } from './vendor/marked.esm.js';
import DOMPurify from './vendor/purify.es.mjs';

// --- Icons ------------------------------------------------------------------
// Stroke-based 24x24 paths (Lucide-style), rendered with currentColor so they
// inherit the surrounding text color. icon() returns an SVG string.
const ICONS = {
  'new-chat':    '<path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.623-.623l.84-2.873a2 2 0 0 1 .506-.852z"/>',
  'folder-plus': '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/><path d="M12 10v6"/><path d="M9 13h6"/>',
  'close':       '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  'menu':        '<line x1="4" x2="20" y1="6" y2="6"/><line x1="4" x2="20" y1="12" y2="12"/><line x1="4" x2="20" y1="18" y2="18"/>',
  'globe':       '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
  'more':        '<circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none"/>',
  'chevron-right':'<path d="m9 18 6-6-6-6"/>',
  'chevron-down': '<path d="m6 9 6 6 6-6"/>',
  'rename':      '<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  'trash':       '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/>',
  'send':        '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
  'logout':      '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" x2="9" y1="12" y2="12"/>',
  'clock':       '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  'search':      '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  'error':       '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" x2="12" y1="9" y2="13"/><line x1="12" x2="12.01" y1="17" y2="17"/>',
  'copy':        '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  'check':       '<path d="M20 6 9 17l-5-5"/>',
  'sparkles':    '<path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z"/><path d="M5 3v4"/><path d="M19 17v4"/><path d="M3 5h4"/><path d="M17 19h4"/>',
  'user':        '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  'boxes':       '<rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/>',
  'download':    '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>',
  'gauge':       '<path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>',
};

// Render an icon by name. Returns an SVG string (currentColor stroke).
export function icon(name, size = 18, cls = '') {
  const inner = ICONS[name] || '';
  return `<svg class="icon ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
}

// Replace an element's content with an icon (convenience for static buttons).
export function setIcon(el, name, size) {
  el.innerHTML = icon(name, size);
}

// Animated "thinking" dots, used in waiting status lines.
export function thinkingDots() {
  const t = document.createElement('span');
  t.className = 'thinking';
  t.innerHTML = '<i class="dot"></i><i class="dot"></i><i class="dot"></i>';
  return t;
}

// --- Markdown ---------------------------------------------------------------
// GFM + breaks (single newlines -> <br>, which suits chat). Answers are the
// model's own output; web_search can fold snippet text in, so every render is
// sanitized through DOMPurify (strips javascript: URIs, on* handlers, etc.).
marked.setOptions({ gfm: true, breaks: true });

const PURIFY_CFG = {
  ADD_TAGS: ['input'],            // GFM task-list checkboxes (rendered disabled)
  ADD_ATTR: ['type', 'disabled', 'checked', 'target', 'rel'],
};

function parseAndSanitize(text) {
  // async:false guarantees a string (no async extensions are registered).
  const raw = marked.parse(text ?? '', { async: false });
  return DOMPurify.sanitize(raw, PURIFY_CFG);
}

// Open all links in a new tab and keep prose images from overflowing.
function polishLinks(root) {
  root.querySelectorAll('a[href]').forEach(a => {
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
  });
  root.querySelectorAll('img').forEach(img => {
    img.loading = 'lazy';
    img.referrerpolicy = 'no-referrer';
  });
}

// highlight.js is loaded as a classic script (window.hljs). Highlight every
// code block that hasn't been done yet.
function highlightAll(root) {
  if (!window.hljs) return;
  root.querySelectorAll('pre code:not([data-hl])').forEach(el => {
    el.dataset.hl = '1';
    try { window.hljs.highlightElement(el); } catch { /* unknown lang — leave */ }
  });
}

// Copy button on each <pre> (added at final render, not during streaming).
function addCopyButtons(root) {
  root.querySelectorAll('pre:not([data-copy])').forEach(pre => {
    pre.dataset.copy = '1';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'code-copy';
    btn.setAttribute('aria-label', 'Copy code');
    btn.innerHTML = icon('copy', 15);
    btn.addEventListener('click', async () => {
      const code = pre.querySelector('code');
      const text = code ? code.innerText : pre.innerText;
      try {
        await navigator.clipboard.writeText(text);
        btn.classList.add('copied');
        btn.innerHTML = icon('check', 15);
        setTimeout(() => { btn.classList.remove('copied'); btn.innerHTML = icon('copy', 15); }, 1200);
      } catch { /* clipboard blocked — ignore */ }
    });
    pre.appendChild(btn);
  });
}

// Render a finished message as markdown: sanitize, open links, highlight, copy.
export function renderMessage(container, text) {
  container.innerHTML = parseAndSanitize(text);
  polishLinks(container);
  highlightAll(container);
  addCopyButtons(container);
}

// Escape plain text (used for user messages, which are NOT rendered as markdown
// — a user typing # or * shouldn't see accidental formatting).
export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// StreamRenderer coalesces incoming chunks into at most one markdown re-parse
// per animation frame, so a fast burst of SSE chunks can't thrash the parser.
// Syntax highlighting is skipped while streaming; finalize() does the full
// render with highlighting + copy buttons and drops the cursor.
export class StreamRenderer {
  constructor(container, cursor) {
    this.container = container;
    this.cursor = cursor;        // blinking caret element (appended after prose)
    this.acc = '';
    this.phase = '';
    this.dirty = false;
    this.scheduled = false;
  }

  set(text) { this.acc = text ?? ''; this._mark(); }
  append(delta) { if (delta) { this.acc += delta; this._mark(); } }
  setPhase(phase) { this.phase = phase || ''; this._mark(); }

  _mark() {
    this.dirty = true;
    if (!this.scheduled) {
      this.scheduled = true;
      requestAnimationFrame(() => this._flush());
    }
  }

  _statusEl() {
    const wrap = document.createElement('span');
    wrap.className = 'status';
    let name = '', text = '';
    if (this.phase === 'queued') { name = 'clock'; text = 'Queued — another reply is generating…'; }
    else if (this.phase.startsWith('searching:')) { name = 'search'; text = 'Searching: ' + this.phase.slice(10).trim(); }
    else if (this.phase === 'searching') { name = 'search'; text = 'Searching the web…'; }
    if (!name) { wrap.appendChild(thinkingDots()); return wrap; }
    const ic = document.createElement('span'); ic.className = 'status-ic'; ic.innerHTML = icon(name, 15);
    const t = document.createElement('span'); t.textContent = text;
    wrap.appendChild(ic); wrap.appendChild(t); wrap.appendChild(thinkingDots());
    return wrap;
  }

  _flush() {
    this.scheduled = false;
    if (!this.dirty) return;
    this.dirty = false;
    if (this.acc) {
      this.container.innerHTML = parseAndSanitize(this.acc);
      polishLinks(this.container);
    } else {
      this.container.replaceChildren(this._statusEl());
    }
    if (this.cursor) this.container.appendChild(this.cursor);
    // Scroll is driven by the caller; nothing here.
  }

  // Final render: full markdown + highlighting + copy buttons, no cursor.
  finalize(text) {
    this.scheduled = false;
    this.dirty = false;
    if (text != null) this.acc = text;
    renderMessage(this.container, this.acc);
  }
}
