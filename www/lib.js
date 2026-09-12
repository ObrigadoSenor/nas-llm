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
  'help':        '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
  'wrench':      '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
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

// --- Agent tool-call trace (steps drawer) ----------------------------------
// renderAgentSteps replaces the drawer with the full trace (SSE replay / reload).
// appendAgentStep adds one live step as it streams. Each row shows the step
// number, tool name, arguments, and a result preview; a web_search row also
// shows the query and numbered source links. An ask_user row shows its preview
// text only — the interactive question card is rendered separately by the
// questions event / persisted Clarify, so the row is just a trace entry.
function stepIcon(tool) {
  return { web_search: 'globe', ask_user: 'help', get_time: 'clock', calculator: 'gauge',
    memory_read: 'boxes', memory_write: 'boxes', fetch_page: 'search' }[tool] || 'wrench';
}
function truncateArgs(s) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  if (s.length > 80) return s.slice(0, 80) + '…';
  return s;
}
function buildStepRow(st) {
  const row = document.createElement('div');
  row.className = 'step' + (st.isError ? ' err' : '');
  const head = document.createElement('div'); head.className = 'step-head';
  const num = document.createElement('span'); num.className = 'step-num'; num.textContent = String(st.step ?? '');
  const ic = document.createElement('span'); ic.className = 'status-ic'; ic.innerHTML = icon(stepIcon(st.tool), 14);
  const name = document.createElement('span'); name.className = 'step-tool'; name.textContent = st.tool || '';
  head.appendChild(num); head.appendChild(ic); head.appendChild(name);
  // Hide raw args when the step renders a readable query/question payload
  // (search sources / clarify card) — the args JSON just duplicates it.
  const hasNicePayload = !!(st.search || st.clarify);
  if (st.args && !hasNicePayload) {
    const a = document.createElement('span'); a.className = 'step-args'; a.textContent = truncateArgs(st.args);
    head.appendChild(a);
  }
  if (st.durationMs && st.durationMs > 0) {
    const d = document.createElement('span'); d.className = 'step-dur muted'; d.textContent = st.durationMs + 'ms';
    head.appendChild(d);
  }
  row.appendChild(head);
  if (st.preview) {
    const p = document.createElement('div'); p.className = 'step-preview'; p.textContent = st.preview;
    row.appendChild(p);
  }
  const search = st.search && st.search.searches ? st.search.searches[0] : null;
  if (search && !search.skipped) {
    const src = document.createElement('div'); src.className = 'step-sources';
    if (search.query) { const q = document.createElement('span'); q.className = 'step-query'; q.textContent = search.query; src.appendChild(q); }
    (search.sources || []).forEach((s, i) => {
      const a = document.createElement('a'); a.className = 'src-link'; a.target = '_blank'; a.rel = 'noopener noreferrer';
      if (/^https?:\/\//i.test(s.url || '')) a.href = s.url; else { a.href = '#'; a.addEventListener('click', e => e.preventDefault()); }
      a.textContent = String(i + 1); a.title = s.title || s.url || 'source';
      src.appendChild(a);
    });
    row.appendChild(src);
  }
  return row;
}
export function renderAgentSteps(container, steps) {
  if (!container) return;
  container.replaceChildren();
  if (!steps || !steps.length) { container.classList.add('hidden'); return; }
  container.classList.remove('hidden');
  steps.forEach(st => container.appendChild(buildStepRow(st)));
}
export function appendAgentStep(container, st) {
  if (!container || !st) return;
  container.classList.remove('hidden');
  container.appendChild(buildStepRow(st));
}

// --- Agent thinking drawer (per-round reasoning, minimal + collapsible) ----------
// renderThoughts replaces the drawer body with the full set (SSE replay / reload);
// appendThought adds one live thought as its round completes. The <summary> holds
// a mutable label span (setThoughtsSummary) so callers can show "Thinking" +
// animated dots while reasoning streams, then swap to "Thought for Xs" and
// collapse the drawer when it completes. Each thought is a small, dim block.
function buildThoughtRow(text) {
  const div = document.createElement('div');
  div.className = 'thought';
  const t = document.createElement('span'); t.className = 'thought-text';
  t.textContent = String(text || '');
  div.appendChild(t);
  return div;
}
export function renderThoughts(container, thoughts) {
  if (!container) return;
  const det = container.querySelector('details.thoughts-det');
  if (!det) return;
  const body = det.querySelector('.thoughts-body');
  body.replaceChildren();
  if (!thoughts || !thoughts.length) { container.classList.add('hidden'); return; }
  container.classList.remove('hidden');
  thoughts.forEach(t => body.appendChild(buildThoughtRow(t)));
}
export function appendThought(container, text) {
  if (!container || text == null) return;
  const det = container.querySelector('details.thoughts-det');
  if (!det) return;
  container.classList.remove('hidden');
  det.querySelector('.thoughts-body').appendChild(buildThoughtRow(text));
}
// Update the thinking drawer's summary label. streaming=true shows the text
// followed by animated dots (used while reasoning streams); streaming=false
// shows a plain one-liner (the "Thought for Xs" done state, or reloaded history
// which has no live timer). The drawer's open/collapsed state is owned by the
// caller (tailJob / addMsg), not by this helper.
export function setThoughtsSummary(det, text, { streaming = false } = {}) {
  if (!det) return;
  const label = det.querySelector('.thoughts-label');
  if (!label) return;
  label.classList.toggle('streaming', !!streaming);
  label.replaceChildren();
  const t = document.createElement('span'); t.textContent = String(text || '');
  label.appendChild(t);
  if (streaming) label.appendChild(thinkingDots());
}
// Build the collapsible thinking wrapper (<details open>) the SSE handlers
// fill. open by default so thinking is visible (smaller) while it streams; the
// tailJob done handler swaps the label to "Thought for Xs" and removes `open`.
export function buildThoughtsWrap() {
  const wrap = document.createElement('div'); wrap.className = 'msg-thoughts hidden';
  const det = document.createElement('details'); det.className = 'thoughts-det'; det.open = true;
  const sum = document.createElement('summary');
  const label = document.createElement('span'); label.className = 'thoughts-label'; label.textContent = 'Thinking';
  sum.appendChild(label);
  const body = document.createElement('div'); body.className = 'thoughts-body';
  det.appendChild(sum); det.appendChild(body); wrap.appendChild(det);
  return { wrap, det };
}

// --- Clarifying questions (agent loop) --------------------------------------
// renderClarifyCard paints the model's clarifying question(s) as a card with a
// selectable option list — radio rows for a single-select question, checkbox
// rows for a multi-select question — plus an inline free-text input + Send so
// the user can type their own answer when none of the options fit. It replaces
// the bubble's streamed preamble so the card is the whole answer.
// When answered=true the controls render disabled (the user already replied,
// e.g. on a reload of history); selectedValue is the user's recorded answer
// (the next user message's content), used to highlight the chosen option or
// fill the free-text input on reload. onAnswer(value) fires on submit for a
// live, unanswered card and is expected to send the value as the next turn.
export function renderClarifyCard(container, clarify, answered, onAnswer, selectedValue) {
  if (!container) return;
  container.replaceChildren();
  const qs = (clarify && clarify.questions) || [];
  qs.forEach(q => {
    const card = document.createElement('div'); card.className = 'clarify-card';
    const head = document.createElement('div'); head.className = 'clarify-q';
    head.textContent = q.text || '';
    card.appendChild(head);
    const opts = q.options || [];
    const multi = q.type === 'multi';
    const isFree = q.type === 'free' || !opts.length;
    const selected = new Set(); // indices of selected options

    let rowsWrap = null;
    if (!isFree) {
      rowsWrap = document.createElement('div'); rowsWrap.className = 'clarify-options';
      opts.forEach((o, i) => {
        const v = o.value || o.label;
        const label = o.label || v || '';
        const row = document.createElement('button'); row.type = 'button';
        row.className = 'clarify-row ' + (multi ? 'multi' : 'single');
        row.setAttribute('role', multi ? 'checkbox' : 'radio');
        row.setAttribute('aria-checked', 'false');
        const ind = document.createElement('span'); ind.className = 'clarify-row-ind';
        const lab = document.createElement('span'); lab.className = 'clarify-row-label';
        lab.textContent = label;
        row.appendChild(ind); row.appendChild(lab);
        if (answered) {
          row.disabled = true;
          if (optionMatches(label, v, selectedValue, multi)) {
            row.classList.add('selected'); row.setAttribute('aria-checked', 'true');
          }
        } else if (onAnswer) {
          row.addEventListener('click', () => {
            if (multi) {
              if (selected.has(i)) { selected.delete(i); row.classList.remove('selected'); row.setAttribute('aria-checked', 'false'); }
              else { selected.add(i); row.classList.add('selected'); row.setAttribute('aria-checked', 'true'); }
            } else {
              selected.clear(); selected.add(i);
              rowsWrap.querySelectorAll('.clarify-row').forEach(r => { r.classList.remove('selected'); r.setAttribute('aria-checked', 'false'); });
              row.classList.add('selected'); row.setAttribute('aria-checked', 'true');
            }
          });
        }
        rowsWrap.appendChild(row);
      });
      card.appendChild(rowsWrap);
    }

    // Inline free-text input — always present so the user can type their own
    // answer even when the model offered options.
    const free = document.createElement('div'); free.className = 'clarify-free';
    const inp = document.createElement('input'); inp.type = 'text';
    inp.className = 'clarify-input';
    inp.placeholder = isFree ? 'Type your answer…' : 'Or type your own answer…';
    if (answered) {
      inp.disabled = true;
      if (isFree && selectedValue) inp.value = selectedValue;
    }
    const send = document.createElement('button'); send.type = 'button';
    send.className = 'clarify-send'; send.textContent = 'Send';
    if (answered) send.disabled = true;
    const submit = () => {
      if (answered || !onAnswer) return;
      const typed = inp.value.trim();
      if (typed) { onAnswer(typed); return; }
      if (isFree || selected.size === 0) { inp.focus(); return; }
      const chosen = [...selected].sort((a, b) => a - b).map(i => opts[i].value || opts[i].label);
      onAnswer(multi ? chosen.join('\n') : chosen[0]);
    };
    send.addEventListener('click', submit);
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
    free.appendChild(inp); free.appendChild(send);
    card.appendChild(free);

    container.appendChild(card);
  });
}

// optionMatches checks whether a given option was the user's recorded answer
// (used to highlight the chosen row on reload). For multi-select the stored
// answer is the selected values joined (newline/comma/semicolon), so each
// option is checked for membership.
function optionMatches(label, value, answer, multi) {
  if (answer == null) return false;
  const a = String(answer).trim();
  if (!a) return false;
  if (!multi) return a === (value || label) || a === label;
  const parts = a.split(/[\n,;]/).map(s => s.trim()).filter(Boolean);
  return parts.includes(value || label) || parts.includes(label);
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
    this._suspended = false; // when true, _flush is a no-op (a clarify card owns the bubble)
    this._scrollParent = undefined; // cached nearest scrollable ancestor
  }

  // Freeze the renderer so a scheduled RAF flush won't overwrite a clarify card
  // that took over the bubble. Used when a "questions" event arrives.
  suspend() { this.scheduled = false; this.dirty = false; this._suspended = true; }

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
    if (this.phase === 'clarifying') {
      const ic = document.createElement('span'); ic.className = 'status-ic'; ic.innerHTML = icon('help', 15);
      const t = document.createElement('span'); t.textContent = 'Thinking of a question to ask…';
      wrap.appendChild(ic); wrap.appendChild(t);
      return wrap;
    }
    if (this.phase === 'agent') {
      const ic = document.createElement('span'); ic.className = 'status-ic'; ic.innerHTML = icon('sparkles', 15);
      const t = document.createElement('span'); t.textContent = 'Working…';
      wrap.appendChild(ic); wrap.appendChild(t);
      return wrap;
    }
    if (this.phase && this.phase.startsWith('tool:')) {
      const ic = document.createElement('span'); ic.className = 'status-ic'; ic.innerHTML = icon('wrench', 15);
      const t = document.createElement('span'); t.textContent = 'Using ' + this.phase.slice(5) + '…';
      wrap.appendChild(ic); wrap.appendChild(t);
      return wrap;
    }
    wrap.appendChild(thinkingDots());
    return wrap;
  }

  _flush() {
    this.scheduled = false;
    if (this._suspended) return;
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
