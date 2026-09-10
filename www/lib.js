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
  'stop':        '<rect width="13" height="13" x="5.5" y="5.5" rx="2" fill="currentColor" stroke="none"/>',
  'plus':        '<path d="M5 12h14"/><path d="M12 5v14"/>',
  'paperclip':   '<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 17.93 8.83l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
  'image':       '<rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>',
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

// --- Web-search evidence --------------------------------------------------
// Render one search entry (a real query + readable result snippets, or a
// "skipped" marker) as a DOM element. Source links are NOT included here —
// they're rendered as mini chips next to the timestamp (see source-link
// helpers). textContent / property assignment only, so no sanitizing needed.
function buildSearchRow(entry) {
  const row = document.createElement('div');
  row.className = 'search-row';
  if (entry && entry.skipped) {
    row.classList.add('search-skipped');
    const ic = document.createElement('span'); ic.className = 'status-ic'; ic.innerHTML = icon('globe', 14);
    const t = document.createElement('span');
    t.textContent = 'Web search on — ' + (entry.reason || 'model answered without searching');
    row.appendChild(ic); row.appendChild(t);
    return row;
  }
  const head = document.createElement('div'); head.className = 'search-head';
  const ic = document.createElement('span'); ic.className = 'status-ic'; ic.innerHTML = icon('globe', 14);
  const label = document.createElement('span'); label.textContent = 'Searched the web';
  head.appendChild(ic); head.appendChild(label);
  if (entry && entry.query) {
    const q = document.createElement('span'); q.className = 'search-query'; q.textContent = entry.query;
    head.appendChild(q);
  }
  row.appendChild(head);
  const sources = (entry && entry.sources) || [];
  const list = document.createElement('div'); list.className = 'search-snippets';
  if (sources.length) {
    sources.forEach((src, i) => {
      const item = document.createElement('div'); item.className = 'search-src';
      const title = document.createElement('div'); title.className = 'search-src-title';
      title.textContent = (i + 1) + '. ' + (src.title || src.url || 'source');
      item.appendChild(title);
      if (src.snippet) {
        const snip = document.createElement('div'); snip.className = 'search-src-snippet'; snip.textContent = src.snippet;
        item.appendChild(snip);
      }
      list.appendChild(item);
    });
  } else {
    list.classList.add('muted');
    list.textContent = 'no results';
  }
  row.appendChild(list);
  return row;
}

