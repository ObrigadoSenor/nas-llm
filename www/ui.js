// www/ui.js — the agent's eyes and hands on this app's own interface.
//
// Implements the ui_* tool family (backend/agent_ui.go): ui_snapshot, ui_read,
// ui_click, ui_set_value. The backend relays these through the same `toolExec`
// SSE cue as the repo file tools, but the executor is the PAGE, not the desktop
// sidecar — which is why this lives in www/ and serves both the desktop shell
// and the plain browser UI. desktop.js's toolExec shim skips ui_* and lets this
// module own them (see www/AGENTS.md, contract 5).
//
// The whole point is to kill the "I'm unable to interact with the user
// interface" answer: a badge count, an active tab, a disabled button, the
// current model — none of that is in the source, it only exists in the live
// DOM. So the snapshot describes what is on screen right now, in a form small
// enough to survive the backend's 4000-char observation cap.
//
// Safety rails are deliberate and non-negotiable:
//   * the agent cannot approve or reject its own tool calls,
//   * it cannot press Send (no self-prompting),
//   * destructive-looking controls always ask the user, even with auto-approve.

// Observation budget. The backend caps a tool observation at 4000 chars
// (agentObsMaxChars); stay under it so the cap never silently eats the tail of
// a snapshot mid-line.
const MAX_OBS = 3500;
const MAX_LABEL = 90;

// Controls the agent may never activate, with the reason surfaced back to it as
// the observation so it stops trying instead of retrying blindly.
const REFUSED = [
  { sel: '#send', why: 'only the user sends messages — draft into #input instead and let them press Send' },
  { sel: '.tool-approve, .tool-reject', why: 'you cannot approve or reject your own tool call' },
  { sel: '#dsApprovalApprove, #dsApprovalReject, #dsApprovalClose', why: 'you cannot approve or reject your own tool call' },
  { sel: '#dsPlanApprove', why: 'the user approves the plan, not you' },
];

// Subtrees never walked: the approval overlays are the agent's OWN pending
// prompt (not app UI, and showing them invites a self-approval attempt),
// toasts are transient, and icon SVGs are noise.
const APPROVAL_OVERLAYS = '#dsApprovalOverlay, #nasllmUiApprove';
const SKIP_SUBTREE = APPROVAL_OVERLAYS + ', #toasts, script, style, noscript, svg';

// Controls that always ask the user first, even when the conversation has
// auto-approve on — the UI equivalent of delete_path never being auto-approved.
const DESTRUCTIVE_RE = /\b(delete|remove|discard|revoke|reset|disconnect|uninstall|merge|reject|sign ?out|log ?out)\b/i;

const INTERACTIVE_SEL = 'button, a[href], input, textarea, select, summary, [role="button"], [role="tab"], [role="option"], [role="menuitem"], [contenteditable="true"], [tabindex]:not([tabindex="-1"])';

// Named regions, in reading order. A snapshot groups controls under these so
// the model can say "the drawer's Changes tab" instead of reciting a flat list.
// Anything outside them is not reported, so the list has to cover the desktop
// bridge's injected surfaces too — hence the body-level drawer button, which is
// how the workspace panel is reached before login.
const REGIONS = [
  { name: 'login', sel: '#login' },
  { name: 'sidebar', sel: '#sidebar' },
  { name: 'header', sel: '#app header, body > .ds-drawer-btn' },
  { name: 'chat', sel: '#chat' },
  { name: 'composer', sel: '.composer' },
  { name: 'drawer', sel: '#dsDrawer' },
  { name: 'dialog', sel: '.modal.open, .ds-overlay.open, .menu, .tool-popup, #plusPopup:not(.hidden), #slashPopup:not(.hidden)' },
];

// --- ref registry ----------------------------------------------------------
// A ref is either "#id" (stable across snapshots — most of this app's controls
// have one) or "sN:eM" for the anonymous ones. Element identity is what we
// actually resolve on, so a ref from an older snapshot still works as long as
// that exact node is still in the document; anything else is reported as stale
// with an instruction to re-snapshot, which is far safer than clicking whatever
// now occupies the same position.
let snapCount = 0;
let refs = new Map();

function beginSnapshot() {
  snapCount++;
  refs = new Map();
  return snapCount;
}