// --- Source-link mini chips (rendered next to the timestamp) ---
// buildSourceLink makes one numbered chip; numbering follows the container's
// existing children so chips stay sequential across multiple searches.
function buildSourceLink(container, src) {
  const a = document.createElement('a');
  a.className = 'src-link';
  a.target = '_blank'; a.rel = 'noopener noreferrer';
  // Only link http(s) URLs; drop anything else to avoid javascript: etc.
  if (/^https?:\/\//i.test(src.url || '')) a.href = src.url;
  else { a.href = '#'; a.addEventListener('click', e => e.preventDefault()); }
  a.textContent = String(container.children.length + 1);
  a.title = src.title || src.url || 'source';
  return a;
}

// Append one entry's source links as mini chips (used while streaming).
export function appendSourceLinks(container, entry) {
  if (!container || !entry || entry.skipped) return;
  (entry.sources || []).forEach(src => container.appendChild(buildSourceLink(container, src)));
}

// Replace all source-link chips with the full set (used on SSE replay / reload).
export function renderSourceLinks(container, searches) {
  if (!container) return;
  container.replaceChildren();
  if (!searches || !searches.length) return;
  searches.forEach(entry => appendSourceLinks(container, entry));
}

// Replace the evidence block with the full set (used on SSE replay / reload).
export function renderSearchBlock(container, searches) {
  if (!container) return;
  container.replaceChildren();
  if (!searches || !searches.length) { container.classList.add('hidden'); return; }
  container.classList.remove('hidden');
  searches.forEach(s => container.appendChild(buildSearchRow(s)));
}

// Append a single live search event (used while streaming).
export function appendSearchEntry(container, entry) {
  if (!container || !entry) return;
  container.classList.remove('hidden');
  const p = container.querySelector('.search-pending');
  if (p) p.remove();
  container.appendChild(buildSearchRow(entry));
}

// Show a live "Searching the web…" indicator in the evidence block while a
// lookup is in flight (before results land). Replaces any existing pending
// row; cleared by appendSearchEntry (results arrived) or clearSearchPending.
export function showSearchPending(container, query) {
  if (!container) return;
  container.classList.remove('hidden');
  const existing = container.querySelector('.search-pending');
  if (existing) existing.remove();
  const row = document.createElement('div');
  row.className = 'search-row search-pending search-head';
  const ic = document.createElement('span'); ic.className = 'status-ic'; ic.innerHTML = icon('globe', 14);
  const label = document.createElement('span');
  label.textContent = query ? ('Searching: ' + query) : 'Searching the web…';
  row.appendChild(ic); row.appendChild(label); row.appendChild(thinkingDots());
  container.appendChild(row);
}

// Remove a live search indicator (e.g. when the model moves to answering).
export function clearSearchPending(container) {
  if (!container) return;
  const p = container.querySelector('.search-pending');
  if (p) p.remove();
  if (!container.children.length) container.classList.add('hidden');
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
// render with highlighting + copy buttons.
export class StreamRenderer {
  constructor(container) {
    this.container = container;
    this.acc = '';
    this.phase = '';
    this.dirty = false;
    this.scheduled = false;
    this._scrollParent = undefined; // cached nearest scrollable ancestor
  }

  // Walk up from the bubble to the first ancestor that scrolls vertically.
  // Cached so we don't repeat getComputedStyle every animation frame.
  _scrollAncestor() {
    if (this._scrollParent !== undefined) return this._scrollParent;
    let el = this.container.parentElement;
    while (el) {
      if (/(auto|scroll)/.test(getComputedStyle(el).overflowY)) { this._scrollParent = el; return el; }
      el = el.parentElement;
    }
    this._scrollParent = null;
    return null;
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
    // The bubble's waiting state reflects the job's phase hint. "queued" is the
    // only true wait (another reply holds the single generation slot); "vision"
    // means the model is encoding an attached image before the first token
    // (slow on the N100). Search-specific "Searching the web…" text lives in
    // the evidence block above (showSearchPending), not here.
    const wrap = document.createElement('span');
    wrap.className = 'status';
    if (this.phase === 'queued') {
      const ic = document.createElement('span'); ic.className = 'status-ic'; ic.innerHTML = icon('clock', 15);
      const t = document.createElement('span'); t.textContent = 'Queued — another reply is generating…';
      wrap.appendChild(ic); wrap.appendChild(t);
      return wrap;
    }
    if (this.phase === 'vision') {
      const ic = document.createElement('span'); ic.className = 'status-ic'; ic.innerHTML = icon('image', 15);
      const t = document.createElement('span'); t.textContent = 'Analyzing image…';
      wrap.appendChild(ic); wrap.appendChild(t);
      return wrap;
    }
    wrap.appendChild(thinkingDots());
    return wrap;
  }

  _flush() {
    this.scheduled = false;
    if (!this.dirty) return;
    this.dirty = false;
    // Capture the follow state BEFORE re-parsing, while scrollTop still
    // reflects where the user sits relative to the existing content. Capturing
    // after the update would mistake a big frame of new text for a scroll-up.
    const sp = this._scrollAncestor();
    const follow = sp ? (sp.scrollHeight - sp.scrollTop - sp.clientHeight < 160) : false;
    if (this.acc) {
      this.container.innerHTML = parseAndSanitize(this.acc);
      polishLinks(this.container);
    } else {
      this.container.replaceChildren(this._statusEl());
    }
    // Pin to the bottom so the live text + the date/time row beneath it stay in
    // view as the bubble grows — but only if the user is following along. If
    // they scrolled up to read earlier text, leave their position alone.
    if (follow && sp) sp.scrollTop = sp.scrollHeight;
  }

  // Final render: full markdown + highlighting + copy buttons.
  finalize(text) {
    this.scheduled = false;
    this.dirty = false;
    if (text != null) this.acc = text;
    renderMessage(this.container, this.acc);
  }
}