function refFor(el, seq) {
  const ref = el.id ? '#' + el.id : 's' + snapCount + ':e' + seq;
  refs.set(ref, el);
  return ref;
}

function resolveRef(ref) {
  ref = String(ref || '').trim();
  if (!ref) return { error: 'No ref given. Call ui_snapshot first and use a ref from it.' };
  let el = refs.get(ref) || null;
  // An #id ref survives a page re-render even if it predates this module's map.
  if (!el && ref.startsWith('#')) el = document.getElementById(ref.slice(1));
  if (!el) return { error: 'Unknown ref ' + ref + '. Call ui_snapshot and use a ref from the result.' };
  if (!document.contains(el)) return { error: 'Ref ' + ref + ' is stale — that element is no longer on screen. Call ui_snapshot again.' };
  if (!isVisible(el)) return { error: 'Ref ' + ref + ' is not visible right now. Call ui_snapshot again to see the current screen.' };
  return { el };
}

// --- inspection helpers ----------------------------------------------------

function isVisible(el) {
  if (!el || el.nodeType !== 1) return false;
  if (el.hidden) return false;
  const cs = getComputedStyle(el);
  if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

function clean(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

function clip(s, n) {
  s = clean(s);
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function isInteractive(el) {
  if (el.matches(INTERACTIVE_SEL)) return true;
  // The desktop bridge wires most of its rows with el.onclick = …, which is a
  // real property and therefore detectable — without this, whole panels would
  // look like inert text to the agent.
  return typeof el.onclick === 'function';
}

// role is what the model reasons about: the tag, refined by type/role so
// "input[checkbox]" and "button" don't read the same.
function roleOf(el) {
  const tag = el.tagName.toLowerCase();
  const aria = el.getAttribute('role');
  if (tag === 'input') return 'input[' + (el.getAttribute('type') || 'text') + ']';
  if (aria) return aria;
  if (tag === 'a') return 'link';
  if (tag === 'div' || tag === 'span') return isInteractive(el) ? 'clickable' : 'text';
  return tag;
}

function labelOf(el) {
  return clean(el.getAttribute('aria-label')) ||
    clean(el.getAttribute('title')) ||
    clip(el.textContent, MAX_LABEL) ||
    clean(el.getAttribute('placeholder')) ||
    clean(el.getAttribute('alt')) ||
    '';
}

function refusalFor(el) {
  for (const r of REFUSED) {
    if (el.closest(r.sel)) return r.why;
  }
  return null;
}

function isDestructive(el) {
  const hay = [el.id, typeof el.className === 'string' ? el.className : '', labelOf(el), el.getAttribute('title')]
    .filter(Boolean).join(' ');
  return DESTRUCTIVE_RE.test(hay);
}

// The user's own credentials are on screen (the login email field, any password
// input) — report that the field exists and whether it is filled, never what it
// holds. Everything else reports its value, which is the point of the tool.
function fieldValue(el) {
  const tag = el.tagName.toLowerCase();
  if (tag !== 'input' && tag !== 'textarea' && tag !== 'select') return null;
  const type = (el.getAttribute('type') || 'text').toLowerCase();
  if (type === 'password' || type === 'email') return el.value ? '(filled, hidden)' : '(empty)';
  return el.value || '';
}

// One snapshot line. Keeps the label first (that's what the user would call the
// control) and appends only the state that isn't already implied by it.
function describe(el, ref) {
  const label = labelOf(el);
  const parts = [ref, roleOf(el)];
  parts.push('"' + (label || '(no label)') + '"');
  const title = clean(el.getAttribute('title'));
  if (title && title !== label) parts.push('title="' + clip(title, MAX_LABEL) + '"');
  const val = fieldValue(el);
  if (val !== null) parts.push('value="' + clip(val, MAX_LABEL) + '"');
  const ph = clean(el.getAttribute('placeholder'));
  if (ph && ph !== label) parts.push('placeholder="' + clip(ph, 40) + '"');
  if (el.disabled) parts.push('disabled');
  if (el.checked) parts.push('checked');
  const cls = typeof el.className === 'string' ? el.className : '';
  if (/\b(active|selected|on|open|expanded)\b/.test(cls)) parts.push('active');
  const expanded = el.getAttribute('aria-expanded');
  if (expanded) parts.push('expanded=' + expanded);
  if (isDestructive(el)) parts.push('destructive(asks-first)');
  if (refusalFor(el)) parts.push('refused');
  return parts.join(' ');
}

// --- snapshot --------------------------------------------------------------

// Walk one region depth-first (so the output reads in the order things appear
// on screen), emitting a line per interactive control plus short text leaves —
// badges, counts, notes, status lines — which carry state nothing else would
// report. Prunes invisible subtrees: a hidden parent means every descendant is
// hidden too, so this stays cheap despite calling getComputedStyle per node.
function walk(el, out, seq) {
  if (!el || el.nodeType !== 1) return;
  if (el.matches && el.matches(SKIP_SUBTREE)) return;
  if (!isVisible(el)) return;
  if (isInteractive(el)) {
    out.push(describe(el, refFor(el, seq.n++)));
    // A control's inner markup (icon, label span, badge) is already covered by
    // its own line's label/text — only descend when it nests another control,
    // like a row with its own ⋯ menu button.
    if (!el.querySelector(INTERACTIVE_SEL)) return;
  } else if (!el.firstElementChild) {
    // Leaf text: the drawer's dirty-count badge, "3 files changed", the
    // signed-in email. Cheap, and often exactly what was asked about.
    const txt = clip(el.textContent, MAX_LABEL);
    if (txt) {
      const ref = el.id ? '#' + el.id : 's' + snapCount + ':e' + seq.n++;
      if (el.id) refs.set(ref, el);
      out.push(ref + ' text "' + txt + '"');
    }
    return;
  }
  for (const child of el.children) walk(child, out, seq);
}

// The chat transcript is by far the largest DOM in the app and the agent
// already has the conversation in its context — summarize it instead of
// serializing it, or one snapshot would blow the whole observation budget.
function chatLine(full) {
  const chat = document.getElementById('chat');
  if (!chat || !isVisible(chat)) return null;
  const msgs = [...chat.querySelectorAll(':scope > .msg')];
  if (!msgs.length) return '[chat] empty';
  const describeMsg = (m) => {
    const role = m.classList.contains('user') ? 'user' : 'assistant';
    const b = m.querySelector('.bubble');
    return role + ' "' + clip(b ? b.textContent : m.textContent, 100) + '"';
  };
  if (!full) {
    return '[chat] ' + msgs.length + ' message' + (msgs.length === 1 ? '' : 's') +
      ', last: ' + describeMsg(msgs[msgs.length - 1]);
  }
  const tail = msgs.slice(-8);
  return '[chat] ' + msgs.length + ' messages, last ' + tail.length + ':\n' +
    tail.map((m, i) => '  ' + (msgs.length - tail.length + i + 1) + '. ' + describeMsg(m)).join('\n');
}

function openOverlays() {
  const out = [];
  const drawer = document.getElementById('dsDrawer');
  if (drawer && drawer.classList.contains('open')) {
    const tab = drawer.querySelector('.ds-drawer-tab.active');
    out.push('drawer' + (tab ? '(' + clean(tab.textContent) + ')' : ''));
  }
  // The agent's own approval prompts are excluded: they are not part of the
  // app's UI, and reporting them would tell the agent it has something to
  // click when it explicitly does not.
  document.querySelectorAll('.modal.open, .ds-overlay.open').forEach(m => {
    if (m.matches(APPROVAL_OVERLAYS)) return;
    out.push(clean(m.id) || (m.classList.contains('modal') ? 'modal' : 'overlay'));
  });
  return out;
}

function contextLine(id) {
  const desktop = !!(window.__TAURI__ || window.__TAURI_INTERNALS__ || document.querySelector('.ds-drawer-btn'));
  const bits = ['Screen snapshot s' + id, desktop ? 'desktop app' : 'browser'];
  const title = document.getElementById('chatTitle');
  if (title) bits.push('chat="' + clip(title.textContent, 60) + '"');
  const model = document.getElementById('modelBtn');
  if (model && clean(model.textContent)) bits.push('model="' + clip(model.textContent, 40) + '"');
  const mode = document.getElementById('modeSeg');
  if (mode && clean(mode.textContent)) bits.push('mode="' + clip(mode.textContent, 30) + '"');
  const overlays = openOverlays();
  bits.push(overlays.length ? 'open: ' + overlays.join(', ') : 'no panel open');
  return bits.join(' · ');
}

function regionRoots(area) {
  const roots = [];
  for (const r of REGIONS) {
    if (area !== 'all' && area !== r.name) continue;
    document.querySelectorAll(r.sel).forEach(el => {
      if (isVisible(el) && !roots.some(x => x.el === el)) roots.push({ name: r.name, el });
    });
  }
  return roots;
}

function snapshot(area) {
  area = String(area || 'all').trim().toLowerCase() || 'all';
  const id = beginSnapshot();
  const seq = { n: 1 };
  const lines = [contextLine(id)];
  const roots = regionRoots(area);
  if (!roots.length) {
    return {
      observation: lines[0] + '\nNothing matches area "' + area + '" right now (that region is closed or not present). Try ui_snapshot with no area.',
      preview: 'no ' + area,
    };
  }
  let truncated = false;
  let used = lines[0].length;
  for (const root of roots) {
    if (root.name === 'chat') {
      const cl = chatLine(area === 'chat');
      if (cl) { lines.push(cl); used += cl.length; }
      continue;
    }
    const body = [];
    walk(root.el, body, seq);
    if (!body.length) continue;
    const header = '[' + root.name + ']';
    lines.push(header);
    used += header.length;
    for (const b of body) {
      if (used + b.length > MAX_OBS) { truncated = true; break; }
      lines.push('  ' + b);
      used += b.length + 3;
    }
    if (truncated) break;
  }
  if (truncated) lines.push('… truncated. Re-run ui_snapshot with an area (sidebar, header, composer, drawer, dialog) to see the rest.');
  lines.push('Refs are only good until the screen changes — re-snapshot after anything that redraws.');
  const count = seq.n - 1;
  return { observation: lines.join('\n'), preview: count + ' controls' + (truncated ? ' (truncated)' : '') };
}

// --- read ------------------------------------------------------------------

function readRef(ref) {
  const r = resolveRef(ref);
  if (r.error) return { observation: r.error, preview: 'bad ref', is_error: true };
  const el = r.el;
  const lines = [describe(el, ref)];
  const text = clean(el.textContent);
  if (text) lines.push('text: ' + clip(text, 1200));
  const kids = [...el.children].filter(isVisible).slice(0, 20)
    .map(c => '  ' + roleOf(c) + ' "' + clip(labelOf(c), 60) + '"');
  if (kids.length) lines.push('contains:\n' + kids.join('\n'));
  return { observation: lines.join('\n'), preview: clip(labelOf(el) || ref, 40) };
}

// --- actions ---------------------------------------------------------------

// A cheap fingerprint of "what is on screen", compared before and after an
// action so the agent learns what its click did without spending another step
// on a full snapshot.
function screenSignature() {
  return {
    overlays: openOverlays().join('|'),
    controls: document.querySelectorAll(INTERACTIVE_SEL).length,
    title: clean((document.getElementById('chatTitle') || {}).textContent),
  };
}

function describeChange(before, after) {
  if (before.overlays !== after.overlays) {
    const was = before.overlays ? before.overlays.split('|') : [];
    const now = after.overlays ? after.overlays.split('|') : [];
    const opened = now.filter(x => !was.includes(x));
    const closed = was.filter(x => !now.includes(x));
    const bits = [];
    if (opened.length) bits.push('opened ' + opened.join(', '));
    if (closed.length) bits.push('closed ' + closed.join(', '));
    if (bits.length) return bits.join('; ');
  }
  if (before.title !== after.title) return 'the view changed to "' + after.title + '"';
  const d = after.controls - before.controls;
  if (d > 0) return d + ' more controls are visible';
  if (d < 0) return -d + ' fewer controls are visible';
  return 'no visible change';
}

const settle = () => new Promise(r => setTimeout(r, 180));

async function clickRef(ref) {
  const r = resolveRef(ref);
  if (r.error) return { observation: r.error, preview: 'bad ref', is_error: true };
  const el = r.el;
  const refused = refusalFor(el);
  if (refused) {
    return { observation: 'Refused to click ' + ref + ': ' + refused + '.', preview: 'refused', is_error: true };
  }
  if (el.disabled) {
    return { observation: ref + ' is disabled right now, so clicking it would do nothing.', preview: 'disabled', is_error: true };
  }
  const label = labelOf(el) || ref;
  const before = screenSignature();
  try {
    if (el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
    if (el.focus) el.focus({ preventScroll: true });
    el.click();
  } catch (e) {
    return { observation: 'Click on ' + ref + ' failed: ' + String((e && e.message) || e), preview: 'click failed', is_error: true };
  }
  await settle();
  const change = describeChange(before, screenSignature());
  return {
    observation: 'Clicked "' + label + '" (' + ref + '). Result: ' + change + '. Previous refs may be stale now — re-run ui_snapshot before acting again.',
    preview: 'clicked ' + clip(label, 30),
  };
}

async function setValueRef(ref, value) {
  const r = resolveRef(ref);
  if (r.error) return { observation: r.error, preview: 'bad ref', is_error: true };
  const el = r.el;
  const refused = refusalFor(el);
  if (refused) {
    return { observation: 'Refused to type into ' + ref + ': ' + refused + '.', preview: 'refused', is_error: true };
  }
  const tag = el.tagName.toLowerCase();
  const editable = tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable;
  if (!editable) {
    return { observation: ref + ' is a ' + roleOf(el) + ', not a field you can type into. Use ui_click for controls.', preview: 'not a field', is_error: true };
  }
  if (el.disabled) {
    return { observation: ref + ' is disabled right now.', preview: 'disabled', is_error: true };
  }
  const label = labelOf(el) || ref;
  try {
    if (el.isContentEditable && tag !== 'input' && tag !== 'textarea') {
      el.textContent = value;
    } else {
      el.value = value;
    }
    // Fire the events the app's own handlers listen for (autosize, filtering,
    // enable/disable) so setting a value behaves like typing, not like a
    // silent DOM poke the UI never notices.
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  } catch (e) {
    return { observation: 'Could not set ' + ref + ': ' + String((e && e.message) || e), preview: 'set failed', is_error: true };
  }
  await settle();
  return {
    observation: 'Set "' + label + '" (' + ref + ') to: ' + clip(value, 200),
    preview: 'set ' + clip(label, 30),
  };
}

// --- approval --------------------------------------------------------------

// Inline approval in the command block when the chat is on screen (the same
// affordance run_command uses, via the hook lib.js installs), falling back to a
// small centered prompt for a background chat whose block isn't in the DOM.
// Returns a Promise<boolean>.
function requestApproval(key, tool, target) {
  const blocks = window.nasllm && window.nasllm.blocks;
  if (blocks && blocks.requestApproval) {
    const pre = document.createElement('pre');
    pre.className = 'tool-block-output';
    pre.textContent = tool + '\n' + target;
    let resolveInline;
    const inline = new Promise(res => { resolveInline = res; });
    const shown = blocks.requestApproval(key, {
      kind: tool,
      previewEl: pre,
      onApprove: () => resolveInline(true),
      onReject: () => resolveInline(false),
    });
    if (shown) return inline;
  }
  return fallbackApproval(tool, target);
}

// Minimal approval overlay, reusing the existing .modal styling so it looks
// native on both surfaces. Deliberately independent of the desktop bridge's
// FIFO dialog: this module has to work on chat.selected.systems too.
function fallbackApproval(tool, target) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'modal open';
    overlay.id = 'nasllmUiApprove'; // excluded from snapshots: the agent must not see (or click) its own prompt
    const card = document.createElement('div');
    card.className = 'modal-card';
    const head = document.createElement('div');
    head.className = 'modal-head';
    const h = document.createElement('h2');
    h.textContent = 'Let the agent act on the UI?';
    head.appendChild(h);
    card.appendChild(head);
    const body = document.createElement('div');
    body.className = 'modal-body';
    const what = document.createElement('div');
    what.className = 'agent-cfg-note muted';
    what.textContent = tool + ' → ' + target;
    body.appendChild(what);
    const row = document.createElement('div');
    row.className = 'agent-cfg-actions';
    const reject = document.createElement('button');
    reject.textContent = 'Reject';
    const approve = document.createElement('button');
    approve.textContent = 'Approve';
    row.appendChild(reject); row.appendChild(approve);
    body.appendChild(row);
    card.appendChild(body);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    const done = (val) => { overlay.remove(); resolve(val); };
    reject.addEventListener('click', () => done(false));
    approve.addEventListener('click', () => done(true));
    overlay.addEventListener('click', e => { if (e.target === overlay) done(false); });
  });
}

// --- tool dispatch ---------------------------------------------------------

export function isUITool(tool) {
  return typeof tool === 'string' && tool.startsWith('ui_');
}

const ACTION_TOOLS = new Set(['ui_click', 'ui_set_value']);

function parseArgs(raw) {
  try { return JSON.parse(raw || '{}') || {}; } catch { return null; }
}

// A short human description of what an action targets, for the approval prompt
// and the command block header.
function actionTarget(tool, args) {
  const r = resolveRef(args.ref);
  const label = r.el ? (labelOf(r.el) || args.ref) : args.ref;
  if (tool === 'ui_set_value') return 'type "' + clip(args.value, 60) + '" into ' + label;
  return 'click ' + label;
}

async function runUITool(d) {
  const args = parseArgs(d.args);
  if (!args) return { observation: 'Could not parse the arguments for ' + d.tool + '.', preview: 'bad args', is_error: true };
  switch (d.tool) {
    case 'ui_snapshot': return snapshot(args.area);
    case 'ui_read': return readRef(args.ref);
    case 'ui_click': return clickRef(args.ref);
    case 'ui_set_value':
      if (typeof args.value !== 'string') return { observation: 'ui_set_value needs a string value.', preview: 'no value', is_error: true };
      return setValueRef(args.ref, args.value);
    default:
      return { observation: 'Unknown UI tool: ' + d.tool, preview: 'unknown tool', is_error: true };
  }
}

// The same double-delivery guard the desktop shim uses: the backend broadcasts
// every toolExec to BOTH the conversation tail and the user's global /api/events
// hub, so a foreground chat sees each cue twice. Keyed by jobId+step and held
// for the life of the call so a reconnect-replay mid-approval doesn't start a
// second run either.
const inFlight = new Set();

// handleUIToolExec runs one ui_* toolExec cue end to end: approval (when the
// action isn't auto-approved, or is destructive), execution, and the POST back
// to /tool-response that unblocks the agent loop. Mirrors desktop.js's
// runToolExec for the repo tools.
export async function handleUIToolExec(convId, d) {
  if (!convId || !d || !isUITool(d.tool)) return;
  const key = d.jobId + ':' + (d.step ?? 0);
  if (inFlight.has(key)) return;
  inFlight.add(key);
  let res;
  try {
    const args = parseArgs(d.args) || {};
    let approved = true;
    if (ACTION_TOOLS.has(d.tool)) {
      const r = resolveRef(args.ref);
      // Destructive controls prompt even with auto-approve on, exactly like
      // delete_path in the file-tool relay.
      const destructive = !!(r.el && isDestructive(r.el));
      if (!d.autoApprove || destructive) {
        approved = await requestApproval(key, d.tool, actionTarget(d.tool, args));
      }
    }
    res = approved
      ? await runUITool(d)
      : { observation: 'The user rejected this ' + d.tool + ' call. Do not retry it; adjust your approach.', preview: 'rejected', is_error: true };
  } catch (e) {
    res = { observation: String((e && e.message) || e), preview: 'ui error', is_error: true };
  } finally {
    inFlight.delete(key);
  }
  const body = {
    jobId: d.jobId,
    observation: res.observation || '',
    preview: res.preview || '',
    isError: !!res.is_error,
  };
  // Action tools render as command blocks (lib.js COMMAND_TOOLS), so give the
  // block an exit code and a body to close with.
  if (ACTION_TOOLS.has(d.tool)) {
    body.exitCode = res.is_error ? 1 : 0;
    body.output = res.observation || '';
  }
  try {
    await fetch('/api/conversations/' + encodeURIComponent(convId) + '/tool-response', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
  } catch {}
}
