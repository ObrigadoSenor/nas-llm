// Desktop bridge — injected into the served www/index.html by the sidecar
// (see src-tauri/src/sidecar.rs::index_html). It is the ONLY desktop-specific
// renderer code in Phase 0 and intentionally does NOT modify www/app.js: it
// adds a ⚙ settings button to the header, a settings overlay (backend URL,
// connection test, paste-link sign-in, sign-out), and a small hint on the
// login view. Everything talks to the sidecar control plane over same-origin
// HTTP at /__sidecar/* — no Tauri IPC is used, so the bridge is portable.

const $ = (id) => document.getElementById(id);

async function sid(path, opts = {}) {
  try {
    const r = await fetch("/__sidecar/" + path, opts);
    let data = null;
    try { data = await r.json(); } catch {}
    return { ok: r.ok, status: r.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: { error: String(e && e.message || e) } };
  }
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// --- Local-Ollama fetch shim (installed first, before app.js's first localhost fetch) ---
// Rewrite the web UI's direct http://localhost:11434/* calls to same-origin
// /__ollama/* so they go through the sidecar proxy. The proxy strips the
// browser Origin/Referer (Ollama 403s them) and talks to localhost server-side,
// so no OLLAMA_ORIGINS setup is needed and WebView CORS/CSP never apply.
// Covers discoverLocalModels (GET /api/tags), relayLocalModelCall
// (POST /v1/chat/completions, streaming) and startLocalPull (POST /api/pull).
(function installOllamaShim() {
  const orig = window.fetch ? window.fetch.bind(window) : null;
  if (!orig) return;
  function isOllama(u) {
    return u.port === "11434" && (u.hostname === "localhost" || u.hostname === "127.0.0.1");
  }
  window.fetch = function (input, init) {
    try {
      const raw = typeof input === "string" ? input : (input && input.url);
      if (raw) {
        const u = new URL(raw, location.origin);
        if (isOllama(u)) {
          const same = "/__ollama" + u.pathname + (u.search || "");
          if (input instanceof Request && !init) input = new Request(same, input);
          else input = same;
        }
      }
    } catch {}
    return orig(input, init);
  };
})();

// --- toolExec SSE shim (intercepts the app's EventSource to handle file-tool relay) ---
// The backend's agent loop emits a `toolExec` SSE event when it hits a local
// file tool (read_file, grep, …). app.js's tailJob owns the EventSource but
// doesn't know about toolExec. This shim wraps window.EventSource so every
// EventSource created also gets a toolExec listener: on receipt, it POSTs the
// tool call to the sidecar's /__sidecar/repos/exec, gets the observation, and
// POSTs it back to /api/conversations/:id/tool-response — parallel to how
// app.js handles modelCall. www/app.js stays unmodified.
(function installToolExecShim() {
  const OrigES = window.EventSource;
  if (!OrigES) return;
  // The backend broadcasts each toolExec to BOTH the job's per-conversation
  // tail AND the owner's global /api/events hub, so a foreground agent chat's
  // file-tool call arrives on two EventSources at once. Without dedupe the
  // shim would run runToolExec twice for the same call — two sidecar execs
  // and, for write tools (apply_patch/run_command/git_*/create_pr), two
  // approval dialogs for one call. Whichever dialog the user acted on second
  // delivered a spurious "user rejected" observation and stalled the agent
  // (the "they cancel out and don't reply" symptom). Keyed by jobId+step
  // (jobId is globally unique; step identifies the call within the run) and
  // held for the life of runToolExec so a reconnect-replay while an approval
  // is still pending doesn't start a second run either. Checked synchronously
  // before the first await so the second listener (a separate dispatch) sees
  // the key already set and skips.
  const inFlightToolExec = new Set();
  function patched(url) {
    const es = new OrigES(url);
    // Extract the conversation ID from the /api/conversations/:id/events URL,
    // as a fallback for streams that don't carry convId in every payload.
    let urlConvId = null;
    try { const m = String(url).match(/\/api\/conversations\/([^/]+)\/events/); if (m) urlConvId = decodeURIComponent(m[1]); } catch {}
    es.addEventListener("toolExec", async (e) => {
      let d = {}; try { d = JSON.parse(e.data); } catch { return; }
      if (!d.jobId || !d.tool) return;
      const key = d.jobId + ":" + (d.step ?? 0);
      if (inFlightToolExec.has(key)) return;   // another stream already picked this round up
      inFlightToolExec.add(key);
      // The global /api/events stream (multiple concurrent chats) tags every
      // payload with convId; fall back to the id parsed from the per-conv
      // stream's URL. toolExec is owned exclusively by this shim — never by
      // www/app.js — so this is the only path a background chat's tool calls
      // get routed correctly, whichever stream they arrive on.
      const convId = d.convId || urlConvId;
      try { await runToolExec(convId, d); }
      finally { inFlightToolExec.delete(key); }
    });
    return es;
  }
  // Preserve static props and prototype so instanceof checks still work.
  patched.prototype = OrigES.prototype;
  Object.defineProperty(patched, "name", { value: "EventSource" });
  window.EventSource = patched;
})();

let state = null;

async function refreshState() {
  const r = await sid("state");
  state = r.data || null;
  return state;
}

// --- Unified right-side drawer (My Work / Changes / Models / Settings / GitHub) ---
// One right-slide-in drawer (#dsDrawer) with a top-level tab strip. Each tab
// lazily mounts an existing panel's card into a panel div, preserving the element
// IDs and handlers the panel's own logic already uses — so openMyWork,
// openSessionPanel, buildOverlay (settings), buildReposOverlay (github), and the
// www/app.js Models panel all keep working unchanged; they just render inside the
// drawer instead of a standalone centered overlay. The approval dialog and the
// branch-cleanup picker stay as separate modals (transient prompts, not panels).
const DS_DRAWER_TABS = [
  { id: "mywork",   label: "My Work" },
  { id: "changes", label: "Changes" },
  { id: "models",   label: "Models" },
  { id: "settings", label: "Settings" },
  { id: "github",   label: "GitHub" },
];
let _dsDrawerTab = "changes";        // active top-level tab
let _dsModelsTabActivating = false;  // guards modelBtn.click() re-entry when the Models tab opens
let _dsChangesView = "session";      // "session" (this chat) | "all" (cross-workspace working changes)
let _dsChangesRepo = "";             // repo for the session view (the active chat's repo)
// GitHub repo list fetched by refreshGithub; shared with the filter input in
// buildReposOverlay. Module-scoped (not function-local) so a later refreshGithub
// assignment is visible to the filter handler — otherwise strict mode throws a
// ReferenceError after a successful connect and no repo rows render.
let ghReposCache = [];

function buildDrawer() {
  if ($("dsDrawer")) return;
  const overlay = el("div", "ds-drawer"); overlay.id = "dsDrawer";
  overlay.setAttribute("role", "dialog"); overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "Workspace");
  const card = el("div", "ds-drawer-card");
  const head = el("div", "ds-drawer-head");
  const h2 = el("h2", null, "My Work"); h2.id = "dsDrawerTitle";
  head.appendChild(h2);
  const x = el("button", "ds-x"); x.textContent = "×"; x.title = "Close"; x.setAttribute("aria-label", "Close");
  x.onclick = closeDrawer;
  head.appendChild(x);
  card.appendChild(head);
  const tabs = el("div", "ds-drawer-tabs"); tabs.id = "dsDrawerTabs";
  DS_DRAWER_TABS.forEach((t) => {
    const b = el("button", "ds-drawer-tab", t.label);
    b.dataset.tab = t.id;
    b.onclick = () => openDrawer(t.id);
    tabs.appendChild(b);
  });
  card.appendChild(tabs);
  const body = el("div", "ds-drawer-body"); body.id = "dsDrawerBody";
  DS_DRAWER_TABS.forEach((t) => {
    const p = el("div", "ds-drawer-panel"); p.id = "dsDrawerPanel_" + t.id;
    body.appendChild(p);
  });
  card.appendChild(body);
  overlay.appendChild(card);
  document.body.appendChild(overlay);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeDrawer(); });
  // Esc closes the drawer (and the hosted Models modal, if open). Added once.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && $("dsDrawer") && $("dsDrawer").classList.contains("open")) closeDrawer();
  });
}

function switchDrawerTab(tab) {
  _dsDrawerTab = tab;
  const tabs = $("dsDrawerTabs");
  if (tabs) tabs.querySelectorAll(".ds-drawer-tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  const body = $("dsDrawerBody");
  if (body) body.querySelectorAll(".ds-drawer-panel").forEach((p) => p.classList.toggle("active", p.id === "dsDrawerPanel_" + tab));
  const meta = DS_DRAWER_TABS.find((t) => t.id === tab);
  const h2 = $("dsDrawerTitle"); if (h2 && meta) h2.textContent = meta.label;
}

// openDrawer shows the drawer on a tab, lazily building that tab's content.
// settings/github are built once at boot into their panel divs; mywork/changes/
// models build/refresh on each open.
function openDrawer(tab) {
  buildDrawer();
  tab = tab || _dsDrawerTab || "changes";
  switchDrawerTab(tab);
  $("dsDrawer").classList.add("open");
  if (tab === "mywork") loadMyWork();
  else if (tab === "changes") openChangesPanel();
  else if (tab === "models") activateModelsPanel();
  else if (tab === "github") refreshGithub();
}

function closeDrawer() {
  const d = $("dsDrawer"); if (d) d.classList.remove("open");
  const sess = $("dsSessionOverlay"); if (sess) stopAgentMerge(sess);
  // Hide the hosted Models modal so its .open state doesn't linger off-screen.
  $("modelsModal")?.classList.remove("open");
}

// activateModelsPanel hosts the www/app.js #modelsModal inside the drawer's
// Models panel and triggers its render by clicking #modelBtn (which app.js
// listens for and turns into openModelsPanel). The _dsModelsTabActivating guard
// stops our own modelBtn listener from recursing back into openDrawer.
function activateModelsPanel() {
  const panel = $("dsDrawerPanel_models"); if (!panel) return;
  const mm = $("modelsModal");
  if (mm && mm.parentElement !== panel) panel.appendChild(mm);
  if (mm) mm.classList.add("open");
  const mb = $("modelBtn");
  if (mb && !mm.classList.contains("_dsRendered")) {
    _dsModelsTabActivating = true;
    try { mb.click(); } catch {}
    _dsModelsTabActivating = false;
    if (mm) mm.classList.add("_dsRendered");
  } else if (mb) {
    // Already rendered once: just re-render the banner/rows via the button.
    _dsModelsTabActivating = true;
    try { mb.click(); } catch {}
    _dsModelsTabActivating = false;
  }
}

function openSettings() { openDrawer("settings"); }
function closeSettings() { closeDrawer(); }

// settingsSection builds one grouped section card (the canonical drawer
// container): a bordered .ds-settings-section with a header (title + optional
// subtitle, or title-wrap + action button for the row variant) and a padded
// body. Returns {sec, body} so callers append controls into body. Used by every
// drawer tab so My Work / Changes / GitHub / Settings share one look.
function settingsSection(title, subtitle, action) {
  const sec = el("div", "ds-settings-section");
  const head = el("div", "ds-settings-section-head" + (action ? " row" : ""));
  if (action) {
    const wrap = el("div", "ds-settings-section-title-wrap");
    wrap.appendChild(el("div", "ds-settings-section-title", title));
    if (subtitle) wrap.appendChild(el("div", "ds-settings-section-sub", subtitle));
    head.appendChild(wrap);
    head.appendChild(action);
  } else {
    head.appendChild(el("div", "ds-settings-section-title", title));
    if (subtitle) head.appendChild(el("div", "ds-settings-section-sub", subtitle));
  }
  sec.appendChild(head);
  const body = el("div", "ds-settings-section-body");
  sec.appendChild(body);
  return { sec, body };
}

function buildOverlay() {
  if ($("desktopSettings")) return;
  // The settings card lives inside the drawer's Settings panel (built once),
  // grouped into Account / Connection / Local models / SSH hosts / Updates
  // sections so each concern has a clear header and body. Element IDs are
  // unchanged from the old flat layout so the handlers below keep working.
  const panel = $("dsDrawerPanel_settings");
  if (!panel) return; // drawer not built yet (boot builds the drawer first)
  const card = el("div", "ds-card");
  card.id = "desktopSettings";

  // --- Account: authed shows email + Sign out; guest shows magic-link sign-in ---
  const acct = settingsSection("Account");
  const authedView = el("div", "ds-account-row hidden"); authedView.id = "dsAccountAuthed";
  const emailEl = el("div", "ds-account-email"); emailEl.id = "dsAccountEmail";
  const logoutBtn = el("button", "ds-btn ds-btn-ghost", "Sign out");
  authedView.appendChild(emailEl); authedView.appendChild(logoutBtn);
  acct.body.appendChild(authedView);
  const guestView = el("div"); guestView.id = "dsAccountGuest";
  guestView.appendChild(el("div", "ds-note", "Click “Send link” in the app to get a sign-in email, then paste the link from that email here to sign the desktop app in."));
  const linkRow = el("div", "ds-row");
  const linkInput = document.createElement("input");
  linkInput.id = "dsVerifyUrl"; linkInput.type = "url";
  linkInput.placeholder = "https://chat.selected.systems/api/auth/verify?token=…";
  const signInBtn = el("button", "ds-btn", "Sign in");
  linkRow.appendChild(linkInput); linkRow.appendChild(signInBtn);
  guestView.appendChild(linkRow);
  acct.body.appendChild(guestView);
  const authOut = el("div", "ds-note"); authOut.id = "dsAuthOut";
  acct.body.appendChild(authOut);
  card.appendChild(acct.sec);

  // --- Connection: NAS backend URL + Save/Test ---
  const conn = settingsSection("Connection", "Where the desktop app reaches the NAS backend.");
  const urlRow = el("div", "ds-row");
  const urlInput = document.createElement("input");
  urlInput.id = "dsBackendUrl"; urlInput.type = "url";
  urlInput.placeholder = "https://chat.selected.systems";
  const saveBtn = el("button", "ds-btn", "Save");
  const testBtn = el("button", "ds-btn ds-btn-ghost", "Test");
  urlRow.appendChild(urlInput); urlRow.appendChild(saveBtn); urlRow.appendChild(testBtn);
  conn.body.appendChild(urlRow);
  const testOut = el("div", "ds-note"); testOut.id = "dsTestOut";
  conn.body.appendChild(testOut);
  card.appendChild(conn.sec);

  // --- Local models: Ollama status + Start/Stop (/__sidecar/ollama/*) ---
  const ollama = settingsSection("Local models", "Ollama on this computer (localhost:11434).");
  const ollamaOut = el("div", "ds-note");
  ollama.body.appendChild(ollamaOut);
  const ollamaRow = el("div", "ds-row");
  const startOllama = el("button", "ds-btn", "Start Ollama");
  const stopOllama = el("button", "ds-btn ds-btn-ghost", "Stop Ollama");
  ollamaRow.appendChild(startOllama); ollamaRow.appendChild(stopOllama);
  ollama.body.appendChild(ollamaRow);
  card.appendChild(ollama.sec);
  async function refreshOllama() {
    const r = await sid("ollama/status"); const d = (r && r.data) || {};
    if (d.running) {
      const n = (d.models && d.models.length) || 0;
      ollamaOut.textContent = `Running — ${n} model${n === 1 ? "" : "s"} (port ${d.port})`;
    } else if (d.installed) {
      ollamaOut.textContent = "Not running. Click Start to launch Ollama.";
    } else {
      ollamaOut.textContent = "Not installed. Install from https://ollama.com, then reopen the app.";
    }
    startOllama.disabled = !!d.running || !d.installed;
    stopOllama.disabled = !d.running;
  }
  startOllama.onclick = async () => {
    startOllama.disabled = true; ollamaOut.textContent = "Starting…";
    const r = await sid("ollama/start", { method: "POST" }); const d = (r && r.data) || {};
    if (d.ok) {
      ollamaOut.textContent = "Started. Reloading…";
      try { sessionStorage.setItem("nasllm-ollama-reloaded", "1"); } catch {}
      setTimeout(() => location.reload(), 700);
    } else {
      ollamaOut.textContent = "Failed: " + (d.error || r.status);
      refreshOllama();
    }
  };
  stopOllama.onclick = async () => {
    stopOllama.disabled = true; ollamaOut.textContent = "Stopping…";
    await sid("ollama/stop", { method: "POST" });
    refreshOllama();
  };
  refreshOllama();

  // --- SSH hosts + Updates: their own leading .ds-label is dropped (the section
  // head carries the title); the rest appends into the section body. ---
  const ssh = settingsSection("SSH hosts");
  addSSHHostsSection(ssh.body);
  card.appendChild(ssh.sec);

  const upd = settingsSection("Updates", "Check for and install desktop app updates.");
  addUpdatesSection(upd.body);
  card.appendChild(upd.sec);

  panel.appendChild(card);

  saveBtn.onclick = async () => {
    const url = urlInput.value.trim();
    if (!url) { testOut.textContent = "Enter a URL."; return; }
    saveBtn.disabled = true;
    const r = await sid("backend", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }) });
    saveBtn.disabled = false;
    if (r.ok) { testOut.textContent = "Saved. Reloading…"; setTimeout(() => location.reload(), 600); }
    else testOut.textContent = "Failed: " + ((r.data && r.data.error) || r.status);
  };

  testBtn.onclick = async () => {
    const url = urlInput.value.trim() || (state && state.backend_url);
    if (!url) { testOut.textContent = "Enter a URL."; return; }
    testBtn.disabled = true; testOut.textContent = "Testing…";
    const r = await sid("test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }) });
    testBtn.disabled = false;
    const d = r.data || {};
    testOut.textContent = d.ok ? `Reachable (${d.latency_ms} ms)` : "Not reachable: " + (d.error || r.status);
  };

  signInBtn.onclick = async () => {
    const url = linkInput.value.trim();
    if (!url) { authOut.textContent = "Paste the sign-in link from your email."; return; }
    signInBtn.disabled = true; authOut.textContent = "Signing in…";
    const r = await sid("verify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }) });
    signInBtn.disabled = false;
    const d = r.data || {};
  if (d.ok) { authOut.textContent = "Signed in as " + (d.email || "?") + (d.backend_url ? " (backend " + d.backend_url + ")" : "") + ". Reloading…"; setTimeout(() => location.reload(), 600); }
    else authOut.textContent = "Failed: " + (d.error || r.status);
  };

  logoutBtn.onclick = async () => {
    logoutBtn.disabled = true; authOut.textContent = "Signing out…";
    await sid("logout", { method: "POST" });
    logoutBtn.disabled = false;
    authOut.textContent = "Signed out. Reloading…";
    setTimeout(() => location.reload(), 400);
  };
}

function fillOverlay() {
  if (!state) return;
  const u = $("dsBackendUrl");
  if (u && !u.value) u.value = state.backend_url || "";
  // Account section: show the authed or guest view from the current state.
  // The email lives in #dsAccountEmail; #dsAuthOut carries transient status
  // (Signing in…/Failed:…) only, so clear it when authed.
  const authed = $("dsAccountAuthed"), guest = $("dsAccountGuest");
  if (authed && guest) {
    authed.classList.toggle("hidden", !state.authed);
    guest.classList.toggle("hidden", !!state.authed);
  }
  const emailEl = $("dsAccountEmail");
  if (emailEl && state.authed) emailEl.textContent = state.email || "?";
  const a = $("dsAuthOut");
  if (a) a.textContent = state.authed ? "" : "Not signed in.";
}

// --- SSH hosts section (allowlist for the agent's ssh_* tools) ---
// The agent can target only aliases the user registers here. Each alias resolves
// via the desktop's ~/.ssh/config — no credentials are stored in the app. Hosts
// are persisted backend-side (per user) via the /api/* reverse proxy, so they're
// shared across devices. Add/remove updates the agent tool menu live on reload.
function addSSHHostsSection(card) {
  card.appendChild(el("div", "ds-note", "Allowlist of SSH aliases the agent may target. Each resolves via your ~/.ssh/config — no credentials are stored in the app."));
  const list = el("div");
  card.appendChild(list);
  const addRow = el("div", "ds-row");
  const aliasInput = document.createElement("input");
  aliasInput.type = "text"; aliasInput.placeholder = "alias (e.g. nas)"; aliasInput.style.flex = "1";
  const descInput = document.createElement("input");
  descInput.type = "text"; descInput.placeholder = "description (optional)"; descInput.style.flex = "2";
  const addBtn = el("button", "ds-btn", "Add");
  addRow.appendChild(aliasInput); addRow.appendChild(descInput); addRow.appendChild(addBtn);
  card.appendChild(addRow);
  const out = el("div", "ds-note"); card.appendChild(out);

  async function loadHosts() {
    list.innerHTML = "";
    out.textContent = "";
    let hosts = [];
    try {
      const r = await fetch("/api/agent/ssh-hosts", { headers: { "Accept": "application/json" } });
      if (r.ok) hosts = await r.json();
    } catch (e) { out.textContent = "Could not load SSH hosts: " + String(e && e.message || e); return; }
    if (!Array.isArray(hosts) || !hosts.length) {
      list.appendChild(el("div", "ds-note", "No SSH hosts yet. Add one to enable the agent's SSH tools."));
      return;
    }
    for (const h of hosts) {
      const row = el("div", "ds-row");
      const lbl = el("div", "ds-note"); lbl.style.flex = "1";
      lbl.textContent = h.alias + (h.description ? " — " + h.description : "");
      row.appendChild(lbl);
      const del = el("button", "ds-btn ds-btn-ghost", "Remove");
      del.onclick = async () => {
        del.disabled = true;
        try {
          const r = await fetch("/api/agent/ssh-hosts/" + encodeURIComponent(h.alias), { method: "DELETE" });
          if (r.ok) loadHosts(); else out.textContent = "Failed: " + r.status;
        } catch (e) { out.textContent = "Failed: " + String(e && e.message || e); }
        finally { del.disabled = false; }
      };
      row.appendChild(del);
      list.appendChild(row);
    }
  }

  addBtn.onclick = async () => {
    const alias = aliasInput.value.trim();
    const description = descInput.value.trim();
    if (!alias) { out.textContent = "Enter an alias."; return; }
    addBtn.disabled = true; out.textContent = "";
    try {
      const r = await fetch("/api/agent/ssh-hosts", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ alias, description })
      });
      if (r.ok) { aliasInput.value = ""; descInput.value = ""; loadHosts(); }
      else { const d = await r.json().catch(() => ({})); out.textContent = "Failed: " + ((d && d.error) || r.status); }
    } catch (e) { out.textContent = "Failed: " + String(e && e.message || e); }
    finally { addBtn.disabled = false; }
  };

  loadHosts();
}

// --- Updates section (in-app updater) ---
// Shows the current app version, a Check-for-updates button that fetches the
// latest release + its notes from the updater endpoint, and an on-click
// "Update to latest" that downloads + installs + relaunches. Talks to the
// Tauri commands in updater.rs over IPC; degrades gracefully when IPC isn't
// available (e.g. served outside the installed app).
function addUpdatesSection(card) {
  const versionOut = el("div", "ds-note");
  card.appendChild(versionOut);
  const row = el("div", "ds-row");
  const checkBtn = el("button", "ds-btn", "Check for updates");
  const updateBtn = el("button", "ds-btn ds-btn-approve", "Update to latest");
  updateBtn.disabled = true;
  row.appendChild(checkBtn); row.appendChild(updateBtn);
  card.appendChild(row);
  const out = el("div", "ds-note"); out.id = "dsUpdateOut";
  card.appendChild(out);

  // Current version (best-effort; unknown when not running in Tauri).
  (async () => {
    try {
      const v = await tauriInvoke("app_version");
      versionOut.textContent = "Current version: " + v;
    } catch {
      versionOut.textContent = "Current version: (unknown outside the desktop app)";
    }
  })();

  checkBtn.onclick = async () => {
    checkBtn.disabled = true; out.textContent = "Checking…";
    try {
      const r = await tauriInvoke("check_for_updates");
      out.innerHTML = "";
      if (r && r.available) {
        const head = el("div", "ds-note");
        head.style.color = "#c7ccd4";
        head.textContent = "Latest: " + r.version + (r.date ? " (published " + String(r.date).slice(0, 10) + ")" : "");
        out.appendChild(head);
        if (r.body && String(r.body).trim()) {
          const wrap = el("div", "ds-update-notes");
          const pre = document.createElement("pre");
          pre.className = "ds-approval-pre";
          pre.textContent = r.body;
          wrap.appendChild(pre);
          out.appendChild(wrap);
        }
        updateBtn.disabled = false;
      } else {
        out.appendChild(el("div", "ds-note", "You're on the latest version" + (r && r.currentVersion ? " (" + r.currentVersion + ")." : ".")));
        updateBtn.disabled = true;
      }
      checkBtn.textContent = "Recheck";
    } catch (e) {
      out.textContent = "Could not check for updates: " + String(e && e.message || e);
    } finally {
      checkBtn.disabled = false;
    }
  };

  updateBtn.onclick = async () => {
    updateBtn.disabled = true; out.textContent = "Starting download…";
    let unlisten = null;
    try {
      unlisten = await tauriListen("update://progress", (pct) => {
        out.textContent = "Downloading… " + pct + "%";
      });
      await tauriInvoke("download_and_install_update");
      out.textContent = "Installed. Restarting…";
    } catch (e) {
      out.textContent = "Update failed: " + String(e && e.message || e);
      updateBtn.disabled = false;
    } finally {
      if (unlisten) try { unlisten(); } catch {}
    }
  };
}

// Resolve a conversation's display title for the approval dialog and
// notifications. Uses the branch rail's cached workspace maps; refreshes once
// if the id isn't found (e.g. a chat created after boot).
async function titleForConv(convId) {
  if (!convId) return "";
  let conv = railMaps.convById.get(convId);
  if (!conv) { await loadWorkspaceMaps(); conv = railMaps.convById.get(convId); }
  return (conv && conv.title) || "";
}

// Run one file-tool call via the sidecar. Write tools (apply_patch, run_command,
// write_file, edit_file, move_path) require per-invocation approval: the sidecar
// returns {needs_approval:true} with a preview; we show an approval dialog and
// only re-POST with approved:true once the user clicks Approve. On Reject, we
// post a rejection as the observation so the agent loop can adjust. Read tools
// run immediately.
// d.branch (from the toolExec payload, sourced from conversations.repo_branch)
// is passed straight through to the sidecar so the tool runs in THIS chat's
// worktree, not whichever tree happens to be checked out — dropping it would
// silently send a background chat's edits into the wrong tree.
// Write tools that auto-approve covers run immediately (no dialog) when the
// backend says auto-approve is on for this chat. delete_path, create_pr, and
// merge_pr are never in this set — they are destructive/external/irreversible,
// so they always prompt regardless of the auto-approve setting.
const AUTO_APPROVE_TOOLS = new Set(["apply_patch", "run_command", "git_commit", "git_push", "write_file", "edit_file", "move_path"]);
// Command-shaped tools render a Warp-style block; run_command additionally streams.
const COMMAND_TOOLS = new Set(["run_command", "apply_patch", "git_commit", "git_push", "create_pr", "merge_pr", "pr_comment", "pr_close", "pr_ready", "pr_edit", "create_repo", "link_remote", "write_file", "edit_file", "move_path", "delete_path", "ssh_run"]);
// Keep last ~64KB of streamed command output for the observation / block body.
const STREAM_OUTPUT_CAP = 65536;
function capStreamOutput(s){ s = String(s||""); return s.length > STREAM_OUTPUT_CAP ? s.slice(-STREAM_OUTPUT_CAP) : s; }
// sidExec is the buffered POST to a sidecar exec endpoint (the non-streaming
// path, used for every tool except an approved run_command/ssh_run). The
// endpoint is /__sidecar/repos/exec for repo file tools or /__sidecar/ssh/exec
// for ssh_* tools.
async function sidExec(endpoint, execBody) {
  try {
    const r = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(execBody) });
    return await r.json();
  } catch (err) {
    return { observation: String(err && err.message || err), preview: "exec error", is_error: true };
  }
}

async function runToolExec(convId, d) {
  const autoApproved = !!(d.autoApprove && AUTO_APPROVE_TOOLS.has(d.tool));
  const key = d.jobId + ":" + (d.step ?? 0);
  const isSsh = d.tool.startsWith("ssh_");
  // Tasks Pill tools are handled in-renderer: they update the conversation's
  // todos directly via PATCH, not via the sidecar file-tool relay. Intercept
  // before the SSH/repo branch and post the observation back, then refresh the
  // pill so the new checklist shows immediately.
  if (d.tool === "todo_write" || d.tool === "todo_read") {
    const obs = await runTodoTool(convId, d);
    try {
      await fetch("/api/conversations/" + encodeURIComponent(convId) + "/tool-response", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: d.jobId, observation: obs.observation || "", preview: obs.preview || "", isError: !!obs.is_error })
      });
    } catch {}
    if (!convId || convId === getActiveConvId()) { refreshRailState(); renderTasksPill(); }
    return;
  }

  // Build the exec body + endpoints for the tool family. SSH tools target a
  // ~/.ssh/config alias (host) and use the sidecar's /__sidecar/ssh/exec routes;
  // repo file tools target a bound repo and use /__sidecar/repos/exec. ssh_run
  // is never auto-approved (not in AUTO_APPROVE_TOOLS) — it always prompts.
  let execBody, bufferedUrl, streamUrl;
  if (isSsh) {
    execBody = { host: d.host || "", tool: d.tool, args: d.args || "" };
    if (d.runCommandTimeoutMs) execBody.run_command_timeout_ms = d.runCommandTimeoutMs;
    bufferedUrl = "/__sidecar/ssh/exec";
    streamUrl = "/__sidecar/ssh/exec/stream";
  } else {
    execBody = { repo: d.repo, tool: d.tool, args: d.args || "" };
    if (d.branch) execBody.branch = d.branch;
    if (d.runCommandTimeoutMs) execBody.run_command_timeout_ms = d.runCommandTimeoutMs;
    bufferedUrl = "/__sidecar/repos/exec";
    streamUrl = "/__sidecar/repos/exec/stream";
  }
  if (autoApproved) execBody.approved = true;

  let execRes;
  if (autoApproved && d.tool === "run_command") {
    // Auto-approved run_command: stream output straight into the block.
    execRes = await runStreamingExec(convId, d, key, { ...execBody, approved: true }, streamUrl);
  } else {
    // First (buffered) call — returns needs_approval + preview for write tools.
    execRes = await sidExec(bufferedUrl, execBody);
    if (execRes && execRes.needs_approval) {
      const title = await titleForConv(convId);
      const ctx = isSsh
        ? { host: d.host, title }
        : { repo: d.repo, branch: d.branch || (await branchForRepo(d.repo)), title };
      const kind = execRes.approval_kind || d.tool;
      const preview = execRes.approval_preview || "";
      // Inline approval in the command block when it's on screen; fall back to
      // the FIFO modal for background chats whose block isn't in the DOM.
      const approved = await requestApprovalInlineOrModal(key, kind, preview, ctx);
      if (!approved) {
        execRes = { observation: "The user rejected this " + d.tool + " call. Do not retry it; adjust your approach.", preview: "rejected", is_error: true };
      } else if (d.tool === "run_command" || d.tool === "ssh_run") {
        execRes = await runStreamingExec(convId, d, key, { ...execBody, approved: true }, streamUrl);
      } else {
        execRes = await sidExec(bufferedUrl, { ...execBody, approved: true });
      }
    }
  }

  // Derive exit code + output for buffered command tools (the streaming path
  // already carries them) so the Warp-style block shows a proper exit chip +
  // output body on reload.
  if (execRes && COMMAND_TOOLS.has(d.tool)) {
    if (execRes.exit_code == null) execRes.exit_code = execRes.is_error ? 1 : 0;
    if (!execRes.output && execRes.observation) execRes.output = capStreamOutput(execRes.observation);
  }

  // Post the observation back to the backend so the agent loop continues.
  const preview = execRes.preview || "";
  const postedPreview = autoApproved && preview ? preview + " (auto-approved)" : preview;
  const body = { jobId: d.jobId, observation: execRes.observation || "", preview: postedPreview, isError: !!execRes.is_error };
  if (execRes.exit_code != null) body.exitCode = execRes.exit_code;
  if (execRes.output) body.output = execRes.output;
  if (d.branch) body.branch = d.branch;
  try {
    await fetch("/api/conversations/" + encodeURIComponent(convId) + "/tool-response", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
  } catch {}
  if (!convId || convId === getActiveConvId()) refreshRailState();
}

// showApprovalDialog returns a Promise<boolean> — true if the user clicks
// Approve, false if Reject.
//
// Concurrent chats can each hit an approval-gated tool at the same time, so
// requests are queued FIFO and shown one at a time — sharing a single overlay
// across simultaneous requests would let a click meant for one approve/reject
// the other. dsApprovalQueue holds pending {kind, preview, ctx, resolve}
// entries; dsApprovalBusy is true while one is on screen.
let dsApprovalQueue = [];
let dsApprovalBusy = false;

function showApprovalDialog(kind, preview, ctx) {
  return new Promise((resolve) => {
    dsApprovalQueue.push({ kind, preview, ctx, resolve });
    pumpApprovalQueue();
  });
}

function pumpApprovalQueue() {
  if (dsApprovalBusy) return;
  const next = dsApprovalQueue.shift();
  if (!next) return;
  dsApprovalBusy = true;
  renderApprovalDialog(next.kind, next.preview, next.ctx, (val) => {
    dsApprovalBusy = false;
    next.resolve(val);
    pumpApprovalQueue();
  });
}

// Builds the overlay once and reuses it for every subsequent approval — but
// re-wires the resolver AND both button handlers on EVERY call. The previous
// version wired overlay._close, approve.onclick and reject.onclick only
// inside the `if (!overlay)` branch, so the second approval of a session
// resolved the FIRST (already-settled) promise through the stale closure and
// its own promise never settled — the agent then hung until the tool-exec
// timeout. dsConfirm hit the identical bug and was fixed the same way: never
// trust a resolver captured at dialog-creation time once the dialog is reused.
// Renders the requesting chat's title (when known) above the existing
// `tool → owner/repo @ branch` line, so a concurrent second chat's approval
// doesn't get mistaken for the one you were expecting.
function renderApprovalDialog(kind, preview, ctx, done) {
  let overlay = $("dsApprovalOverlay");
  if (!overlay) {
    overlay = el("div", "ds-overlay");
    overlay.id = "dsApprovalOverlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "Approve tool call");
    const card = el("div", "ds-card ds-card-wide");
    const head = el("div", "ds-head");
    head.appendChild(el("h2", null, "Approve tool call"));
    const x = el("button", "ds-x"); x.id = "dsApprovalClose"; x.textContent = "×"; x.title = "Reject"; x.setAttribute("aria-label", "Reject");
    head.appendChild(x);
    card.appendChild(head);
    const chatLabel = el("div", "ds-approval-chat"); chatLabel.id = "dsApprovalChat";
    card.appendChild(chatLabel);
    card.appendChild(el("div", "ds-label", "Tool"));
    const kindVal = el("div", "ds-approval-kind"); kindVal.id = "dsApprovalKind";
    card.appendChild(kindVal);
    const preWrap = el("div", "ds-approval-pre-wrap"); preWrap.id = "dsApprovalPre";
    card.appendChild(preWrap);
    const row = el("div", "ds-row ds-approval-row");
    const reject = el("button", "ds-btn ds-btn-ghost", "Reject"); reject.id = "dsApprovalReject";
    const approve = el("button", "ds-btn ds-btn-approve", "Approve"); approve.id = "dsApprovalApprove";
    row.appendChild(reject); row.appendChild(approve);
    card.appendChild(row);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
  }
  // Re-wire on every call — onclick/overlay.onclick assignment replaces the
  // previous handler (no accumulation), so repeated calls never leak
  // listeners while always resolving THIS call's promise.
  overlay._close = (val) => { overlay.classList.remove("open"); done(val); };
  $("dsApprovalClose").onclick = () => overlay._close(false);
  $("dsApprovalReject").onclick = () => overlay._close(false);
  $("dsApprovalApprove").onclick = () => overlay._close(true);
  overlay.onclick = (e) => { if (e.target === overlay) overlay._close(false); };
  const chatLabel = $("dsApprovalChat");
  const chatText = (ctx && ctx.title) ? ("Chat: " + ctx.title) : "";
  chatLabel.textContent = chatText;
  chatLabel.classList.toggle("hidden", !chatText);
  const kindText = (ctx && (ctx.repo || ctx.host)) ? (kind + " → " + (ctx.repo || ctx.host) + (ctx.branch ? " @ " + ctx.branch : "")) : kind;
  $("dsApprovalKind").textContent = kindText;
  renderApprovalContent($("dsApprovalPre"), kind, preview);
  overlay.classList.add("open");
}

// renderApprovalContent fills the scrollable container with either a
// line-by-line colored diff (for apply_patch and the create/edit/move file tools,
// whose sidecar previews are unified diffs) or a raw <pre> (for run_command and
// anything that isn't a unified diff). The diff parser splits on newlines,
// classifies each line, and builds a DOM fragment with red/green gutters.
const DIFF_PREVIEW_TOOLS = new Set(["apply_patch", "write_file", "edit_file", "move_path"]);
function renderApprovalContent(container, kind, preview) {
  container.innerHTML = "";
  if (DIFF_PREVIEW_TOOLS.has(kind) && preview.includes("@@")) {
    container.appendChild(renderDiff(preview));
    return;
  }
  const pre = document.createElement("pre");
  pre.className = "ds-approval-pre";
  if (kind === "create_pr") {
    // The sidecar's approval preview for create_pr is the PR title + body.
    // Best-effort: format {title, body} JSON as "Title\n\nBody"; fall back to raw.
    let txt = preview;
    try { const j = JSON.parse(preview); if (j && typeof j === "object") txt = (j.title || "") + "\n\n" + (j.body || ""); } catch {}
    pre.textContent = txt;
  } else {
    pre.textContent = preview;
  }
  container.appendChild(pre);
}

// renderDiff parses a unified diff string and returns a DOM node with
// file-header, hunk-header, added (+), removed (-), and context (space)
// lines styled individually. Lines it can't classify are shown as plain text.
function renderDiff(diff) {
  const wrap = el("div", "ds-diff");
  const lines = diff.split("\n");
  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      const fh = el("div", "ds-diff-file", line);
      wrap.appendChild(fh);
    } else if (line.startsWith("@@")) {
      const hh = el("div", "ds-diff-hunk", line);
      wrap.appendChild(hh);
    } else if (line.startsWith("+")) {
      const ln = el("div", "ds-diff-add", line);
      wrap.appendChild(ln);
    } else if (line.startsWith("-")) {
      const ln = el("div", "ds-diff-del", line);
      wrap.appendChild(ln);
    } else if (line.startsWith(" ")) {
      const ln = el("div", "ds-diff-ctx", line);
      wrap.appendChild(ln);
    } else {
      const ln = el("div", "ds-diff-plain", line);
      wrap.appendChild(ln);
    }
  }
  return wrap;
}

// --- Streaming exec (run_command) + inline approval -------------------------
// runStreamingExec POSTs the approved run_command to the sidecar's streaming
// route and pipes stdout+stderr to the UI as nasllm:toolOutput chunks, then a
// terminal nasllm:toolExit with the exit code + duration — so the Warp-style
// command block fills live. Returns a buffered ExecResult-shaped object
// (observation/output/exit_code/is_error) so runToolExec can post it to
// /tool-response exactly like the buffered path.
// runTodoTool handles the Tasks Pill tools in-renderer (no sidecar round-trip).
// todo_write PATCHes the conversation's todos; todo_read returns the cached
// checklist as the observation. Keeps the sidecar out of conversation state.
async function runTodoTool(convId, d) {
  if (d.tool === "todo_write") {
    let todos = [];
    try { const j = JSON.parse(d.args || "{}"); if (Array.isArray(j.todos)) todos = j.todos; } catch { return { observation: "Invalid args for todo_write.", preview: "bad args", is_error: true }; }
    try {
      const r = await fetch("/api/conversations/" + encodeURIComponent(convId), { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ todos }) });
      if (!r.ok) return { observation: "Could not save the task checklist.", preview: "save failed", is_error: true };
      const conv = railMaps.convById.get(convId);
      if (conv) { conv.todos = todos; if (railConvId === convId) railConv = conv; }
      renderTasksPill();
      return { observation: "Updated the session task checklist (" + todos.length + " item" + (todos.length === 1 ? "" : "s") + ").", preview: "tasks updated" };
    } catch (e) { return { observation: String((e && e.message) || e), preview: "save error", is_error: true }; }
  }
  // todo_read
  let conv = railMaps.convById.get(convId);
  if (!conv) { await loadWorkspaceMaps(); conv = railMaps.convById.get(convId); }
  const todos = (conv && Array.isArray(conv.todos)) ? conv.todos : [];
  if (!todos.length) return { observation: "No tasks in this session's checklist yet.", preview: "no tasks" };
  const lines = todos.map((t, i) => (i + 1) + ". [" + (t.status || "pending") + "] " + (t.text || ""));
  return { observation: "Session tasks:\n" + lines.join("\n"), preview: todos.length + " tasks" };
}

// --- Tasks Pill + Plan Pill (below/around the composer) ---
// ensureTasksPill creates the collapsible checklist pill below the composer
// input (desktop-only) if it isn't already present. Lives inside .composer,
// after the composer status line.
function ensureTasksPill() {
  let pill = $("dsTasksPill");
  if (pill) return;
  const composer = document.querySelector(".composer");
  if (!composer) return;
  pill = el("div", "ds-tasks-pill");
  pill.id = "dsTasksPill";
  const head = el("div", "ds-tasks-pill-head");
  head.appendChild(el("span", "ds-tasks-pill-chev", "▸"));
  head.appendChild(el("span", "ds-tasks-pill-title", "Tasks"));
  const count = el("span", "ds-note"); count.id = "dsTasksPillCount";
  head.appendChild(count);
  head.onclick = () => { pill.classList.toggle("expanded"); };
  pill.appendChild(head);
  const body = el("div", "ds-tasks-pill-body"); body.id = "dsTasksPillBody";
  pill.appendChild(body);
  composer.appendChild(pill);
}
// renderTasksPill fills the pill with the active conversation's todos (if any).
// Hidden when there are no todos or no active chat. Collapsible.
function renderTasksPill() {
  const pill = $("dsTasksPill");
  if (!pill) return;
  const body = $("dsTasksPillBody");
  const count = $("dsTasksPillCount");
  const conv = railConv;
  const todos = (conv && Array.isArray(conv.todos)) ? conv.todos : [];
  if (!todos.length) { pill.classList.add("hidden"); if (body) body.innerHTML = ""; if (count) count.textContent = ""; return; }
  pill.classList.remove("hidden");
  if (count) count.textContent = " · " + todos.filter((t) => t.status === "completed").length + "/" + todos.length;
  if (!body) return;
  body.innerHTML = "";
  todos.forEach((t) => {
    const row = el("div", "ds-task-item");
    const mark = el("span", "ds-task-mark " + (t.status === "completed" ? "done" : t.status === "in_progress" ? "active" : ""), t.status === "completed" ? "✓" : t.status === "in_progress" ? "…" : "○");
    row.appendChild(mark);
    row.appendChild(el("span", "ds-task-text", t.text || ""));
    body.appendChild(row);
  });
}

// renderPlanPill adds a Plan chip to the composer status line when the active
// conversation is in plan mode. Before approval it shows "Plan · awaiting approval";
// after approval it shows "Plan · approved". Clicking opens a small popover with
// the plan text and (before approval) an Approve button that PATCHes planApproved.
function renderPlanPill(status) {
  if (!status) return;
  // Remove a stale plan chip first so a non-plan chat doesn't keep it.
  const old = status.querySelector(".ds-plan-chip");
  const conv = railConv;
  if (!conv || !conv.planMode) { if (old) old.remove(); return; }
  const approved = !!conv.planApproved;
  let chip = old;
  if (!chip) {
    chip = el("span", "ds-plan-chip");
    chip.onclick = (e) => { e.stopPropagation(); openPlanPopover(); };
    status.appendChild(chip);
  }
  chip.textContent = approved ? "Plan · approved" : "Plan · awaiting approval";
  chip.title = approved ? "Plan approved. Click to view it."
    : "Plan mode: the agent is researching and planning. Click to view the plan draft and approve it.";
  chip.classList.toggle("approved", approved);
}
// openPlanPopover shows the plan text + an Approve button (before approval).
function openPlanPopover() {
  const conv = railConv;
  if (!conv) return;
  let overlay = $("dsPlanOverlay");
  if (!overlay) {
    overlay = el("div", "ds-overlay");
    overlay.id = "dsPlanOverlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "Plan");
    const card = el("div", "ds-card ds-card-wide");
    const head = el("div", "ds-head");
    head.appendChild(el("h2", null, "Plan"));
    const x = el("button", "ds-x"); x.textContent = "×"; x.title = "Close"; x.setAttribute("aria-label", "Close");
    x.onclick = () => overlay.classList.remove("open");
    head.appendChild(x);
    card.appendChild(head);
    const body = el("div", "ds-plan-body"); body.id = "dsPlanBody";
    card.appendChild(body);
    const row = el("div", "ds-row ds-approval-row");
    const approveBtn = el("button", "ds-btn ds-btn-approve", "Approve plan"); approveBtn.id = "dsPlanApprove";
    row.appendChild(approveBtn);
    card.appendChild(row);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.classList.remove("open"); });
    approveBtn.onclick = async () => {
      if (!railConvId) return;
      approveBtn.disabled = true; approveBtn.textContent = "Approving…";
      try {
        const r = await fetch("/api/conversations/" + encodeURIComponent(railConvId), { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ planApproved: true }) });
        if (r.ok) { const updated = await r.json().catch(() => null); if (updated && updated.id) { railMaps.convById.set(railConvId, updated); railConv = updated; } flashDsOk("Plan approved — implementation unlocked ✓"); overlay.classList.remove("open"); renderComposerStatus(); }
        else flashDsErr("Could not approve the plan.");
      } catch (e) { flashDsErr(String((e && e.message) || e)); }
      finally { approveBtn.disabled = false; approveBtn.textContent = "Approve plan"; }
    };
  }
  const bodyEl = $("dsPlanBody");
  if (bodyEl) bodyEl.textContent = (conv && conv.plan) || "(no plan yet)";
  const approveBtn = $("dsPlanApprove");
  if (approveBtn) approveBtn.style.display = (conv && conv.planApproved) ? "none" : "";
  overlay.classList.add("open");
}

async function runStreamingExec(convId, d, key, execBody, streamUrl) {
  let output = "", exitCode = -1, durationMs = 0;
  try {
    const r = await fetch(streamUrl, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(execBody),
    });
    await readSseStream(r, (event, data) => {
      if (event === "chunk") {
        let text = ""; try { text = (JSON.parse(data) || {}).text || ""; } catch {}
        output += text;
        if (output.length > STREAM_OUTPUT_CAP) output = output.slice(-STREAM_OUTPUT_CAP);
        window.dispatchEvent(new CustomEvent("nasllm:toolOutput", { detail: { convId, jobId: d.jobId, step: d.step, text } }));
      } else if (event === "exit") {
        let ex = {}; try { ex = JSON.parse(data); } catch {}
        exitCode = ex.code != null ? ex.code : -1;
        durationMs = ex.durationMs || 0;
        window.dispatchEvent(new CustomEvent("nasllm:toolExit", { detail: { convId, jobId: d.jobId, step: d.step, code: exitCode, durationMs } }));
      }
    });
  } catch (err) {
    return { observation: String(err && err.message || err), preview: "exec error", is_error: true };
  }
  const isErr = exitCode !== 0;
  return {
    observation: capStreamOutput(output) || (isErr ? "Command failed." : "Command completed."),
    preview: isErr ? ("exit " + exitCode) : "command completed",
    is_error: isErr,
    exit_code: exitCode,
    output: capStreamOutput(output),
  };
}

// readSseStream parses an SSE text/event-stream response body into (event,data)
// frames and calls onEvent for each. Used by runStreamingExec (fetch can't be
// an EventSource, which is GET-only — the streaming route is POST).
async function readSseStream(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let event = "message", data = "";
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) event = line.replace(/^event:\s?/, "").trim();
        else if (line.startsWith("data:")) data += line.replace(/^data:\s?/, "");
      }
      onEvent(event, data);
    }
  }
}

// requestApprovalInlineOrModal renders Approve/Reject in the command block when
// it's on screen (window.nasllm.blocks.requestApproval, with the diff for
// apply_patch rendered into the block via the same renderDiff the modal uses),
// and falls back to the FIFO modal for background chats whose block isn't in
// the DOM. Returns a Promise<boolean> — true on Approve, false on Reject.
async function requestApprovalInlineOrModal(key, kind, preview, ctx) {
  const blocks = window.nasllm && window.nasllm.blocks;
  if (blocks) {
    const previewEl = buildApprovalPreviewEl(kind, preview);
    let resolveInline;
    const inlinePromise = new Promise(res => { resolveInline = res; });
    const accepted = blocks.requestApproval(key, {
      kind, previewEl,
      onApprove: () => resolveInline(true),
      onReject: () => resolveInline(false),
    });
    if (accepted) return inlinePromise;
  }
  return showApprovalDialog(kind, preview, ctx);
}

// buildApprovalPreviewEl builds the scrollable preview node the inline approval
// renders in the block — reusing renderApprovalContent (which renders the
// diff for apply_patch via renderDiff) so the inline block and the modal share
// one diff renderer.
function buildApprovalPreviewEl(kind, preview) {
  const wrap = el("div", "ds-approval-pre-wrap");
  renderApprovalContent(wrap, kind, preview);
  return wrap;
}

// --- Tauri IPC (native folder picker) -------------------------------------
// The only Tauri IPC in the app; everything else is same-origin HTTP to the
// sidecar. withGlobalTauri is on, so window.__TAURI__.core.invoke is available.
// Fall back to __TAURI_INTERNALS__.invoke (always present) just in case.
function tauriInvoke(cmd, args) {
  const g = (typeof window !== "undefined") ? window : null;
  const inv = g && ((g.__TAURI__ && g.__TAURI__.core && g.__TAURI__.core.invoke) || (g.__TAURI_INTERNALS__ && g.__TAURI_INTERNALS__.invoke));
  if (!inv) return Promise.reject(new Error("Tauri IPC is not available (running outside the desktop app?)"));
  return inv(cmd, args || {});
}

// Listen to a Tauri event (withGlobalTauri). Returns a Promise that resolves
// to an unlisten function. Falls back to a no-op unlisten when the event API
// isn't available (e.g. running outside the installed app).
function tauriListen(event, cb) {
  const g = (typeof window !== "undefined") ? window : null;
  const listen = g && ((g.__TAURI__ && g.__TAURI__.event && g.__TAURI__.event.listen) || (g.__TAURI_INTERNALS__ && g.__TAURI_INTERNALS__.event && g.__TAURI_INTERNALS__.event.listen));
  if (!listen) return Promise.resolve(() => {});
  return Promise.resolve(listen(event, (e) => cb(e && e.payload))).then((un) => (typeof un === "function" ? un : (() => {})));
}

// --- Native completion notifications (tauri-plugin-notification) ---
// www/app.js dispatches nasllm:jobDone ({convId, title, status, error}) on
// EVERY terminal job event, watched chat or not — this is the only way a
// backgrounded chat's completion is visible without staring at it. We turn
// that into a native OS notification, called through tauriInvoke exactly
// like the existing plugin:dialog|open pattern. Permission is requested
// once, lazily, on the first completion rather than eagerly on boot, so the
// OS prompt only appears once the feature is actually used. Notification
// actions are mobile-only in Tauri, so there's no click-to-open here — the
// in-app badge (www/app.js) is the way back to the chat. Fails silently
// outside the desktop app: tauriInvoke rejects when there's no Tauri IPC,
// and the in-app toast already covers that case.
let dsNotifyPermChecked = false;
let dsNotifyPermGranted = false;

async function ensureNotifyPermission() {
  if (dsNotifyPermChecked) return dsNotifyPermGranted;
  dsNotifyPermChecked = true;
  try {
    dsNotifyPermGranted = !!(await tauriInvoke("plugin:notification|is_permission_granted"));
    if (!dsNotifyPermGranted) {
      const perm = await tauriInvoke("plugin:notification|request_permission");
      dsNotifyPermGranted = perm === "granted";
    }
  } catch {
    dsNotifyPermGranted = false;
  }
  return dsNotifyPermGranted;
}

// Suppress the notification only when the user is both looking at AND
// focused on the chat that just finished — they've already seen the result.
// A backgrounded or unfocused window still notifies even for the "active"
// chat, since that's exactly when a completion would otherwise go unnoticed.
function isConvOnScreen(convId) {
  if (!convId) return false;
  if (document.visibilityState !== "visible" || !document.hasFocus()) return false;
  return getActiveConvId() === convId;
}

window.addEventListener("nasllm:jobDone", async (e) => {
  const d = (e && e.detail) || {};
  if (isConvOnScreen(d.convId)) return;
  const title = d.status === "error" ? "Chat failed" : (d.status === "cancelled" ? "Chat cancelled" : "Chat finished");
  const body = (d.title || "Chat") + (d.status === "error" && d.error ? ": " + d.error : "");
  try {
    if (!(await ensureNotifyPermission())) return;
    await tauriInvoke("plugin:notification|notify", { options: { title, body } });
  } catch {
    // Outside the desktop app, or IPC unavailable — the in-app toast/badge
    // from www/app.js already surfaces this.
  }
});

// Open the native directory picker; returns a single absolute path, or null
// if the user cancelled. Unlike the previous version, this does NOT swallow a
// real IPC failure — callers must handle rejection so a broken picker call
// surfaces an error instead of silently doing nothing (which is exactly what
// made "Connect folder" look like it was doing nothing at all).
function pickFolder(title) {
  return tauriInvoke("plugin:dialog|open", { options: { directory: true, multiple: false, title: title || "Select repository folder" } })
    .then((res) => (Array.isArray(res) ? (res[0] || null) : (res || null)));
}

// addLocalRepo POSTs a single resolved repo path to the sidecar. Reports
// failure via flashDsErr (a page-level toast, visible regardless of which
// overlay — if any — triggered the connect). Returns true on success.
async function addLocalRepo(path) {
  const r = await sid("repos/add-local", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path }) });
  const d = (r && r.data) || {};
  if (d.ok) return true;
  flashDsErr(d.error || r.status || "Could not connect that folder.");
  return false;
}

// showConnectPicker renders a checklist of git repos found inside a picked
// parent folder (e.g. a projects directory) and lets the user choose which
// ones to connect. Returns a Promise<boolean> — true if at least one repo was
// connected successfully.
function showConnectPicker(candidates) {
  return new Promise((resolve) => {
    let overlay = $("dsConnectOverlay");
    let list, addBtn;
    if (!overlay) {
      overlay = el("div", "ds-overlay");
      overlay.id = "dsConnectOverlay";
      overlay.setAttribute("role", "dialog");
      overlay.setAttribute("aria-modal", "true");
      overlay.setAttribute("aria-label", "Connect repositories");
      const card = el("div", "ds-card");
      const head = el("div", "ds-head");
      head.appendChild(el("h2", null, "Connect repositories"));
      const x = el("button", "ds-x"); x.textContent = "×"; x.title = "Cancel"; x.setAttribute("aria-label", "Cancel");
      head.appendChild(x);
      card.appendChild(head);
      card.appendChild(el("div", "ds-note", "Found multiple git repositories in that folder. Choose which ones to connect."));
      list = el("div", "ds-connect-list"); list.id = "dsConnectList";
      card.appendChild(list);
      const row = el("div", "ds-row ds-approval-row");
      addBtn = el("button", "ds-btn", "Add selected"); addBtn.id = "dsConnectAddBtn";
      row.appendChild(addBtn);
      card.appendChild(row);
      overlay.appendChild(card);
      document.body.appendChild(overlay);
      x.onclick = () => overlay._close(false);
      overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay._close(false); });
    } else {
      list = $("dsConnectList");
      addBtn = $("dsConnectAddBtn");
    }
    overlay._close = (v) => { overlay.classList.remove("open"); resolve(v); };
    list.innerHTML = "";
    candidates.forEach((c) => {
      const row = el("label", "ds-connect-item");
      const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = true; cb.value = c.path;
      const txt = el("span", "ds-connect-item-name", c.name);
      row.appendChild(cb); row.appendChild(txt);
      list.appendChild(row);
    });
    addBtn.disabled = false; addBtn.textContent = "Add selected";
    addBtn.onclick = async () => {
      const checked = [...list.querySelectorAll("input[type=checkbox]:checked")].map((cb) => cb.value);
      if (!checked.length) { overlay._close(false); return; }
      addBtn.disabled = true; addBtn.textContent = "Adding…";
      let any = false;
      for (const path of checked) { if (await addLocalRepo(path)) any = true; }
      overlay._close(any);
    };
    overlay.classList.add("open");
  });
}

// connectFolderFlow is the single entry point for "connect a local repo":
// native folder pick -> scan for candidate repos -> add one directly or let
// the user choose from several. Returns true if at least one repo was
// connected; false on cancellation, an empty scan, or a failure — all
// failures are surfaced via flashDsErr so the picker never again looks like
// it silently did nothing.
async function connectFolderFlow() {
  let path;
  try {
    path = await pickFolder("Select a repository folder");
  } catch (e) {
    flashDsErr("Could not open the folder picker: " + String((e && e.message) || e));
    return false;
  }
  if (!path) return false; // user cancelled — no error, no-op
  let repos;
  try {
    const r = await sid("repos/scan-local", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path }) });
    const d = (r && r.data) || {};
    if (!r.ok) { flashDsErr(d.error || r.status || "Could not scan that folder."); return false; }
    repos = d.repos || [];
  } catch (e) {
    flashDsErr("Could not scan that folder: " + String((e && e.message) || e));
    return false;
  }
  if (!repos.length) { flashDsErr("No git repositories found in that folder."); return false; }
  // A single non-git candidate (the picked folder itself, when no .git was
  // found): route to the named-workspace flow so the user can name it and choose
  // whether to track it with git, instead of erroring on add-local.
  if (repos.length === 1 && repos[0].git === false) {
    return createWorkspaceForPath(repos[0].path, repos[0].name, false);
  }
  if (repos.length === 1) return addLocalRepo(repos[0].path);
  return showConnectPicker(repos);
}

// createWorkspaceForPath opens the "new workspace" dialog for a chosen folder:
// a Name input (required) + a "Track with git" checkbox. On submit it POSTs to
// /repos/create-workspace. Returns true on success. `suggestName` pre-fills the
// name (e.g. the folder basename from scan-local); `suggestGit` sets the
// checkbox default (false for a non-git folder picked via connectFolderFlow,
// true when the user opened "New workspace…" directly).
function createWorkspaceForPath(path, suggestName, suggestGit) {
  return new Promise((resolve) => {
    let overlay = $("dsWorkspaceOverlay");
    let nameInput, gitCheck, createBtn;
    if (!overlay) {
      overlay = el("div", "ds-overlay");
      overlay.id = "dsWorkspaceOverlay";
      overlay.setAttribute("role", "dialog");
      overlay.setAttribute("aria-modal", "true");
      overlay.setAttribute("aria-label", "New workspace");
      const card = el("div", "ds-card");
      const head = el("div", "ds-head");
      head.appendChild(el("h2", null, "New workspace"));
      const x = el("button", "ds-x"); x.textContent = "×"; x.title = "Cancel"; x.setAttribute("aria-label", "Cancel");
      head.appendChild(x);
      card.appendChild(head);
      card.appendChild(el("div", "ds-note", "Connect this folder as a workspace. Name it, and choose whether to track it with git (commits, branches, pull requests) or keep it as a plain folder (file tools only)."));
      card.appendChild(el("div", "ds-label", "Name"));
      nameInput = document.createElement("input"); nameInput.id = "dsWsName"; nameInput.type = "text";
      card.appendChild(nameInput);
      const gitRow = el("label", "ds-ws-check-row");
      gitCheck = document.createElement("input"); gitCheck.id = "dsWsGit"; gitCheck.type = "checkbox";
      gitRow.appendChild(gitCheck);
      gitRow.appendChild(el("span", "ds-ws-check-label", "Track with git"));
      card.appendChild(gitRow);
      const out = el("div", "ds-note"); out.id = "dsWsOut";
      card.appendChild(out);
      const btnRow = el("div", "ds-row ds-approval-row");
      createBtn = el("button", "ds-btn", "Create workspace"); createBtn.id = "dsWsCreate";
      btnRow.appendChild(createBtn);
      card.appendChild(btnRow);
      overlay.appendChild(card);
      document.body.appendChild(overlay);
      const close = (v) => { overlay.classList.remove("open"); resolve(v); };
      x.onclick = () => close(false);
      overlay.addEventListener("click", (e) => { if (e.target === overlay) close(false); });
      createBtn.onclick = async () => {
        const name = nameInput.value.trim();
        if (!name) { out.textContent = "Enter a workspace name."; return; }
        createBtn.disabled = true; createBtn.textContent = "Creating…";
        const res = await sid("repos/create-workspace", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path, name, useGit: gitCheck.checked }) });
        const d = (res && res.data) || {};
        createBtn.disabled = false; createBtn.textContent = "Create workspace";
        if (d.ok) { flashDsOk("Connected \"" + name + "\" ✓"); close(true); }
        else { out.textContent = "Failed: " + (d.error || res.status || "unknown"); }
      };
    } else {
      nameInput = $("dsWsName"); gitCheck = $("dsWsGit"); createBtn = $("dsWsCreate");
    }
    nameInput.value = suggestName || "";
    gitCheck.checked = !!suggestGit;
    const outEl = $("dsWsOut"); if (outEl) outEl.textContent = "";
    overlay.classList.add("open");
    setTimeout(() => { try { nameInput.focus(); nameInput.select(); } catch {} }, 0);
  });
}

// createWorkspaceFlow is the entry point for "New workspace…": pick a folder,
// then open the name + git dialog. Returns true if a workspace was connected.
async function createWorkspaceFlow() {
  let path;
  try {
    path = await pickFolder("Select a folder for the new workspace");
  } catch (e) {
    flashDsErr("Could not open the folder picker: " + String((e && e.message) || e));
    return false;
  }
  if (!path) return false;
  // Pre-fill the name with the folder basename; default git on (the user can
  // turn it off to keep a plain folder, or leave it on to git-init in place).
  const base = (path.split("/").pop() || "workspace").replace(/\.git$/, "");
  const ok = await createWorkspaceForPath(path, base, true);
  if (ok) refreshLocal();
  return ok;
}

// Small confirm dialog (replaces native confirm(), which the browser can block).
// Built once; re-wires the close resolver + button handlers on EVERY call so
// each promise resolves (the old version wired _close only on first creation,
// so a second confirm clicked the stale first resolver and the call hung —
// only the first delete/push/revert confirm ever worked).
function dsConfirm(message, sub) {
  return new Promise((resolve) => {
    let overlay = $("dsConfirmOverlay");
    if (!overlay) {
      overlay = el("div", "ds-overlay");
      overlay.id = "dsConfirmOverlay";
      overlay.setAttribute("role", "dialog");
      overlay.setAttribute("aria-modal", "true");
      overlay.setAttribute("aria-label", "Confirm");
      const card = el("div", "ds-card");
      const msg = el("div", "ds-note"); msg.id = "dsConfirmMsg";
      card.appendChild(msg);
      const subEl = el("div", "ds-note ds-confirm-sub"); subEl.id = "dsConfirmSub";
      card.appendChild(subEl);
      const row = el("div", "ds-row ds-approval-row");
      const ok = el("button", "ds-btn ds-btn-approve", "Yes"); ok.id = "dsConfirmOk";
      const cancel = el("button", "ds-btn ds-btn-ghost", "Cancel"); cancel.id = "dsConfirmCancel";
      row.appendChild(cancel); row.appendChild(ok);
      card.appendChild(row);
      overlay.appendChild(card);
      document.body.appendChild(overlay);
      overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay._close(false); });
    }
    // Re-wire on every call: onclick replaces (no accumulation), and the
    // backdrop listener reads overlay._close at click time so it picks up the
    // latest resolver too.
    overlay._close = (v) => { overlay.classList.remove("open"); resolve(v); };
    $("dsConfirmOk").onclick = () => overlay._close(true);
    $("dsConfirmCancel").onclick = () => overlay._close(false);
    $("dsConfirmMsg").textContent = message || "";
    $("dsConfirmSub").textContent = sub || "";
    overlay.classList.add("open");
  });
}

// Compact date for the workspace chat list (desktop.js is its own module and
// cannot see app.js's absTime).
function dsTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// Workspace data: backend repo id (by full_name) + chats attached per repo.
// Best-effort: returns empty maps when not signed in or the backend is down.
async function loadWorkspaceData() {
  const repoByFullName = new Map();
  const chatsByRepoId = new Map();
  try {
    const rr = await fetch("/api/repos");
    if (rr.ok) {
      const repos = await rr.json();
      (repos || []).forEach((rp) => { if (rp && rp.fullName) repoByFullName.set(rp.fullName, rp); });
    }
  } catch {}
  try {
    const cr = await fetch("/api/conversations");
    if (cr.ok) {
      const convs = await cr.json();
      (convs || []).forEach((c) => {
        if (c && c.repoId) {
          if (!chatsByRepoId.has(c.repoId)) chatsByRepoId.set(c.repoId, []);
          chatsByRepoId.get(c.repoId).push(c);
        }
      });
    }
  } catch {}
  return { repoByFullName, chatsByRepoId };
}

// Ensure a backend folder named `name` exists for the workspace; return its id.
async function ensureWorkspaceFolder(name) {
  try {
    const fr = await fetch("/api/folders");
    if (fr.ok) {
      const folders = await fr.json();
      const found = (folders || []).find((f) => f && f.name === name);
      if (found) return found.id;
    }
  } catch {}
  try {
    const cr = await fetch("/api/folders", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
    if (cr.ok) { const f = await cr.json(); if (f && f.id) return f.id; }
  } catch {}
  return "";
}

// --- Branch rail + no-reload navigation (desktop-only) ---
// The active conversation's id is owned by app.js (module-private). app.js
// announces it via the `nasllm:activeConv` event (dispatched by
// openConversation/newChat), which we capture in activeConvId below. A
// MutationObserver on #convList + the `nasllm:openConv` event are kept as
// fallbacks/re-triggers. The rail then polls /__sidecar/repos/state for the
// bound repo. Repo-bound chats are filtered out of #convList, so activeConvId
// (not activeConvIdFromDOM) is what makes the rail bind to a repo chat.
let railRepo = null;       // full_name of the repo the active repo-bound chat is on
let railState = null;      // last repos/state result for railRepo
let railConvId = null;     // id of the active conversation the rail is bound to
let railConv = null;       // that conversation's record (for its own repoBranch)
let railTimer = null;      // the ~5s repos/state poll interval
let railMaps = { convById: new Map(), repoById: new Map(), repoByFullName: new Map() };
let railSyncTimer = null;  // debounce for syncBranchRail
let railSwitchInFlight = false;  // guards eager folder-switch against re-entrancy

// Open a conversation without a full location.reload(): dispatch a CustomEvent
// that app.js listens for and routes through its openConversation path. Falls
// back to a reload if the listener isn't wired (e.g. older app.js).
function navigateToConv(convId) {
  try { window.dispatchEvent(new CustomEvent("nasllm:openConv", { detail: convId })); }
  catch { try { location.reload(); } catch {} }
}

// Best-effort fetch of the conversation→repo maps. Cached on railMaps; callers
// refresh when a conv id isn't found in the cache.
async function loadWorkspaceMaps() {
  const convById = new Map(), repoById = new Map(), repoByFullName = new Map();
  try {
    const rr = await fetch("/api/repos");
    if (rr.ok) { const repos = await rr.json(); (repos || []).forEach((rp) => { if (rp && rp.id) { repoById.set(rp.id, rp); if (rp.fullName) repoByFullName.set(rp.fullName, rp); } }); }
  } catch {}
  try {
    const cr = await fetch("/api/conversations");
    if (cr.ok) { const convs = await cr.json(); (convs || []).forEach((c) => { if (c && c.id) convById.set(c.id, c); }); }
  } catch {}
  railMaps = { convById, repoById, repoByFullName };
  return railMaps;
}

// Read the active conversation id from the sidebar DOM (set by app.js).
function activeConvIdFromDOM() {
  const row = document.querySelector("#convList .conv.active");
  if (!row) return null;
  const t = row.querySelector('[id^="ct-"]');
  if (!t || !t.id) return null;
  return t.id.slice(3);
}

// activeConvId is the active conversation id, tracked from app.js's
// `nasllm:activeConv` event (dispatched by openConversation/newChat). Repo-bound
// chats are filtered OUT of #convList (renderSidebar skips c.repoId when the
// desktop repo sidebar is present), so activeConvIdFromDOM() — which reads
// #convList's .conv.active row — returns null for them. activeConvId is the
// reliable source for every chat, repo-bound or not; activeConvIdFromDOM()
// stays as a boot fallback before app.js has announced anything.
let activeConvId = null;
function getActiveConvId() { return activeConvId || activeConvIdFromDOM(); }

// Resolve the branch for a repo: prefer the ACTIVE CHAT's own branch (its
// worktree) when this is the rail's bound repo — that's the isolation unit,
// and the repo's live checkout is only a meaningful fallback for a chat
// created before branches were per-chat. Falls back further to a quick
// repos/state call. Used to prefix the approval dialog header when a
// toolExec event doesn't carry its own branch.
async function branchForRepo(name) {
  if (!name) return "";
  if (railRepo === name && railConv && railConv.repoBranch) return railConv.repoBranch;
  if (railRepo === name && railState && railState.branch) return railState.branch;
  try { const r = await sid("repos/state?name=" + encodeURIComponent(name)); if (r.ok && r.data && r.data.branch) return r.data.branch; } catch {}
  return "";
}

// Auto-approve: the global default is cached once on boot from /api/agent/config
// (default ON to match the backend). Each repo chat can override it per-chat via
// the composer status line toggle. The authoritative resolution lives backend-side
// (convAutoApprove) and is carried on every toolExec payload, so the toggle's
// display is best-effort while tool execution always uses the resolved value.
let agentGlobalAutoApprove = true;
async function loadAgentGlobalAutoApprove() {
  try {
    const r = await fetch("/api/agent/config");
    if (r.ok) { const j = await r.json(); if (typeof j.autoApprove === "boolean") agentGlobalAutoApprove = j.autoApprove; }
  } catch {}
}
// Auto-sync: a global toggle (persisted in localStorage, default off) that makes
// the rail poll fast-forward the active session's branch when origin/<branch>
// advances (behind>0). Reuses /repos/refresh with the chat's branch so the
// pull lands in the session's isolated worktree, not the repo's shared tree.
let autoSync = false;
try { autoSync = localStorage.getItem("nas-llm-auto-sync") === "1"; } catch {}
function setAutoSync(on) {
  autoSync = !!on;
  try { localStorage.setItem("nas-llm-auto-sync", autoSync ? "1" : "0"); } catch {}
  renderComposerStatus();
}
// autoSyncInFlight guards against overlapping pulls (the 5s poll could fire
// while a previous pull is still running).
let autoSyncInFlight = false;

function effectiveAutoApprove(conv) {
  if (conv && typeof conv.agentAutoApprove === "boolean") return conv.agentAutoApprove;
  return agentGlobalAutoApprove;
}
async function toggleConvAutoApprove(convId, conv) {
  if (!convId) return;
  const next = !effectiveAutoApprove(conv);
  try {
    const r = await fetch("/api/conversations/" + encodeURIComponent(convId), { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agentAutoApprove: next }) });
    if (!r.ok) return;
    const updated = await r.json().catch(() => null);
    if (updated && updated.id) { railMaps.convById.set(convId, updated); railConv = updated; }
    else if (conv) { conv.agentAutoApprove = next; railConv = conv; }
  } catch {}
  renderComposerStatus();
}

// ensureComposerStatus creates the small repo/branch status line below the
// composer input (desktop-only) if it isn't already present. Clicking it opens
// the repo session panel. Lives inside .composer, after .input-wrap.
function ensureComposerStatus() {
  let status = $("dsComposerStatus");
  if (status) return;
  const wrap = document.querySelector(".composer .input-wrap");
  if (!wrap || !wrap.parentElement) return;
  status = el("div", "ds-composer-status");
  status.id = "dsComposerStatus";
  status.title = "Open the repo session panel";
  status.onclick = (e) => { e.stopPropagation(); if (railRepo) openSessionPanel(railRepo); };
  wrap.parentElement.appendChild(status);
}

// renderComposerStatus fills the below-input line with the repo + branch + git
// state. Hidden for non-repo chats / login view. The branch segment is its
// own clickable chip (openChatBranchPicker) — separate from the rest of the
// line, which opens the repo session panel — and shows THIS CHAT's branch
// (conversation.repoBranch), falling back to the repo's live branch for
// chats created before branches were per-chat.
function renderComposerStatus() {
  const status = $("dsComposerStatus");
  if (!status) return;
  if (!railRepo) { status.classList.add("hidden"); status.textContent = ""; return; }
  const s = railState || {};
  const noGit = s.useGit === false;
  const chatBranch = noGit ? "" : ((railConv && railConv.repoBranch) || s.branch || "");
  status.innerHTML = "";
  status.appendChild(document.createTextNode(railRepo));
  if (noGit) {
    status.appendChild(document.createTextNode(" · no git"));
  } else {
    if (chatBranch) {
      status.appendChild(document.createTextNode(" · "));
      const chip = el("span", "ds-branch-chip", "⎇ " + chatBranch);
      chip.title = "Change this chat's branch";
      chip.onclick = (e) => { e.stopPropagation(); if (railConvId) openChatBranchPicker(railConvId, railRepo, chatBranch); };
      status.appendChild(chip);
    }
    if (s.dirty) status.appendChild(document.createTextNode(" · ●" + s.dirty + " dirty"));
    if (s.ahead) status.appendChild(document.createTextNode(" · ↑" + s.ahead));
    if (s.behind) status.appendChild(document.createTextNode(" · ↓" + s.behind));
    if (s.hasRemote === false) status.appendChild(document.createTextNode(" · no remote"));
    // Auto-sync toggle: fast-forward the session branch when origin advances.
    // Git workspaces only; reflects the global autoSync flag.
    status.appendChild(document.createTextNode(" · "));
    const asChip = el("span", "ds-aa-chip " + (autoSync ? "on" : "off"), autoSync ? "auto-sync" : "auto-sync off");
    asChip.title = autoSync
      ? "Auto-sync on: the session branch is fast-forwarded when origin advances (behind ↓). Click to turn off."
      : "Auto-sync off. Click to fast-forward the session branch when origin advances.";
    asChip.onclick = (e) => { e.stopPropagation(); setAutoSync(!autoSync); };
    status.appendChild(asChip);
  }
  // Auto-approve toggle: reflects this chat's effective setting (per-chat
  // override, else the global default). Click flips the per-chat override.
  // Applies to apply_patch/run_command (file tools) for non-git workspaces too,
  // and to git_commit/git_push for git repos.
  const aaOn = effectiveAutoApprove(railConv);
  status.appendChild(document.createTextNode(" · "));
  const aaChip = el("span", "ds-aa-chip " + (aaOn ? "on" : "off"), aaOn ? "auto-approve" : "auto-approve off");
  aaChip.title = aaOn
    ? "Edits and commands run without an approval dialog. Click to turn off for this chat."
    : "Each edit/command asks before running. Click to turn auto-approve on for this chat.";
  aaChip.onclick = (e) => { e.stopPropagation(); toggleConvAutoApprove(railConvId, railConv); };
  status.appendChild(aaChip);
  // Hover popup: explain the symbols and that clicking opens the session panel.
  const tip = [railRepo];
  if (noGit) {
    tip.push("no git (plain folder — file tools only)");
  } else {
    if (chatBranch) tip.push("branch: " + chatBranch + " (click ⎇ to change)");
    if (s.dirty) tip.push(s.dirty + " uncommitted/modified files (●)");
    if (s.ahead) tip.push(s.ahead + " commits ahead of origin (↑)");
    if (s.behind) tip.push(s.behind + " commits behind origin (↓)");
    if (s.hasRemote === false) tip.push("no remote configured");
  }
  if (!noGit) tip.push(autoSync ? "auto-sync on (auto fast-forward when behind)" : "auto-sync off (click ↻ to toggle)");
  tip.push(aaOn ? "auto-approve on (edits/commands run without asking)" : "auto-approve off (click ✓/○ to toggle for this chat)");
  tip.push("click to open the session panel (review changes, commit & push, open PR)");
  status.title = tip.join(" · ");
  renderPlanPill(status);
  status.classList.remove("hidden");
}

function stopRailPoll() { if (railTimer) { clearInterval(railTimer); railTimer = null; } }
function startRailPoll() { stopRailPoll(); if (railRepo) railTimer = setInterval(refreshRailState, 5000); }

async function refreshRailState() {
  if (!railRepo) return;
  const r = await sid("repos/state?name=" + encodeURIComponent(railRepo));
  if (r.ok && r.data) {
    railState = r.data;
    renderComposerStatus();
    refreshChangesBadge();
    // Eager folder-follows-active-chat: switch the repo folder onto this chat's
    // branch the moment the chat is opened (not only when a tool runs). The
    // sidecar's repos/create-branch auto-stashes dirty work and pops it on
    // return, so the folder tracks the active chat's branch. Guarded by
    // railSwitchInFlight so the 120ms debounce and the 5s poll can't overlap
    // switches. Skip for non-git (useGit===false) and when the chat has no
    // repoBranch. After a switch attempt, return this cycle so auto-sync only
    // runs once the folder is on the right branch.
    if (!railSwitchInFlight && railConv && railConv.repoBranch && r.data.useGit !== false && r.data.branch && r.data.branch !== railConv.repoBranch) {
      railSwitchInFlight = true;
      try {
        const cb = await sid("repos/create-branch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: railRepo, branch: railConv.repoBranch }) });
        const cd = (cb && cb.data) || {};
        if (!cb.ok || !cd.ok) flashDsErr(cd.error || cb.status || "Could not switch the repo folder onto this chat's branch.");
        const r2 = await sid("repos/state?name=" + encodeURIComponent(railRepo));
        if (r2.ok && r2.data) { railState = r2.data; renderComposerStatus(); }
      } finally {
        railSwitchInFlight = false;
      }
      return; // skip auto-sync this pass; folder is now on the right branch
    }
    // Auto-sync: when the session branch is behind origin and the toggle is on,
    // fast-forward it in the session's own worktree. Git workspaces only, and
    // only when we know the chat's branch (repoBranch) so the pull targets the
    // right tree. Skip if a pull is already in flight.
    const s = railState;
    const chatBranch = (railConv && railConv.repoBranch) || s.branch || "";
    if (autoSync && s.useGit !== false && s.behind > 0 && chatBranch && !autoSyncInFlight) {
      autoSyncInFlight = true;
      try {
        await sid("repos/refresh", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: railRepo, branch: chatBranch }) });
      } catch {}
      autoSyncInFlight = false;
      // Re-poll so the rail reflects the fast-forwarded state immediately.
      const r2 = await sid("repos/state?name=" + encodeURIComponent(railRepo));
      if (r2.ok && r2.data) { railState = r2.data; renderComposerStatus(); }
    }
    // Keep the Changes tab's session-view diff fresh while the drawer is open on it
    // and there is uncommitted/unpushed work — so changes stay visible until pushed.
    if ($("dsDrawer") && $("dsDrawer").classList.contains("open") && _dsDrawerTab === "changes" && _dsChangesView === "session" && railState && (railState.dirty > 0 || railState.ahead > 0)) {
      loadSessionPanel(railRepo, (railConv && railConv.repoBranch) || "");
    }
    refreshChangesBadge();
  }
}

function hideBranchRail() {
  railRepo = null; railState = null; railConvId = null; railConv = null; stopRailPoll();
  const status = $("dsComposerStatus");
  if (status) { status.classList.add("hidden"); status.textContent = ""; }
  refreshChangesBadge();
}

// Re-bind the rail to the active conversation's repo (or hide it for non-repo
// / login views). Debounced so a burst of sidebar re-renders coalesces.
function syncBranchRail() {
  if (railSyncTimer) clearTimeout(railSyncTimer);
  railSyncTimer = setTimeout(actualSyncBranchRail, 120);
}
async function actualSyncBranchRail() {
  railSyncTimer = null;
  const app = $("app");
  if (!app || app.classList.contains("hidden")) { hideBranchRail(); return; }
  const convId = getActiveConvId();
  if (!convId) { hideBranchRail(); return; }
  let conv = railMaps.convById.get(convId);
  if (!conv) { await loadWorkspaceMaps(); conv = railMaps.convById.get(convId); }
  if (!conv || !conv.repoId) { hideBranchRail(); return; }
  const repo = railMaps.repoById.get(conv.repoId);
  if (!repo || !repo.fullName) { hideBranchRail(); return; }
  const changed = railRepo !== repo.fullName;
  railRepo = repo.fullName;
  railConvId = convId;
  railConv = conv;
  ensureComposerStatus();
  ensureTasksPill();
  if (changed) { await refreshRailState(); startRailPoll(); }
  renderComposerStatus();
  renderTasksPill();
}

// Create a repo-bound agent chat on its own branch cut from the repo's
// default branch (or an optional baseBranch the user picked), place it in the
// workspace folder, enable agent mode with file + git tools, and navigate to it
// without a full page reload. Reused by "+ New chat" and "New chat from
// branch…". baseBranch lets a session start from an existing branch instead of
// the repo's default (like the Copilot app's composer branch picker); ignored
// for non-git workspaces (they have no branches).
//
// Order matters: we register the repo with the backend and confirm its id
// BEFORE creating any conversation. If registration fails we surface the real
// error and bail without creating a chat — so a failed connect never leaves an
// orphaned "normal" chat behind (which is what happened when the conversation
// was created first and the repo lookup threw after it).
async function createWorkspaceChat(r, baseBranch) {
  const fullName = r.name;
  const baseBr = (typeof baseBranch === "string" && baseBranch.trim()) ? baseBranch.trim() : "";

  // 1. Pull local repo context (path/branch/head/tree) from the sidecar so the
  //    backend registration carries real metadata. Best-effort: if the sidecar
  //    is unreachable we still try to register with an empty context.
  let openData = {};
  try { const or = await sid("repos/open", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: fullName }) }); openData = (or && or.data) || {}; } catch {}

  // 2. Register (or refresh) the repo with the backend. POST /api/repos is
  //    idempotent (ON CONFLICT DO UPDATE) and returns the saved repo INCLUDING
  //    its id, so we read repoId straight from the response — no separate
  //    lookup, no race, no silent miss. This runs through the same proxied
  //    session cookie as every other /api call, so it works even when the
  //    sidecar's own best-effort push 401'd (e.g. it wasn't signed in yet).
  let repoId = "";
  let regErr = "";
  try {
    const rr = await fetch("/api/repos", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fullName, localPath: openData.path || "", branch: openData.branch || "", head: openData.head || "", tree: openData.tree || [] }) });
    if (rr.ok) { const saved = await rr.json().catch(() => ({})); repoId = (saved && saved.id) || ""; }
    else regErr = "backend HTTP " + rr.status;
  } catch (e) { regErr = String((e && e.message) || e); }

  // 3. Fallback: an older backend may not return the id on upsert. Do one list
  //    lookup so we still bind the chat when the POST succeeded but came back
  //    id-less. Match by fullName (the UNIQUE key the POST just upserted on).
  if (!repoId) {
    try {
      const lr = await fetch("/api/repos");
      if (lr.ok) { const repos = await lr.json(); const found = (repos || []).find((x) => x.fullName === fullName); if (found) repoId = found.id; }
    } catch {}
  }

  // 4. No repo id → bail WITHOUT creating a conversation. Show the real reason
  //    so the user knows whether it's auth, network, or a stale sidecar.
  if (!repoId) {
    flashDsErr("Could not register \"" + fullName + "\" with the backend" + (regErr ? ": " + regErr : ")"));
    return;
  }

  // 5. Repo confirmed — NOW create the conversation. The id only exists after
  //    this call, and the id is what makes the chat distinguishable, so the
  //    real title is applied in the PATCH below rather than here.
  const model = localStorage.getItem("nas-llm-model") || "";
  const cr = await fetch("/api/conversations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: fullName + " (agent)", model }) });
  const cj = await cr.json().catch(() => ({}));
  const convId = cj && cj.id;
  if (!convId) { flashDsErr("Could not create conversation."); return; }
  // Workspace folder so chats group in the sidebar.
  const folderId = await ensureWorkspaceFolder(fullName);

  // Every chat on a repo used to be titled exactly "owner/repo (agent)", so a
  // sidebar full of them was unreadable — and now that the approval dialog and
  // the completion notification both identify a chat by its title, identical
  // titles actively cost you ("which chat wants to run this command?"). Tag
  // each chat with a short slice of its conversation id. The branch below uses
  // the same slice, so a chat, its title, and its branch all carry one handle
  // you can match by eye.
  const shortId = String(convId).slice(0, 7);
  const title = fullName + " (agent " + shortId + ")";

  // Give this chat its own branch cut from the repo's default branch, unless
  // this is a non-git workspace (useGit=false) — those have no branches, so the
  // chat runs in the workspace folder directly with file tools only.
  const useGit = r.use_git !== false;
  let branch = "";
  if (useGit) {
    const shortName = (fullName.split("/").pop() || fullName);
    const branchName = "agent/" + slugifyTitle(shortName) + "-" + shortId;
    let branchErr = "";
    try {
      const branchBody = { name: fullName, branch: branchName };
      if (baseBr) branchBody.base = baseBr;
      const cr = await sid("repos/create-branch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(branchBody) });
      const cd = (cr && cr.data) || {};
      if (cr.ok && cd.ok && cd.branch) branch = cd.branch;
      else branchErr = cd.error || cr.status || "unknown error";
    } catch (e) { branchErr = String((e && e.message) || e); }

    if (!branch) {
      // Branch creation failed (invalid name, a repo that moved, git refused).
      // Surface the real git error and let the user fall back to the repo
      // folder's current branch rather than silently landing the agent's edits
      // somewhere they don't expect. Never force.
      flashDsErr("Could not create this chat's branch: " + branchErr);
      const cont = await dsConfirm(
        "Continue on the repo's current branch instead?",
        "The agent's edits will land in the repo folder on whatever branch it has checked out, shared with anything else using it."
      );
      if (!cont) return; // aborted — do not navigate
      try {
        const sr = await sid("repos/state?name=" + encodeURIComponent(fullName));
        const sd = (sr && sr.data) || {};
        if (sr.ok && sd.branch) branch = sd.branch;
      } catch {}
    }
  }

  // PATCH title + repoId + agentTools + folder + repoBranch in one go — no extra
  //  round trip for the rename. A title set this way is marked custom server-side,
  //  which is correct: it is deliberate, not auto-derived. A non-git workspace
  //  gets the file-only tool set (no git_status/git_commit/git_push/create_pr or
  //  PR tools); a git repo gets the file + git workflow tools, including the
  //  read-only PR inspection tools (list_prs/pr_view/pr_checks) and merge_pr so
  //  the agent can merge a PR when asked (each merge still prompts the approval
  //  dialog — merge_pr is never in the renderer's AUTO_APPROVE_TOOLS set).
  const agentTools = useGit
    ? "read_file,list_files,glob,grep,git_status,apply_patch,run_command,ask_user,get_time,git_commit,git_push,create_pr,list_prs,pr_view,pr_checks,merge_pr"
    : "read_file,list_files,glob,grep,apply_patch,run_command,ask_user,get_time";
  const patchBody = { title, repoId, agentTools };
  if (folderId) patchBody.folderId = folderId;
  if (branch) patchBody.repoBranch = branch;
  try {
    await fetch("/api/conversations/" + encodeURIComponent(convId), { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patchBody) });
  } catch (e) { flashDsErr("Could not bind chat to repo: " + String((e && e.message) || e)); return; }
  if (folderId) { try { await sid("repos/set-folder", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repo: fullName, folder_id: folderId }) }); } catch {} }
  try {
    let extras = []; try { extras = JSON.parse(localStorage.getItem("nas-llm-extras") || "[]") || []; } catch {}
    if (!extras.includes("agent")) { extras.push("agent"); localStorage.setItem("nas-llm-extras", JSON.stringify(extras)); }
    localStorage.setItem("nas-llm-conv", convId);
  } catch {}
  // Expand the repo's dropdown so the new chat is visible immediately, then
  // refresh the repo dropdown (re-fetches /api/conversations and re-renders)
  // and sync app.js's conversation list before navigating. Awaiting
  // refreshLocal here — instead of firing it and navigating straight away — is
  // what makes the new chat appear under its repo the moment it's created,
  // rather than only after the first message is typed.
  if (!expandedRepos.has(fullName)) { expandedRepos.add(fullName); saveExpandedRepos(); }
  await refreshLocal();
  try { window.dispatchEvent(new CustomEvent("nasllm:refreshConvs")); } catch {}
  navigateToConv(convId);
}

// --- Repos panel (GitHub connect/browse/clone; local repos live in the sidebar) ---
function openRepos() { openDrawer("github"); }
function closeRepos() { closeDrawer(); }

function ghRow(r) {
  const row = el("div", "ds-repo-row");
  const main = el("div", "ds-repo-main");
  const name = el("div", "ds-repo-name", r.full_name);
  if (r.private) { const badge = el("span", "ds-badge ds-badge-priv", "private"); name.appendChild(badge); }
  main.appendChild(name);
  const meta = el("div", "ds-repo-meta", (r.default_branch || "main") + " · updated " + (r.updated_at || "?").slice(0, 10));
  main.appendChild(meta);
  row.appendChild(main);
  const clone = el("button", "ds-btn ds-btn-sm", "Clone");
  clone.onclick = async () => {
    clone.disabled = true; clone.textContent = "Cloning…";
    const res = await sid("repos/clone", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ full_name: r.full_name, clone_url: r.clone_url }) });
    const d = (res && res.data) || {};
    if (d.ok) { clone.textContent = "Cloned ✓"; refreshLocal(); }
    else { clone.disabled = false; clone.textContent = "Clone"; flashDsErr(d.error || res.status); }
  };
  row.appendChild(clone);
  return row;
}

// hostOf returns a short badge label for a remote URL (github / gitlab / ssh / https).
function hostOf(remote) {
  if (!remote) return "";
  if (/github\.com/.test(remote)) return "github";
  if (/gitlab\.com/.test(remote)) return "gitlab";
  if (remote.startsWith("git@") || remote.startsWith("ssh://")) return "ssh";
  if (remote.startsWith("https://")) return "https";
  return "";
}

// Which repos are expanded in the sidebar dropdown (persisted by full_name).
let expandedRepos = new Set();
try { expandedRepos = new Set(JSON.parse(localStorage.getItem("nas-llm-repo-expanded") || "[]")); } catch {}
function saveExpandedRepos() { try { localStorage.setItem("nas-llm-repo-expanded", JSON.stringify([...expandedRepos])); } catch {} }

// deleteRepoChat removes a conversation from the backend and refreshes the repo
// dropdown + the main sidebar. Confirms first (no native confirm()). The repo
// chat row's delete button calls this.
async function deleteRepoChat(c) {
  const ok = await dsConfirm("Delete this chat?", "This permanently removes the conversation.");
  if (!ok) return;
  try { await fetch("/api/conversations/" + encodeURIComponent(c.id), { method: "DELETE" }); } catch {}
  refreshLocal();
  try { window.dispatchEvent(new CustomEvent("nasllm:refreshConvs")); } catch {}
}

// pullRepo runs `git pull --ff-only` on a connected repo and refreshes the list.
async function pullRepo(r) {
  const res = await sid("repos/refresh", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: r.name }) });
  const d = (res && res.data) || {};
  if (d.ok) {
    // Show a success toast so a pull (especially "Already up to date") isn't
    // silent and mistaken for "did nothing".
    flashDsOk((d.output && d.output.trim()) ? d.output.trim() : ("Pulled " + r.name + " ✓"));
  } else {
    flashDsErr("Pull failed: " + (d.error || res.status || "unknown error"));
  }
  refreshLocal();
}

// enableGit promotes a non-git workspace to git-enabled in place via
// /repos/init-git (git init + initial commit). On success, refreshes the sidebar
// so the branch/dirty badges appear and the git session actions unlock.
async function enableGit(r) {
  const ok = await dsConfirm("Enable git for \"" + r.name + "\"?", "This runs `git init` and an initial commit" + (r.path ? " in " + r.path : "") + " so the workspace starts tracking changes with git (commits, branches, pull requests).");
  if (!ok) return;
  const res = await sid("repos/init-git", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: r.name }) });
  const d = (res && res.data) || {};
  if (d.ok) {
    flashDsOk("Git enabled for \"" + r.name + "\" ✓");
    refreshLocal();
    refreshRailState();
  } else {
    flashDsErr("Could not enable git: " + (d.error || res.status || "unknown"));
  }
}

// openInApp opens a workspace folder in an external app (editor / Finder /
// terminal) via /repos/open-in. Best-effort: toasts on failure (e.g. no editor
// installed). target is "editor" | "finder" | "terminal".
async function openInApp(r, target) {
  const res = await sid("repos/open-in", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: r.name, target }) });
  const d = (res && res.data) || {};
  if (!d.ok) flashDsErr("Could not open: " + (d.error || res.status || "unknown"));
}

// repoMenu opens a small popup of per-repo actions anchored under the ⋯ button.
// Closes on outside click, Esc, or item selection.
function repoMenu(r, anchor) {
  closeRepoMenu();
  const menu = el("div", "ds-repo-menu");
  menu.id = "dsRepoMenu";
  const add = (label, title, fn) => {
    const item = el("button", "ds-repo-menu-item", label);
    if (title) item.title = title;
    item.onclick = (e) => { e.stopPropagation(); closeRepoMenu(); fn(); };
    menu.appendChild(item);
  };
  // Open-in actions are useful for every workspace (git or not).
  add("Open in editor", "Open the workspace folder in your editor ($VISUAL/$EDITOR, else VS Code)", () => openInApp(r, "editor"));
  add("Open in Finder", "Reveal the workspace folder in the file manager", () => openInApp(r, "finder"));
  add("Open in Terminal", "Open a terminal cd'd into the workspace folder", () => openInApp(r, "terminal"));
  if (r.use_git === false) {
    add("Enable git", "git init in place and start tracking with git", () => enableGit(r));
  } else {
    add("New chat from branch…", "Start a session cut from an existing branch instead of the default", () => openBaseBranchPicker(r));
    add("Pull", "git pull --ff-only", () => pullRepo(r));
    add("Branch…", "Switch to a different branch (local or remote)", () => openBranchPicker(r));
    add("Ship…", "Versioned release (changelog + commit/push)", () => openShipChanges(r));
  }
  document.body.appendChild(menu);
  const rect = anchor.getBoundingClientRect();
  menu.style.right = (window.innerWidth - rect.right) + "px";
  menu.style.top = (rect.bottom + 4) + "px";
  // Defer the outside-click listener so the same click that opened it doesn't
  // immediately close it (the click stops propagating, but this is belt+braces).
  setTimeout(() => {
    menu._outside = (e) => { if (!menu.contains(e.target)) closeRepoMenu(); };
    menu._esc = (e) => { if (e.key === "Escape") closeRepoMenu(); };
    document.addEventListener("click", menu._outside);
    document.addEventListener("keydown", menu._esc);
  }, 0);
}
function closeRepoMenu() {
  const menu = $("dsRepoMenu");
  if (!menu) return;
  if (menu._outside) document.removeEventListener("click", menu._outside);
  if (menu._esc) document.removeEventListener("keydown", menu._esc);
  menu.remove();
}

// openConnectMenu is the small popup behind the sidebar "+": pick between
// connecting an existing git repo (folder picker -> scan) and creating a new
// named workspace (folder picker -> name + git dialog). Reuses closeRepoMenu.
function openConnectMenu(anchor) {
  closeRepoMenu();
  const menu = el("div", "ds-repo-menu");
  menu.id = "dsRepoMenu";
  const add = (label, title, fn) => {
    const item = el("button", "ds-repo-menu-item", label);
    if (title) item.title = title;
    item.onclick = (e) => { e.stopPropagation(); closeRepoMenu(); fn(); };
    menu.appendChild(item);
  };
  add("Connect git repo…", "Pick an existing git repository folder", async () => {
    const ok = await connectFolderFlow();
    if (ok) refreshLocal();
  });
  add("New workspace…", "Pick a folder, name it, and choose whether to use git", async () => {
    const ok = await createWorkspaceFlow();
    if (ok) refreshLocal();
  });
  document.body.appendChild(menu);
  const rect = anchor.getBoundingClientRect();
  menu.style.right = (window.innerWidth - rect.right) + "px";
  menu.style.top = (rect.bottom + 4) + "px";
  setTimeout(() => {
    menu._outside = (e) => { if (!menu.contains(e.target)) closeRepoMenu(); };
    menu._esc = (e) => { if (e.key === "Escape") closeRepoMenu(); };
    document.addEventListener("click", menu._outside);
    document.addEventListener("keydown", menu._esc);
  }, 0);
}

// openBranchPicker shows an overlay listing the repo's local AND remote-only
// branches (current one highlighted). Clicking a local branch runs git checkout;
// clicking a remote-only one runs git checkout -t origin/<branch> (creates a
// local tracking branch). On success it refreshes the sidebar + composer rail.
// A dirty tree that would be overwritten is refused by git — the error surfaces
// as a toast so the user knows to commit/stash first.
async function openBranchPicker(r) {
  const repoName = r.name;
  let overlay = $("dsBranchOverlay");
  let list;
  if (!overlay) {
    overlay = el("div", "ds-overlay");
    overlay.id = "dsBranchOverlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "Switch branch");
    const card = el("div", "ds-card");
    const head = el("div", "ds-head");
    head.appendChild(el("h2", null, "Switch branch"));
    const sub = el("span", "ds-note", repoName);
    head.appendChild(sub);
    const x = el("button", "ds-x"); x.textContent = "×"; x.title = "Close"; x.setAttribute("aria-label", "Close");
    head.appendChild(x);
    card.appendChild(head);
    list = el("div", "ds-branch-list"); list.id = "dsBranchList";
    card.appendChild(list);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    const close = () => overlay.classList.remove("open");
    x.onclick = close;
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  } else {
    list = $("dsBranchList");
  }
  list.innerHTML = "";
  list.appendChild(el("div", "ds-note", "Loading branches…"));
  overlay.classList.add("open");
  const res = await sid("repos/branches", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: repoName }) });
  const d = (res && res.data) || {};
  list.innerHTML = "";
  if (!res.ok || !d.ok) { list.appendChild(el("div", "ds-note", "Could not load branches: " + (d.error || res.status || "unknown"))); return; }
  const branches = d.branches || [];
  const current = d.current || "";
  if (!branches.length) { list.appendChild(el("div", "ds-note", "No branches found.")); return; }
  branches.forEach((b) => {
    const bname = typeof b === "string" ? b : (b.name || "");
    const isRemote = typeof b === "object" && !!b.remote;
    const isCur = bname === current;
    const row = el("div", "ds-branch-item" + (isCur ? " current" : ""));
    row.title = isCur ? "Current branch" : (isRemote ? "Checkout & track origin/" + bname : "Checkout " + bname);
    row.appendChild(el("span", "ds-branch-name", bname));
    if (isCur) row.appendChild(el("span", "ds-branch-badge ds-branch-cur", "current"));
    else if (isRemote) row.appendChild(el("span", "ds-branch-badge ds-branch-remote", "remote"));
    if (!isCur) {
      row.onclick = async () => {
        row.style.opacity = ".5";
        const cr = await sid("repos/checkout", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repo: repoName, branch: bname, remote: isRemote }) });
        const cd = (cr && cr.data) || {};
        if (cd.ok) {
          flashDsOk("Checked out " + bname + " ✓");
          overlay.classList.remove("open");
          refreshLocal();
          refreshRailState();
        } else {
          row.style.opacity = "1";
          flashDsErr("Checkout failed: " + (cd.error || cr.status || "git refused — commit or stash your changes first"));
        }
      };
    }
    list.appendChild(row);
  });
}

// openBaseBranchPicker lists a git workspace's branches and, on select, starts a
// new agent session cut from that branch (instead of the repo's default). This
// is the Copilot-app-style "start a session from an existing branch" affordance;
// distinct from openBranchPicker (which switches the repo's shared checkout)
// and openChatBranchPicker (which re-points an existing chat). Git workspaces
// only — non-git workspaces have no branches.
async function openBaseBranchPicker(r) {
  const repoName = r.name;
  let overlay = $("dsBaseBranchOverlay");
  let list;
  if (!overlay) {
    overlay = el("div", "ds-overlay");
    overlay.id = "dsBaseBranchOverlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "New chat from branch");
    const card = el("div", "ds-card");
    const head = el("div", "ds-head");
    head.appendChild(el("h2", null, "New chat from branch"));
    const sub = el("span", "ds-note", repoName);
    head.appendChild(sub);
    const x = el("button", "ds-x"); x.textContent = "×"; x.title = "Close"; x.setAttribute("aria-label", "Close");
    head.appendChild(x);
    card.appendChild(head);
    card.appendChild(el("div", "ds-note", "Pick a branch to base the new session on. The session gets its own agent branch cut from the one you choose."));
    list = el("div", "ds-branch-list"); list.id = "dsBaseBranchList";
    card.appendChild(list);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    const close = () => overlay.classList.remove("open");
    x.onclick = close;
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  } else {
    list = $("dsBaseBranchList");
  }
  list.innerHTML = "";
  list.appendChild(el("div", "ds-note", "Loading branches…"));
  overlay.classList.add("open");
  const res = await sid("repos/branches", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: repoName }) });
  const d = (res && res.data) || {};
  list.innerHTML = "";
  if (!res.ok || !d.ok) { list.appendChild(el("div", "ds-note", "Could not load branches: " + (d.error || res.status || "unknown"))); return; }
  const branches = d.branches || [];
  const current = d.current || "";
  if (!branches.length) { list.appendChild(el("div", "ds-note", "No branches found.")); return; }
  branches.forEach((b) => {
    const bname = typeof b === "string" ? b : (b.name || "");
    if (!bname) return;
    const isRemote = typeof b === "object" && !!b.remote;
    const isCur = bname === current;
    const row = el("div", "ds-branch-item" + (isCur ? " current" : ""));
    row.title = isCur ? "Current branch" : (isRemote ? "Base the new session on origin/" + bname : "Base the new session on " + bname);
    row.appendChild(el("span", "ds-branch-name", bname));
    if (isCur) row.appendChild(el("span", "ds-branch-badge ds-branch-cur", "current"));
    else if (isRemote) row.appendChild(el("span", "ds-branch-badge ds-branch-remote", "remote"));
    row.onclick = async () => {
      overlay.classList.remove("open");
      // A remote-only base needs a tracking checkout first so the branch ref
      // exists locally for create-branch to cut from.
      if (isRemote) {
        try { await sid("repos/checkout", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repo: repoName, branch: bname, remote: true }) }); } catch {}
      }
      try { await createWorkspaceChat(r, bname); }
      catch (err) { flashDsErr(String((err && err.message) || err)); }
    };
    list.appendChild(row);
  });
}

// Turn a chat title into a short, git-safe branch-name fragment: lowercase,
// non-alphanumeric runs collapsed to a single "-", trimmed. Mirrors the
// agent/<slug> convention the sidecar already uses for createRepoChat.
function slugifyTitle(title) {
  const slug = String(title || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || "chat";
}

// openChatBranchPicker lets the user re-point THIS CHAT at a different
// branch: pick an existing branch, or create a new one (defaulting to
// agent/<slug of the chat title>, but editable). A local/new branch goes
// through repos/create-branch (switches the repo folder when clean, else
// creates the branch for a lazy isolated worktree); a remote-only branch goes
// through repos/checkout (tracking checkout). Either path then PATCHes the
// conversation's repoBranch, which is what makes this chat's future tool calls
// run on that branch (see runToolExec). Distinct from openBranchPicker, which
// switches the repo's single shared checkout for the editor view.
async function openChatBranchPicker(convId, repoName, currentBranch) {
  const title = await titleForConv(convId);
  let overlay = $("dsChatBranchOverlay");
  let list, newInput, createBtn;
  if (!overlay) {
    overlay = el("div", "ds-overlay");
    overlay.id = "dsChatBranchOverlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "Chat branch");
    const card = el("div", "ds-card");
    const head = el("div", "ds-head");
    head.appendChild(el("h2", null, "Chat branch"));
    const x = el("button", "ds-x"); x.textContent = "×"; x.title = "Close"; x.setAttribute("aria-label", "Close");
    head.appendChild(x);
    card.appendChild(head);
    const sub = el("div", "ds-note"); sub.id = "dsChatBranchSub";
    card.appendChild(sub);
    card.appendChild(el("div", "ds-note", "Switching moves the folder onto this chat's branch; uncommitted edits are auto-stashed and restored when you switch back. node_modules/.env/build caches stay in place."));
    card.appendChild(el("div", "ds-label", "Existing branches"));
    list = el("div", "ds-branch-list"); list.id = "dsChatBranchList";
    card.appendChild(list);
    card.appendChild(el("div", "ds-label", "Or create a new branch"));
    const row = el("div", "ds-row");
    newInput = document.createElement("input"); newInput.id = "dsChatBranchNew"; newInput.type = "text";
    createBtn = el("button", "ds-btn", "Create & switch"); createBtn.id = "dsChatBranchCreateBtn";
    row.appendChild(newInput); row.appendChild(createBtn);
    card.appendChild(row);
    card.appendChild(el("div", "ds-note", "Switching moves the folder onto this chat's branch; uncommitted edits are auto-stashed and restored when you switch back. node_modules/.env/build caches stay in place."));
    const out = el("div", "ds-note"); out.id = "dsChatBranchOut";
    card.appendChild(out);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    const close = () => overlay.classList.remove("open");
    x.onclick = close;
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  } else {
    list = $("dsChatBranchList");
    newInput = $("dsChatBranchNew");
    createBtn = $("dsChatBranchCreateBtn");
  }
  $("dsChatBranchSub").textContent = title ? (repoName + " · " + title) : repoName;
  const out = $("dsChatBranchOut"); if (out) out.textContent = "";
  newInput.value = "agent/" + slugifyTitle(title);
  overlay._ctx = { convId, repoName, currentBranch };
  createBtn.onclick = () => switchChatBranch(overlay, newInput.value.trim(), false);
  list.innerHTML = "";
  list.appendChild(el("div", "ds-note", "Loading branches…"));
  overlay.classList.add("open");
  const res = await sid("repos/branches", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: repoName }) });
  const d = (res && res.data) || {};
  list.innerHTML = "";
  if (!res.ok || !d.ok) { list.appendChild(el("div", "ds-note", "Could not load branches: " + (d.error || res.status || "unknown"))); return; }
  const branches = d.branches || [];
  if (!branches.length) { list.appendChild(el("div", "ds-note", "No branches found.")); }
  branches.forEach((b) => {
    const bname = typeof b === "string" ? b : (b.name || "");
    if (!bname) return;
    const isRemote = typeof b === "object" && !!b.remote;
    const isCur = bname === currentBranch;
    const row = el("div", "ds-branch-item" + (isCur ? " current" : ""));
    row.title = isCur ? "This chat's current branch" : (isRemote ? "Track & switch this chat to origin/" + bname : "Switch this chat to " + bname);
    row.appendChild(el("span", "ds-branch-name", bname));
    if (isCur) row.appendChild(el("span", "ds-branch-badge ds-branch-cur", "current"));
    else if (isRemote) row.appendChild(el("span", "ds-branch-badge ds-branch-remote", "remote"));
    if (!isCur) row.onclick = () => switchChatBranch(overlay, bname, isRemote);
    list.appendChild(row);
  });
}

// Re-points this chat at `branchName`. A remote-only branch is checked out with
// `git checkout -t origin/<branch>` (repos/checkout); any other branch goes
// through repos/create-branch, which switches the repo folder onto it when the
// folder is clean, or creates the branch for a lazy isolated worktree when the
// folder is dirty. Then PATCHes the conversation's repoBranch — that PATCH,
// more than the switch, is what makes this chat's future tool calls run on the
// new branch (see runToolExec).
async function switchChatBranch(overlay, branchName, isRemote) {
  const out = $("dsChatBranchOut");
  if (!branchName) { if (out) out.textContent = "Enter a branch name."; return; }
  const ctx = overlay._ctx || {};
  const { convId, repoName } = ctx;
  if (!convId || !repoName) return;
  if (out) out.textContent = isRemote ? "Tracking & switching…" : "Switching…";
  let finalBranch = branchName;
  let ok = false;
  let err = "";
  if (isRemote) {
    const cr = await sid("repos/checkout", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repo: repoName, branch: branchName, remote: true }) });
    const cd = (cr && cr.data) || {};
    ok = !!(cr.ok && cd.ok);
    finalBranch = cd.branch || branchName;
    if (!ok) err = cd.error || cr.status || "git refused — commit or stash your changes first";
  } else {
    const cr = await sid("repos/create-branch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: repoName, branch: branchName }) });
    const cd = (cr && cr.data) || {};
    ok = !!(cr.ok && cd.ok && cd.branch);
    finalBranch = cd.branch || branchName;
    if (!ok) err = cd.error || cr.status || "unknown error";
  }
  if (!ok) { if (out) out.textContent = "Failed: " + err; return; }
  try {
    await fetch("/api/conversations/" + encodeURIComponent(convId), { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repoBranch: finalBranch }) });
  } catch (e) {
    if (out) out.textContent = "Branch ready, but could not update the chat: " + String((e && e.message) || e);
    return;
  }
  // Update the cached conversation record so the composer chip and sidebar
  // reflect the new branch immediately, without waiting on a full re-fetch.
  const conv = railMaps.convById.get(convId);
  if (conv) conv.repoBranch = finalBranch;
  if (railConvId === convId) renderComposerStatus();
  refreshLocal();
  refreshRailState();
  overlay.classList.remove("open");
  flashDsOk("Chat now on ⎇ " + finalBranch);
}

// Toggle the .active highlight on the repo dropdown's chat rows to match the
// active conversation. Called when app.js signals a new active chat
// (nasllm:activeConv) and after refreshLocal re-renders the dropdown — so the
// chat you're viewing is highlighted in the sidebar repo list, the same way
// #convList highlights the active non-repo chat.
function highlightActiveRepoChat() {
  const id = getActiveConvId();
  document.querySelectorAll(".ds-repo-chat[data-conv-id]").forEach((row) => {
    row.classList.toggle("active", row.getAttribute("data-conv-id") === id);
  });
}

// localRow renders one connected repo as a dropdown: a header with the repo
// name, a ⋯ actions menu, and a + to start a new agent chat. Expanding the
// header shows the chats attached to it. Branch/dirty state lives in the
// header rail (in-chat) and the session panel, so the sidebar row stays clean.
function localRow(r, chats) {
  const wrap = el("div", "ds-repo-wrap");
  if (expandedRepos.has(r.name)) wrap.classList.add("expanded");

  const head = el("div", "ds-repo-head");
  const chev = el("span", "ds-repo-chev", "▸");
  head.appendChild(chev);
  const nameBtn = el("button", "ds-repo-name-btn");
  nameBtn.title = r.use_git === false ? (r.name + " · no git") : (r.branch ? (r.name + " · on " + r.branch) : r.name);
  // Name line: workspace display name + (for git) a dirty badge, with a branch
  // subtitle below; for a non-git workspace a "no git" tag replaces them so the
  // sidebar row stays informative without git-only state.
  const nameLine = el("span", "ds-repo-name-line");
  nameLine.appendChild(el("span", "ds-repo-name", r.name));
  if (r.use_git === false) {
    const nogit = el("span", "ds-repo-nogit", "no git");
    nogit.title = "Plain folder — file tools work, but git tools (commit, branch, PR) are hidden. Use ⋯ → Enable git to start tracking with git.";
    nameLine.appendChild(nogit);
  } else {
    if (r.dirty > 0) {
      const dirty = el("span", "ds-repo-dirty", "●" + r.dirty);
      dirty.title = r.dirty + " uncommitted/modified files — open ⋯ → Session to review and commit";
      nameLine.appendChild(dirty);
    }
  }
  nameBtn.appendChild(nameLine);
  if (r.use_git !== false && r.branch) nameBtn.appendChild(el("span", "ds-repo-branch", "⎇ " + r.branch));
  nameBtn.onclick = () => {
    if (expandedRepos.has(r.name)) expandedRepos.delete(r.name);
    else expandedRepos.add(r.name);
    saveExpandedRepos();
    wrap.classList.toggle("expanded");
  };
  head.appendChild(nameBtn);

  const actions = el("div", "ds-repo-actions");
  const menuBtn = el("button", "ds-repo-act", "⋯");
  menuBtn.title = "Repo actions"; menuBtn.setAttribute("aria-label", "Repo actions");
  menuBtn.onclick = (e) => { e.stopPropagation(); repoMenu(r, menuBtn); };
  actions.appendChild(menuBtn);
  const addBtn = el("button", "ds-repo-act ds-repo-add", "+");
  addBtn.title = "New agent chat on a fresh branch"; addBtn.setAttribute("aria-label", "New chat");
  addBtn.onclick = async (e) => {
    e.stopPropagation();
    addBtn.disabled = true; addBtn.textContent = "…";
    try { await createWorkspaceChat(r); }
    catch (err) { flashDsErr(String((err && err.message) || err)); }
    finally { addBtn.disabled = false; addBtn.textContent = "+"; }
  };
  actions.appendChild(addBtn);
  head.appendChild(actions);
  wrap.appendChild(head);

  // Attached chats (the dropdown body).
  const chatsEl = el("div", "ds-repo-chats");
  if (chats && chats.length) {
    chats.forEach((c) => {
      const cr = el("div", "ds-repo-chat" + (c.id === getActiveConvId() ? " active" : ""));
      cr.setAttribute("data-conv-id", c.id);
      const cmain = el("div", "ds-repo-chat-main");
      const t = el("span", "ds-repo-chat-title", c.title || "New chat");
      cmain.appendChild(t);
      // Each chat's agent branch: the conversation's stored repoBranch, falling
      // back to the repo's live branch for older chats without one.
      const br = c.repoBranch || r.branch || "";
      if (br) cmain.appendChild(el("span", "ds-repo-chat-branch", "⎇ " + br));
      cr.appendChild(cmain);
      const tm = el("span", "ds-repo-chat-time", dsTime(c.updatedAt));
      cr.appendChild(tm);
      const del = el("button", "ds-repo-chat-del", "×");
      del.title = "Delete chat"; del.setAttribute("aria-label", "Delete chat");
      del.onclick = (e) => { e.stopPropagation(); deleteRepoChat(c); };
      cr.appendChild(del);
      cr.onclick = () => { try { localStorage.setItem("nas-llm-conv", c.id); } catch {} navigateToConv(c.id); };
      chatsEl.appendChild(cr);
    });
  } else {
    chatsEl.appendChild(el("div", "ds-note", "No chats yet. Click + to start one."));
  }
  wrap.appendChild(chatsEl);
  return wrap;
}

async function refreshGithub() {
  const body = $("dsGhBody"); if (!body) return;
  const out = $("dsGhStatus");
  const res = await sid("github/status"); const d = (res && res.data) || {};
  const connectWrap = $("dsGhConnect");
  const listWrap = $("dsGhList");
  if (d.connected) {
    if (out) out.textContent = "Connected as " + (d.login || "?");
    if (connectWrap) connectWrap.classList.add("hidden");
    if (listWrap) listWrap.classList.remove("hidden");
    body.innerHTML = "";
    body.appendChild(el("div", "ds-note", "Loading repos…"));
    const rr = await sid("github/repos");
    body.innerHTML = "";
    if (rr.ok && Array.isArray(rr.data)) {
      ghReposCache = rr.data;
      const si = $("dsGhSearch");
      const q = si ? si.value.trim().toLowerCase() : "";
      const filtered = !q ? rr.data : rr.data.filter(r => r.full_name.toLowerCase().includes(q));
      if (!filtered.length) body.appendChild(el("div", "ds-note", "No matching repos."));
      filtered.forEach(r => body.appendChild(ghRow(r)));
    } else {
      body.appendChild(el("div", "ds-note", "Could not load repos: " + ((rr.data && rr.data.error) || rr.status)));
    }
  } else {
    if (out) out.textContent = "Not connected.";
    if (connectWrap) connectWrap.classList.remove("hidden");
    if (listWrap) listWrap.classList.add("hidden");
  }
}

async function refreshLocal() {
  const body = $("dsLocalBody"); if (!body) return;
  body.innerHTML = "";
  body.appendChild(el("div", "ds-note", "Loading…"));
  const res = await sid("repos/local");
  const { repoByFullName, chatsByRepoId } = await loadWorkspaceData();
  body.innerHTML = "";
  if (res.ok && Array.isArray(res.data)) {
    if (!res.data.length) { body.appendChild(el("div", "ds-note", "No repos connected yet. Click “+” above to connect a local folder, or use the GitHub button in the header to clone one.")); return; }
    res.data.forEach((r) => {
      const rp = repoByFullName.get(r.name || (r.full_name || ""));
      const chats = rp ? (chatsByRepoId.get(rp.id) || []) : [];
      body.appendChild(localRow(r, chats));
    });
    highlightActiveRepoChat();
  } else {
    body.appendChild(el("div", "ds-note", "Could not load local repos."));
  }
}

// flashDsErr shows a page-level toast, independent of any overlay's open
// state — errors from the sidebar's connect/pull/ship actions (which don't
// open the Repositories modal) need to be visible too, not silently written
// into a hidden element.
function flashDsErr(msg) {
  let toast = $("dsToast");
  if (!toast) {
    toast = el("div", "ds-toast");
    toast.id = "dsToast";
    document.body.appendChild(toast);
  }
  toast.textContent = String(msg || "Something went wrong.");
  toast.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toast.classList.remove("show"), 4500);
}
// Green success toast (e.g. pull succeeded). Separate element from flashDsErr
// so a quick error-then-success doesn't race the same node's text/timer.
function flashDsOk(msg) {
  let toast = $("dsToastOk");
  if (!toast) {
    toast = el("div", "ds-toast ds-toast-ok");
    toast.id = "dsToastOk";
    document.body.appendChild(toast);
  }
  toast.textContent = String(msg || "Done.");
  toast.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toast.classList.remove("show"), 3500);
}

function buildReposOverlay() {
  if ($("dsReposOverlay")) return;
  // The GitHub card lives inside the drawer's GitHub panel (built once). The
  // connect and repo-list groups are each a .ds-settings-section so the GitHub
  // tab reads the same as the Settings tab's grouped sections. Element IDs are
  // preserved so refreshGithub and the search filter keep working.
  const panel = $("dsDrawerPanel_github");
  if (!panel) return; // drawer not built yet (boot builds the drawer first)
  const card = el("div", "ds-card ds-card-wide");
  card.id = "dsReposOverlay";
  // GitHub connect section
  const connect = settingsSection("GitHub", "Connect with a Personal Access Token (repo read). Stored in the macOS Keychain — never on disk or sent to the NAS.");
  connect.sec.id = "dsGhConnect";
  const tokRow = el("div", "ds-row");
  const tokInput = document.createElement("input");
  tokInput.id = "dsGhToken"; tokInput.type = "password"; tokInput.placeholder = "ghp_…";
  const connectBtn = el("button", "ds-btn", "Connect");
  tokRow.appendChild(tokInput); tokRow.appendChild(connectBtn);
  connect.body.appendChild(tokRow);
  const ghStatus = el("div", "ds-note"); ghStatus.id = "dsGhStatus";
  connect.body.appendChild(ghStatus);
  card.appendChild(connect.sec);
  // GitHub repo list section (hidden until connected). Built with the shared
  // settingsSection() helper so it matches every other drawer tab's sections.
  const discBtn = el("button", "ds-btn ds-btn-ghost ds-btn-sm", "Disconnect");
  const list = settingsSection("Your GitHub repos", null, discBtn);
  list.sec.id = "dsGhList";
  list.sec.classList.add("hidden");
  const searchRow = el("div", "ds-row");
  const searchInput = document.createElement("input");
  searchInput.id = "dsGhSearch"; searchInput.type = "search"; searchInput.placeholder = "Filter repos…";
  searchRow.appendChild(searchInput);
  list.body.appendChild(searchRow);
  searchInput.addEventListener("input", () => {
    const q = searchInput.value.trim().toLowerCase();
    const body = $("dsGhBody"); if (!body) return;
    body.innerHTML = "";
    const filtered = !q ? ghReposCache : ghReposCache.filter(r => r.full_name.toLowerCase().includes(q));
    if (!filtered.length) { body.appendChild(el("div", "ds-note", "No matching repos.")); return; }
    filtered.forEach(r => body.appendChild(ghRow(r)));
  });
  const ghBody = el("div", null); ghBody.id = "dsGhBody";
  list.body.appendChild(ghBody);
  card.appendChild(list.sec);
  panel.appendChild(card);
  connectBtn.onclick = async () => {
    const token = tokInput.value.trim();
    if (!token) { ghStatus.textContent = "Paste a token."; return; }
    connectBtn.disabled = true; ghStatus.textContent = "Connecting…";
    const r = await sid("github/connect", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
    connectBtn.disabled = false;
    const d = (r && r.data) || {};
    if (d.ok) { tokInput.value = ""; refreshGithub(); refreshGithubDot(); }
    else ghStatus.textContent = "Failed: " + (d.error || r.status);
  };
  discBtn.onclick = async () => { await sid("github/disconnect", { method: "POST" }); refreshGithub(); refreshGithubDot(); };
}

// openWorkingChanges opens the drawer's Changes tab on the all-workspaces view:
// the current `git diff` across all local clones with a Revert button per repo
// (git checkout -- . + git clean -fd). Lets the user review/undo agent-made edits
// across every workspace without a terminal. The #dsChangesBody container is
// built by openChangesPanel inside #dsChangesAll.
function openWorkingChanges() {
  _dsChangesView = "all";
  openDrawer("changes");
}

async function refreshWorkingChanges() {
  const body = $("dsChangesBody"); if (!body) return;
  body.innerHTML = "";
  body.appendChild(el("div", "ds-note", "Loading…"));
  const local = await sid("repos/local");
  body.innerHTML = "";
  if (!local.ok || !Array.isArray(local.data)) { body.appendChild(el("div", "ds-note", "Could not load local clones.")); return; }
  if (!local.data.length) { body.appendChild(el("div", "ds-note", "No local clones yet.")); return; }
  for (const r of local.data) {
    const revertBtn = el("button", "ds-btn ds-btn-ghost ds-btn-sm", "Revert");
    const section = settingsSection(r.name + " (" + r.branch + ")", null, revertBtn);
    revertBtn.onclick = async () => {
      const ok = await dsConfirm("Revert all working changes?", "This discards all uncommitted edits in " + r.name + " (git checkout -- . && git clean -fd).");
      if (!ok) return;
      revertBtn.disabled = true; revertBtn.textContent = "Reverting…";
      const res = await sid("repos/revert", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: r.name }) });
      revertBtn.disabled = false; revertBtn.textContent = "Revert";
      const d = (res && res.data) || {};
      if (!d.ok) flashDsErr(d.error || res.status);
      refreshWorkingChanges();
    };
    const diffWrap = el("div", "ds-approval-pre-wrap");
    section.body.appendChild(diffWrap);
    body.appendChild(section.sec);
    // Fetch the diff for this repo.
    const dr = await sid("repos/diff", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: r.name }) });
    const dd = (dr && dr.data) || {};
    if (dr.ok && dd.diff && dd.diff.trim()) {
      renderApprovalContent(diffWrap, "apply_patch", dd.diff);
    } else {
      diffWrap.appendChild(el("div", "ds-note", "No uncommitted changes."));
    }
  }
}

// --- My Work: cross-workspace dashboard (drawer My Work tab) ----------------
// One pane showing every connected workspace's live state: sessions in progress,
// git dirty/ahead/behind, and open PRs. Built from /api/repos + /api/conversations
// + /repos/state + /repos/prs. The card (id dsMyWorkOverlay, with #dsMyWorkBody)
// is built lazily into the drawer's My Work panel by loadMyWork.
function openMyWork() { openDrawer("mywork"); }

async function loadMyWork() {
  let body = $("dsMyWorkBody");
  if (!body) {
    const panel = $("dsDrawerPanel_mywork"); if (!panel) return;
    const card = el("div", "ds-card ds-card-wide"); card.id = "dsMyWorkOverlay";
    body = el("div", null); body.id = "dsMyWorkBody";
    card.appendChild(body);
    panel.appendChild(card);
  }
  body.innerHTML = "";
  body.appendChild(el("div", "ds-note", "Loading…"));
  // Workspaces (backend repos) + all conversations (to count sessions per workspace).
  const [rr, cr] = await Promise.all([
    fetch("/api/repos"), fetch("/api/conversations"),
  ].map((p) => p.then((r) => r.ok ? r.json() : Promise.resolve([])).catch(() => [])));
  const repos = Array.isArray(rr) ? rr : [];
  const convs = Array.isArray(cr) ? cr : [];
  body.innerHTML = "";
  if (!repos.length) { body.appendChild(el("div", "ds-note", "No workspaces connected yet.")); return; }
  // Index sessions (conversations with a repoId) by repo id.
  const sessionsByRepoId = new Map();
  for (const c of convs) {
    if (c && c.repoId) {
      if (!sessionsByRepoId.has(c.repoId)) sessionsByRepoId.set(c.repoId, []);
      sessionsByRepoId.get(c.repoId).push(c);
    }
  }
  for (const rp of repos) {
    const fullName = rp.fullName || rp.name || "(unnamed)";
    const sessions = sessionsByRepoId.get(rp.id) || [];
    const sub = sessions.length + " session" + (sessions.length === 1 ? "" : "s");
    const section = settingsSection(fullName, sub);
    const detail = el("div", "ds-note");
    section.body.appendChild(detail);
    body.appendChild(section.sec);
    // Live git state + open PRs for this workspace (best-effort, parallel).
    const stateP = sid("repos/state?name=" + encodeURIComponent(fullName)).catch(() => null);
    const prsP = sid("repos/prs?name=" + encodeURIComponent(fullName)).catch(() => null);
    stateP.then((sr) => {
      const sd = (sr && sr.data) || {};
      const segs = [];
      if (sd.useGit === false) segs.push("no git (file tools only)");
      else {
        if (sd.branch) segs.push("⎇ " + sd.branch);
        if (sd.dirty) segs.push("●" + sd.dirty + " dirty");
        if (sd.ahead) segs.push("↑" + sd.ahead);
        if (sd.behind) segs.push("↓" + sd.behind);
        if (sd.hasRemote === false) segs.push("no remote");
      }
      detail.appendChild(document.createTextNode(segs.length ? segs.join(" · ") : "up to date"));
    });
    prsP.then((pr) => {
      const pd = (pr && pr.data) || {};
      if (pr && pr.ok && Array.isArray(pd.prs) && pd.prs.length) {
        const prList = el("div", "ds-note");
        prList.appendChild(document.createTextNode("Open PRs: "));
        pd.prs.slice(0, 5).forEach((p, i) => {
          if (i) prList.appendChild(document.createTextNode(", "));
          const a = document.createElement("a"); a.className = "ds-pr-open"; a.href = p.html_url; a.target = "_blank"; a.rel = "noopener"; a.textContent = "#" + p.number;
          a.title = p.title || "";
          prList.appendChild(a);
        });
        if (pd.prs.length > 5) prList.appendChild(document.createTextNode(" +" + (pd.prs.length - 5) + " more"));
        section.body.appendChild(prList);
      }
    });
    // List this workspace's sessions (click to open).
    if (sessions.length) {
      const list = el("div", "ds-repo-chats");
      sessions.slice(0, 6).forEach((c) => {
        const cr = el("div", "ds-repo-chat");
        cr.appendChild(el("span", "ds-repo-chat-title", c.title || "New chat"));
        if (c.repoBranch) cr.appendChild(el("span", "ds-repo-chat-branch", "⎇ " + c.repoBranch));
        cr.onclick = () => { try { localStorage.setItem("nas-llm-conv", c.id); } catch {} navigateToConv(c.id); closeDrawer(); };
        list.appendChild(cr);
      });
      if (sessions.length > 6) list.appendChild(el("div", "ds-note", "+" + (sessions.length - 6) + " more sessions"));
      section.body.appendChild(list);
    }
  }
}

// --- Ship changes wizard (review diff, write changelog, commit/push) -------
// openShipChanges builds the dialog once and reuses it; loadShipChanges fills
// it with the repo's push state, the current diff, and a changelog pre-fill.
function openShipChanges(r) {
  let overlay = $("dsShipOverlay");
  if (!overlay) {
    overlay = el("div", "ds-overlay");
    overlay.id = "dsShipOverlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "Ship changes");
    const card = el("div", "ds-card ds-card-wide");
    const head = el("div", "ds-head");
    head.appendChild(el("h2", null, "Ship changes"));
    const x = el("button", "ds-x"); x.textContent = "×"; x.title = "Close"; x.setAttribute("aria-label", "Close");
    x.onclick = () => overlay.classList.remove("open");
    head.appendChild(x);
    card.appendChild(head);
    const status = el("div", "ds-note"); status.id = "dsShipStatus";
    card.appendChild(status);
    const diffWrap = el("div", "ds-approval-pre-wrap"); diffWrap.id = "dsShipDiff";
    card.appendChild(diffWrap);
    card.appendChild(el("div", "ds-label", "Version"));
    const versionInput = document.createElement("input"); versionInput.id = "dsShipVersion"; versionInput.type = "text"; versionInput.placeholder = "0.2.0";
    card.appendChild(versionInput);
    card.appendChild(el("div", "ds-label", "Changelog"));
    const clArea = document.createElement("textarea"); clArea.id = "dsShipChangelog"; clArea.rows = 5; clArea.placeholder = "What changed in this version (one bullet per line).";
    card.appendChild(clArea);
    card.appendChild(el("div", "ds-label", "Commit message"));
    const msgInput = document.createElement("input"); msgInput.id = "dsShipMessage"; msgInput.type = "text"; msgInput.placeholder = "Release 0.2.0";
    card.appendChild(msgInput);
    const row = el("div", "ds-row ds-approval-row");
    const commitBtn = el("button", "ds-btn", "Commit");
    const pushBtn = el("button", "ds-btn ds-btn-approve", "Commit & push");
    row.appendChild(commitBtn); row.appendChild(pushBtn);
    card.appendChild(row);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.classList.remove("open"); });
    overlay._commit = (push) => shipCommit(r, push);
    commitBtn.onclick = () => overlay._commit(false);
    pushBtn.onclick = () => overlay._commit(true);
  } else {
    overlay._commit = (push) => shipCommit(r, push);
  }
  overlay.classList.add("open");
  loadShipChanges(r);
}

async function loadShipChanges(r) {
  const status = $("dsShipStatus");
  const diffWrap = $("dsShipDiff");
  if (status) status.textContent = "Loading repo state…";
  if (diffWrap) diffWrap.innerHTML = "";
  const cl = await sid("repos/changelog", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: r.name }) });
  const cd = (cl && cl.data) || {};
  const dr = await sid("repos/diff", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: r.name }) });
  const dd = (dr && dr.data) || {};
  if (status) {
    const remoteTxt = cd.remote ? cd.remote : "no remote";
    status.textContent = "branch " + (cd.branch || r.branch || "?") + " · " + (cd.ahead || 0) + " ahead · " + (cd.behind || 0) + " behind · remote: " + remoteTxt;
  }
  if (diffWrap) {
    if (dd.diff && dd.diff.trim()) renderApprovalContent(diffWrap, "apply_patch", dd.diff);
    else diffWrap.appendChild(el("div", "ds-note", "No uncommitted changes to ship."));
  }
  const clArea = $("dsShipChangelog");
  if (clArea && clArea._prefilled !== true) {
    let prefill = "";
    if (cd.changelog && cd.changelog.trim()) prefill = cd.changelog.trim();
    else if (Array.isArray(cd.unpushed) && cd.unpushed.length) prefill = cd.unpushed.map((s) => "- " + s).join("\n");
    clArea.value = prefill;
    clArea._prefilled = true;
  }
  const overlay = $("dsShipOverlay");
  const pBtn = overlay && overlay.querySelector(".ds-btn-approve");
  if (pBtn) {
    if (!cd.remote) { pBtn.disabled = true; pBtn.title = "No remote configured for this repo."; }
    else { pBtn.disabled = false; pBtn.title = ""; }
  }
}

async function shipCommit(r, push) {
  const status = $("dsShipStatus");
  const version = ($("dsShipVersion") && $("dsShipVersion").value.trim()) || "";
  const changelog = ($("dsShipChangelog") && $("dsShipChangelog").value) || "";
  const message = ($("dsShipMessage") && $("dsShipMessage").value.trim()) || "";
  if (!version) { if (status) status.textContent = "Enter a version (e.g. 0.2.0)."; return; }
  if (push) {
    const ok = await dsConfirm("Push to the remote?", "This commits the staged changes and pushes " + r.name + " to its origin.");
    if (!ok) return;
  }
  if (status) status.textContent = push ? "Committing and pushing…" : "Committing…";
  const res = await sid("repos/ship", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repo: r.name, version, changelog, message, push }) });
  const d = (res && res.data) || {};
  if (d.ok) {
    const head = (d.head || "").slice(0, 7);
    if (status) status.textContent = push ? (d.pushed ? "Pushed ✓ (head " + head + ")" : ("Committed, but push failed: " + (d.error || "unknown"))) : "Committed ✓ (head " + head + ")";
    refreshLocal();
  } else {
    if (status) status.textContent = "Failed: " + (d.error || res.status || "unknown");
  }
}

// --- Changes tab (desktop-only) ---
// The drawer's Changes tab hosts two views: this chat's session (commit/push/PR/
// merge/revert on the chat's own branch) and cross-workspace working changes.
// openSessionPanel (called from the composer status line) opens the session view;
// openWorkingChanges opens the all-workspaces view. The session card
// (id dsSessionOverlay) is built once into #dsChangesSession and rebound per chat.
function openSessionPanel(repoName) {
  _dsChangesRepo = repoName || railRepo || "";
  _dsChangesView = "session";
  openDrawer("changes");
}

// openChangesPanel builds the Changes tab's view toggle + two containers once,
// then renders the active view. Called from openDrawer when the Changes tab opens.
function openChangesPanel() {
  const panel = $("dsDrawerPanel_changes"); if (!panel) return;
  if (!panel.firstChild) {
    const seg = el("div", "ds-changes-seg");
    const bSess = el("button", "ds-seg-btn active", "This chat");
    const bAll = el("button", "ds-seg-btn", "All workspaces");
    seg.appendChild(bSess); seg.appendChild(bAll);
    panel.appendChild(seg);
    const sessWrap = el("div"); sessWrap.id = "dsChangesSession";
    panel.appendChild(sessWrap);
    const allWrap = el("div"); allWrap.id = "dsChangesAll"; allWrap.style.display = "none";
    const allBody = el("div"); allBody.id = "dsChangesBody";
    allWrap.appendChild(allBody);
    panel.appendChild(allWrap);
    bSess.onclick = () => { _dsChangesView = "session"; bSess.classList.add("active"); bAll.classList.remove("active"); sessWrap.style.display = ""; allWrap.style.display = "none"; renderSessionView(); };
    bAll.onclick = () => { _dsChangesView = "all"; bAll.classList.add("active"); bSess.classList.remove("active"); sessWrap.style.display = "none"; allWrap.style.display = ""; refreshWorkingChanges(); };
  }
  const seg = panel.querySelector(".ds-changes-seg");
  const bSess = seg && seg.children[0], bAll = seg && seg.children[1];
  const sessWrap = $("dsChangesSession"), allWrap = $("dsChangesAll");
  if (_dsChangesView === "all") {
    if (bSess) bSess.classList.remove("active"); if (bAll) bAll.classList.add("active");
    if (sessWrap) sessWrap.style.display = "none"; if (allWrap) allWrap.style.display = "";
    refreshWorkingChanges();
  } else {
    if (bSess) bSess.classList.add("active"); if (bAll) bAll.classList.remove("active");
    if (sessWrap) sessWrap.style.display = ""; if (allWrap) allWrap.style.display = "none";
    renderSessionView();
  }
}

// renderSessionView builds (once) and rebinds the per-chat session card, then
// loads its diff/PRs. Operates on the active chat's branch (railConv.repoBranch).
function renderSessionView() {
  const repoName = _dsChangesRepo || railRepo || "";
  const branch = (railConv && railConv.repoBranch) || "";
  const chatTitle = (railConv && railConv.title) || "";
  buildSessionCard();
  const overlay = $("dsSessionOverlay"); if (!overlay) return;
  const prev = overlay._repo;
  overlay._rebind(repoName, branch);
  const h2 = $("dsSessionTitle"); if (h2) h2.textContent = chatTitle || "Session";
  if (prev !== repoName) {
    const m = $("dsSessionMsg"); if (m) m.value = "";
    const pt = $("dsSessionPrTitle"); if (pt) pt.value = "";
    const pb = $("dsSessionPrBody"); if (pb) pb.value = "";
  }
  const co = $("dsSessionCommitOut"); if (co) co.textContent = "";
  const po = $("dsSessionPrOut"); if (po) po.textContent = "";
  const mo = $("dsSessionMergeOut"); if (mo) mo.textContent = "";
  if (overlay._tabs) overlay._switchTab(overlay._tabs.tabChanges, overlay._tabs.pChanges);
  loadSessionPanel(repoName, branch);
}

// buildSessionCard constructs the per-chat session card (Changes/Pull request/Merge
// sub-tabs) once into #dsChangesSession. All element IDs/handlers match the old
// standalone overlay so loadSessionPanel/sessionCommit/etc. keep working.
function buildSessionCard() {
  if ($("dsSessionOverlay")) return;
  const wrap = $("dsChangesSession"); if (!wrap) return;
  // The session panel is one .ds-settings-section card (matching every other
  // drawer tab): head carries the chat title + branch/state sub, body holds the
  // Changes/Pull request/Merge sub-tabs and their panels. The drawer's own X
  // closes (and stops agent merge), so there's no separate close button here.
  // Element IDs are unchanged so loadSessionPanel/session*/renderSessionView
  // keep working; overlay._* refs are hung on the section element.
  const overlay = el("div", "ds-settings-section"); overlay.id = "dsSessionOverlay";
  const head = el("div", "ds-settings-section-head");
  const h2 = el("div", "ds-settings-section-title", "Session"); h2.id = "dsSessionTitle";
  head.appendChild(h2);
  const sub = el("div", "ds-settings-section-sub"); sub.id = "dsSessionSub";
  head.appendChild(sub);
  overlay.appendChild(head);
  const sbody = el("div", "ds-settings-section-body");
  const tabs = el("div", "ds-tabs");
  const tabChanges = el("button", "ds-tab active", "Changes");
  const tabPR = el("button", "ds-tab", "Pull request");
  const tabMerge = el("button", "ds-tab", "Merge");
  tabs.appendChild(tabChanges); tabs.appendChild(tabPR); tabs.appendChild(tabMerge);
  sbody.appendChild(tabs);
  const panels = el("div", "ds-tab-panels");
  // — Changes —
  const pChanges = el("div", "ds-tab-panel active");
  const diffWrap = el("div", "ds-approval-pre-wrap ds-session-diff"); diffWrap.id = "dsSessionDiff";
  pChanges.appendChild(diffWrap);
  const msgInput = document.createElement("input"); msgInput.id = "dsSessionMsg"; msgInput.type = "text"; msgInput.placeholder = "Commit message"; msgInput.className = "ds-session-input";
  pChanges.appendChild(msgInput);
  const commitRow = el("div", "ds-session-actions");
  const commitBtn = el("button", "ds-btn", "Commit");
  const pushBtn = el("button", "ds-btn ds-btn-approve", "Commit & push");
  commitRow.appendChild(commitBtn); commitRow.appendChild(pushBtn);
  pChanges.appendChild(commitRow);
  const commitOut = el("div", "ds-note"); commitOut.id = "dsSessionCommitOut";
  pChanges.appendChild(commitOut);
  const revertBtn = el("button", "ds-btn ds-btn-ghost ds-session-link", "Revert all changes");
  pChanges.appendChild(revertBtn);
  const noGitNote = el("div", "ds-note ds-session-nogit"); noGitNote.id = "dsSessionNoGit"; noGitNote.style.display = "none";
  noGitNote.textContent = "This workspace isn't under git, so commit, push, branches, and pull requests aren't available. Enable git to start tracking changes.";
  pChanges.appendChild(noGitNote);
  const enableGitBtn = el("button", "ds-btn", "Enable git"); enableGitBtn.id = "dsSessionEnableGit"; enableGitBtn.style.display = "none";
  pChanges.appendChild(enableGitBtn);
  const undoBtn = el("button", "ds-btn ds-btn-ghost ds-session-link", "Undo last write"); undoBtn.id = "dsSessionUndoLast"; undoBtn.style.display = "none";
  pChanges.appendChild(undoBtn);
  panels.appendChild(pChanges);
  overlay._gitControls = { tabPR, tabMerge, commitBtn, pushBtn, revertBtn, msgInput, noGitNote, enableGitBtn, undoBtn };
  enableGitBtn.onclick = () => { if (overlay._repo) enableGit({ name: overlay._repo, path: "" }); };
  undoBtn.onclick = () => { if (overlay._repo) undoLastWrite(overlay._repo); };
  // — Pull request —
  const pPR = el("div", "ds-tab-panel");
  const prTitle = document.createElement("input"); prTitle.id = "dsSessionPrTitle"; prTitle.type = "text"; prTitle.placeholder = "PR title"; prTitle.className = "ds-session-input";
  pPR.appendChild(prTitle);
  const prBody = document.createElement("textarea"); prBody.id = "dsSessionPrBody"; prBody.rows = 4; prBody.placeholder = "Description"; prBody.className = "ds-session-input";
  pPR.appendChild(prBody);
  const prRow = el("div", "ds-session-actions");
  const prBtn = el("button", "ds-btn ds-btn-approve", "Open PR");
  prRow.appendChild(prBtn);
  pPR.appendChild(prRow);
  const prOut = el("div", "ds-note"); prOut.id = "dsSessionPrOut";
  pPR.appendChild(prOut);
  panels.appendChild(pPR);
  // — Merge —
  const pMerge = el("div", "ds-tab-panel");
  const prSelect = document.createElement("select"); prSelect.id = "dsSessionPrSelect"; prSelect.className = "ds-session-input";
  pMerge.appendChild(prSelect);
  const mergeRow = el("div", "ds-session-actions");
  const mergeMethod = document.createElement("select"); mergeMethod.id = "dsSessionMergeMethod"; mergeMethod.className = "ds-session-select";
  ["merge", "squash", "rebase"].forEach((m) => { const o = document.createElement("option"); o.value = m; o.textContent = m; mergeMethod.appendChild(o); });
  const mergeBtn = el("button", "ds-btn ds-btn-approve", "Merge"); mergeBtn.id = "dsSessionMergeBtn";
  mergeRow.appendChild(mergeMethod); mergeRow.appendChild(mergeBtn);
  pMerge.appendChild(mergeRow);
  const mergeOut = el("div", "ds-note"); mergeOut.id = "dsSessionMergeOut";
  pMerge.appendChild(mergeOut);
  const amRow = el("label", "ds-ws-check-row");
  const agentMergeCheck = document.createElement("input"); agentMergeCheck.id = "dsSessionAgentMerge"; agentMergeCheck.type = "checkbox";
  amRow.appendChild(agentMergeCheck);
  amRow.appendChild(el("span", "ds-ws-check-label", "Agent merge — auto-merge when CI is green"));
  pMerge.appendChild(amRow);
  const amOut = el("div", "ds-note"); amOut.id = "dsSessionAgentMergeOut";
  pMerge.appendChild(amOut);
  panels.appendChild(pMerge);
  overlay._agentMerge = { check: agentMergeCheck, out: amOut, timer: null };
  wireAgentMergeToggle(overlay);
  sbody.appendChild(panels);
  const foot = el("div", "ds-session-foot");
  const shipBtn = el("button", "ds-btn-ghost ds-session-link", "Ship a release…");
  foot.appendChild(shipBtn);
  sbody.appendChild(foot);
  overlay.appendChild(sbody);
  wrap.appendChild(overlay);
  const switchTab = (active, panel) => {
    [tabChanges, tabPR, tabMerge].forEach((t) => t.classList.remove("active"));
    [pChanges, pPR, pMerge].forEach((p) => p.classList.remove("active"));
    active.classList.add("active"); panel.classList.add("active");
  };
  tabChanges.onclick = () => switchTab(tabChanges, pChanges);
  tabPR.onclick = () => switchTab(tabPR, pPR);
  tabMerge.onclick = () => switchTab(tabMerge, pMerge);
  overlay._switchTab = switchTab;
  overlay._tabs = { tabChanges, pChanges };
  overlay._rebind = (name, br) => {
    overlay._repo = name;
    overlay._branch = br;
    overlay._commit = (push) => sessionCommit(name, br, push);
    overlay._createPR = () => sessionCreatePR(name, br);
    overlay._mergePR = () => sessionMergePR(name, br);
    overlay._revert = () => sessionRevert(name, br);
    overlay._ship = () => { closeDrawer(); openShipChanges({ name }); };
  };
  commitBtn.onclick = () => overlay._commit(false);
  pushBtn.onclick = () => overlay._commit(true);
  prBtn.onclick = () => overlay._createPR();
  mergeBtn.onclick = () => overlay._mergePR();
  revertBtn.onclick = () => overlay._revert();
  shipBtn.onclick = () => overlay._ship();
}

async function loadSessionPanel(repoName, branch) {
  const overlay = $("dsSessionOverlay"); if (!overlay) return;
  const sub = $("dsSessionSub");
  const diffWrap = $("dsSessionDiff");
  if (sub) sub.textContent = "Loading…";
  if (diffWrap) diffWrap.innerHTML = "";
  const qp = "name=" + encodeURIComponent(repoName) + (branch ? "&branch=" + encodeURIComponent(branch) : "");
  const sr = await sid("repos/state?" + qp);
  const sd = (sr && sr.data) || {};
  // Non-git workspace: hide the git-only controls (commit/push/PR/merge/revert),
  // show a "no git" note + an Enable-git button, and skip the diff/PRs loads
  // (those routes return not-enabled for a non-git workspace).
  if (sd.useGit === false) {
    if (sub) sub.textContent = repoName + " · no git";
    if (diffWrap) {
      diffWrap.innerHTML = "";
      diffWrap.appendChild(el("div", "ds-note", "This workspace isn't under git, so there's no diff or commit history. Enable git to start tracking changes."));
    }
    if (overlay._gitControls) {
      const gc = overlay._gitControls;
      gc.tabPR.style.display = "none";
      gc.tabMerge.style.display = "none";
      gc.commitBtn.style.display = "none";
      gc.pushBtn.style.display = "none";
      gc.revertBtn.style.display = "none";
      gc.msgInput.style.display = "none";
      gc.noGitNote.style.display = "";
      gc.enableGitBtn.style.display = "";
      gc.undoBtn.style.display = "";
    }
    overlay.querySelectorAll(".ds-btn-approve").forEach((b) => { b.disabled = true; b.title = "No git."; });
    return;
  }
  // Git workspace: ensure the git-only controls are visible (in case the panel
  // was previously opened for a non-git workspace).
  if (overlay._gitControls) {
    const gc = overlay._gitControls;
    gc.tabPR.style.display = "";
    gc.tabMerge.style.display = "";
    gc.commitBtn.style.display = "";
    gc.pushBtn.style.display = "";
    gc.revertBtn.style.display = "";
    gc.msgInput.style.display = "";
    gc.noGitNote.style.display = "none";
    gc.enableGitBtn.style.display = "none";
    gc.undoBtn.style.display = "none";
  }
  const diffBody = { name: repoName }; if (branch) diffBody.branch = branch;
  const dr = await sid("repos/diff", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(diffBody) });
  const dd = (dr && dr.data) || {};
  if (sub) {
    const segs = [repoName];
    if (sd.branch) segs.push("⎇ " + sd.branch);
    if (sd.dirty) segs.push("●" + sd.dirty);
    if (sd.ahead) segs.push("↑" + sd.ahead);
    if (sd.behind) segs.push("↓" + sd.behind);
    if (sd.hasRemote === false) segs.push("no remote");
    sub.textContent = segs.join(" · ");
  }
  if (diffWrap) {
    if (dr.ok && dd.diff && dd.diff.trim()) renderApprovalContent(diffWrap, "apply_patch", dd.diff);
    else diffWrap.appendChild(el("div", "ds-note", "No uncommitted changes."));
  }
  const hasRemote = sd.hasRemote !== false;
  overlay.querySelectorAll(".ds-btn-approve").forEach((b) => {
    if (!hasRemote) { b.disabled = true; b.title = "No remote configured for this repo."; }
    else { b.disabled = false; b.title = ""; }
  });
  loadSessionPRs(repoName, branch);
}

async function sessionCommit(repoName, branch, push) {
  const out = $("dsSessionCommitOut");
  const msg = ($("dsSessionMsg") && $("dsSessionMsg").value.trim()) || "";
  if (!msg) { if (out) out.textContent = "Enter a commit message."; return; }
  if (push) {
    const ok = await dsConfirm("Push to the remote?", "This commits and pushes " + repoName + (branch ? " (" + branch + ")" : "") + " to its origin.");
    if (!ok) return;
  }
  if (out) out.textContent = push ? "Committing and pushing…" : "Committing…";
  const body = { repo: repoName, message: msg, push }; if (branch) body.branch = branch;
  const res = await sid("repos/commit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const d = (res && res.data) || {};
  if (d.ok) {
    const head = (d.head || "").slice(0, 7);
    if (out) out.textContent = push ? (d.pushed ? "Pushed ✓ (head " + head + ")" : ("Committed, but push failed: " + (d.error || "unknown"))) : "Committed ✓ (head " + head + ")";
    loadSessionPanel(repoName, branch);
    refreshRailState();
    refreshLocal();
  } else {
    if (out) out.textContent = "Failed: " + (d.error || res.status || "unknown");
  }
}

async function sessionCreatePR(repoName, branch) {
  const out = $("dsSessionPrOut");
  const title = ($("dsSessionPrTitle") && $("dsSessionPrTitle").value.trim()) || "";
  const body = ($("dsSessionPrBody") && $("dsSessionPrBody").value) || "";
  if (!title) { if (out) out.textContent = "Enter a PR title."; return; }
  if (out) out.textContent = "Pushing branch and opening PR…";
  const reqBody = { repo: repoName, title, body }; if (branch) reqBody.branch = branch;
  const res = await sid("repos/create-pr", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(reqBody) });
  const d = (res && res.data) || {};
  if (d.ok && d.url) {
    if (out) {
      out.innerHTML = "";
      out.appendChild(document.createTextNode("PR opened ✓ "));
      const a = document.createElement("a"); a.className = "ds-pr-open"; a.href = d.url; a.target = "_blank"; a.rel = "noopener"; a.textContent = "Open"; a.title = d.url;
      out.appendChild(a);
      out.appendChild(el("span", "ds-pr-url", " " + d.url));
    }
    refreshRailState();
  } else {
    if (out) out.textContent = "Failed: " + (d.error || res.status || "unknown");
  }
}

async function sessionRevert(repoName, branch) {
  const ok = await dsConfirm("Revert all working changes?", "This runs git checkout -- . && git clean -fd in " + repoName + (branch ? " (" + branch + ")" : "") + ", discarding all uncommitted edits.");
  if (!ok) return;
  const body = { name: repoName }; if (branch) body.branch = branch;
  const res = await sid("repos/revert", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const d = (res && res.data) || {};
  if (!d.ok) flashDsErr(d.error || res.status);
  loadSessionPanel(repoName, branch);
  refreshRailState();
  refreshLocal();
}

// undoLastWrite restores the newest recovery snapshot for a non-git workspace via
// /repos/undo-last, undoing the most recent approved write tool. Non-git only
// (git workspaces use sessionRevert). Confirms first because it overwrites the
// workspace's working files with the pre-write snapshot.
async function undoLastWrite(repoName) {
  const ok = await dsConfirm("Undo the last write?", "This restores the workspace \"" + repoName + "\" to its state before the most recent approved edit, discarding that edit's changes.");
  if (!ok) return;
  const res = await sid("repos/undo-last", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: repoName }) });
  const d = (res && res.data) || {};
  if (d.ok) { flashDsOk("Undid last write ✓"); refreshLocal(); refreshRailState(); }
  else flashDsErr("Could not undo: " + (d.error || res.status || "nothing to restore"));
}

async function loadSessionPRs(repoName, branch) {
  const sel = $("dsSessionPrSelect"); if (!sel) return;
  const mergeBtn = $("dsSessionMergeBtn");
  sel.innerHTML = "";
  const qp = "name=" + encodeURIComponent(repoName) + (branch ? "&branch=" + encodeURIComponent(branch) : "");
  const r = await sid("repos/prs?" + qp);
  const d = (r && r.data) || {};
  if (!r.ok || !Array.isArray(d.prs)) {
    const o = document.createElement("option");
    o.value = ""; o.textContent = d.error ? "Couldn't load PRs: " + d.error : "Couldn't load PRs";
    sel.appendChild(o);
    sel.disabled = true;
    if (mergeBtn) { mergeBtn.disabled = true; mergeBtn.title = ""; }
    return;
  }
  if (!d.prs.length) {
    const o = document.createElement("option"); o.value = ""; o.textContent = "No open PRs"; sel.appendChild(o);
    sel.disabled = true;
    if (mergeBtn) { mergeBtn.disabled = true; mergeBtn.title = "No open PRs"; }
    return;
  }
  sel.disabled = false;
  d.prs.forEach((pr) => {
    const o = document.createElement("option");
    o.value = String(pr.number);
    const draft = pr.draft ? " [draft]" : "";
    const ci = pr.ci_state ? " · CI=" + pr.ci_state : "";
    o.textContent = `#${pr.number} ${pr.title}${draft}${ci}`;
    sel.appendChild(o);
  });
  if (mergeBtn) { mergeBtn.disabled = false; mergeBtn.title = ""; }
}

async function sessionMergePR(repoName, branch) {
  const out = $("dsSessionMergeOut");
  const sel = $("dsSessionPrSelect");
  const number = sel && sel.value ? parseInt(sel.value, 10) : 0;
  if (!number) { if (out) out.textContent = "Select a PR to merge."; return; }
  const method = ($("dsSessionMergeMethod") && $("dsSessionMergeMethod").value) || "merge";
  const ok = await dsConfirm("Merge PR #" + number + "?", "This merges PR #" + number + " in " + repoName + " via " + method + ". This is irreversible.");
  if (!ok) return;
  if (out) out.textContent = "Merging…";
  const body = { repo: repoName, number, method }; if (branch) body.branch = branch;
  const res = await sid("repos/merge-pr", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const d = (res && res.data) || {};
  if (d.ok) {
    const sha = (d.sha || "").slice(0, 7);
    if (out) out.textContent = "Merged ✓ PR #" + number + (sha ? " (sha " + sha + ")" : "");
    loadSessionPRs(repoName, branch);
    refreshRailState();
  } else {
    if (out) out.textContent = "Failed: " + (d.error || res.status || "unknown");
  }
}

// --- Agent Merge: auto-merge a PR once CI is green + reviewers satisfied ----------
// Toggled on the session-panel Merge tab. When on, polls /repos/prs for the
// selected PR's CI + review state; when CI is "success" and review is approved
// (or no reviews are required), calls /repos/merge-pr. Stops itself on a
// successful merge, a failure, or when the user toggles it off / closes the panel.
function agentMergeTick(repoName, branch) {
  const overlay = $("dsSessionOverlay");
  if (!overlay) return;
  const am = overlay._agentMerge;
  if (!am || !am.check || !am.check.checked) { stopAgentMerge(overlay); return; }
  const sel = $("dsSessionPrSelect");
  const number = sel && sel.value ? parseInt(sel.value, 10) : 0;
  const out = am.out;
  if (!number) { if (out) out.textContent = "Select a PR to watch, then toggle Agent merge."; return; }
  const method = ($("dsSessionMergeMethod") && $("dsSessionMergeMethod").value) || "merge";
  const qp = "name=" + encodeURIComponent(repoName) + (branch ? "&branch=" + encodeURIComponent(branch) : "");
  sid("repos/prs?" + qp).then((r) => {
    const d = (r && r.data) || {};
    if (!r.ok || !Array.isArray(d.prs)) { if (out) out.textContent = "Watching… (couldn't refresh PRs: " + (d.error || r.status) + ")"; return; }
    const pr = d.prs.find((p) => String(p.number) === String(number));
    if (!pr) { if (out) out.textContent = "PR #" + number + " is no longer open (merged or closed?). Stopping."; stopAgentMerge(overlay); return; }
    const ci = pr.ci_state || "";
    const rev = pr.review_state || "";
    const ciOk = ci === "success";
    // review_state is APPROVED / REVIEW_REQUESTED / COMMENTED / etc.; treat
    // APPROVED as ready. No required reviewers (empty/COMMENTED) is also ready —
    // the user toggled it, so they've decided.
    const revOk = rev === "APPROVED" || !rev || rev === "COMMENTED";
    if (ciOk && revOk) {
      if (out) out.textContent = "CI green, reviews clear — merging PR #" + number + "…";
      const body = { repo: repoName, number, method }; if (branch) body.branch = branch;
      sid("repos/merge-pr", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((mr) => {
        const md = (mr && mr.data) || {};
        if (md.ok) {
          if (out) out.textContent = "Agent-merged ✓ PR #" + number;
          stopAgentMerge(overlay);
          loadSessionPRs(repoName, branch);
          refreshRailState();
        } else {
          if (out) out.textContent = "Agent merge failed: " + (md.error || mr.status) + " — retrying next tick.";
        }
      });
    } else {
      if (out) out.textContent = "Watching PR #" + number + " — CI=" + (ci || "none") + ", reviews=" + (rev || "none") + "…";
    }
  });
}
function startAgentMerge(overlay, repoName, branch) {
  const am = overlay._agentMerge; if (!am) return;
  stopAgentMerge(overlay);
  if (am.out) am.out.textContent = "Agent merge on — watching the selected PR.";
  am.timer = setInterval(() => agentMergeTick(repoName, branch), 10000);
}
function stopAgentMerge(overlay) {
  const am = overlay && overlay._agentMerge; if (!am) return;
  if (am.timer) { clearInterval(am.timer); am.timer = null; }
}
// Wire the toggle: created in openSessionPanel's Merge tab build. Called once
// on first panel build; the checkbox state is read fresh each tick.
function wireAgentMergeToggle(overlay) {
  const am = overlay._agentMerge; if (!am || !am.check) return;
  am.check.onchange = () => {
    if (am.check.checked) {
      startAgentMerge(overlay, overlay._repo, overlay._branch);
    } else {
      stopAgentMerge(overlay);
      if (am.out) am.out.textContent = "";
    }
  };
}

function makeReposBtn() {
  const btn = el("button", "ds-head-btn ds-repos-btn");
  btn.title = "GitHub — connect account, browse & clone repos"; btn.setAttribute("aria-label", "GitHub");
  btn.innerHTML = dsIcon("github") + '<span class="ds-dot off"></span>';
  btn.onclick = (e) => { e.stopPropagation(); openRepos(); };
  return btn;
}

// makeMyWorkBtn is the header button that opens the cross-workspace dashboard.
function makeMyWorkBtn() {
  const btn = el("button", "ds-head-btn ds-mywork-btn");
  btn.title = "My Work — sessions, changes, and PRs across all workspaces"; btn.setAttribute("aria-label", "My Work");
  btn.innerHTML = dsIcon("mywork") + '<span class="ds-badge zero"></span>';
  btn.onclick = (e) => { e.stopPropagation(); openMyWork(); };
  return btn;
}

// makeChangesBtn is the header button that opens the drawer's Changes tab. Its
// badge (refreshChangesBadge) shows the active chat's dirty-file count so
// uncommitted work is always visible until pushed. Clicking opens this chat's
// session view when a repo chat is active, else the cross-workspace view.
function makeChangesBtn() {
  const btn = el("button", "ds-head-btn ds-changes-btn");
  btn.title = "Changes — review uncommitted work"; btn.setAttribute("aria-label", "Changes");
  btn.innerHTML = dsIcon("changes") + '<span class="ds-badge zero"></span>';
  btn.onclick = (e) => { e.stopPropagation(); if (railRepo) openSessionPanel(railRepo); else openWorkingChanges(); };
  return btn;
}

// --- Sidebar "Workspaces" section: workspace-bound chats ("sessions") live in
// the left sidebar under their workspace, with a "+" to connect a folder and a
// "⋯" for cross-workspace working changes. Injected into #sidebar, between
// #sideHead and #convList. Non-workspace chats ("chats", lightweight — no
// branch/worktree) stay in #convList, which gets its own "Chats" header below. ---
function toggleSidebarRepos() {
  const wrap = $("dsSidebarRepos"); if (!wrap) return;
  const collapsed = wrap.classList.toggle("collapsed");
  try { localStorage.setItem("nas-llm-repos-collapsed", collapsed ? "1" : "0"); } catch {}
}

function buildSidebarRepos() {
  if ($("dsSidebarRepos")) return;
  const sideHead = document.querySelector("#sideHead");
  const sidebar = sideHead && sideHead.parentElement;
  if (!sidebar) return;
  const wrap = el("div", "ds-sidebar-repos");
  wrap.id = "dsSidebarRepos";
  let collapsed = false;
  try { collapsed = localStorage.getItem("nas-llm-repos-collapsed") === "1"; } catch {}
  if (collapsed) wrap.classList.add("collapsed");
  const head = el("div", "ds-sidebar-repos-head");
  const chev = el("span", "ds-sidebar-repos-chev", "▾");
  const title = el("div", "ds-sidebar-repos-title", "Workspaces");
  head.appendChild(chev); head.appendChild(title);
  const changesBtn = el("button", "ds-sidebar-icon-btn", "⋯");
  changesBtn.title = "Working changes across all workspaces"; changesBtn.setAttribute("aria-label", "Working changes");
  changesBtn.onclick = (e) => { e.stopPropagation(); openWorkingChanges(); };
  const addBtn = el("button", "ds-sidebar-icon-btn", "+");
  addBtn.title = "Connect a workspace"; addBtn.setAttribute("aria-label", "Connect a workspace");
  addBtn.onclick = (e) => { e.stopPropagation(); openConnectMenu(addBtn); };
  head.appendChild(changesBtn); head.appendChild(addBtn);
  head.addEventListener("click", () => toggleSidebarRepos());
  wrap.appendChild(head);
  const body = el("div", "ds-sidebar-repos-body"); body.id = "dsLocalBody";
  wrap.appendChild(body);
  sidebar.insertBefore(wrap, sideHead.nextSibling);
}

// buildSidebarChatsHeader is now a no-op: www/index.html owns the "Chats"
// header (#chatsHead) with the New chat / New folder buttons, so the bridge no
// longer injects its own label. Kept as a stub because bootDesktop calls it.
function buildSidebarChatsHeader() {
  return;
}

// --- First-load "connect your repos" wizard --------------------------------
// Shown once, only the first time the app has zero connected repos. Either
// action (connect or skip) marks it seen so it never nags again.
function markRepoWizardSeen() { try { localStorage.setItem("nas-llm-repo-wizard-seen", "1"); } catch {} }

function showRepoWizard() {
  let overlay = $("dsWizardOverlay");
  if (!overlay) {
    overlay = el("div", "ds-overlay");
    overlay.id = "dsWizardOverlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "Connect a workspace");
    const card = el("div", "ds-card");
    const head = el("div", "ds-head");
    head.appendChild(el("h2", null, "Connect a workspace"));
    const x = el("button", "ds-x"); x.textContent = "×"; x.title = "Skip"; x.setAttribute("aria-label", "Skip");
    head.appendChild(x);
    card.appendChild(head);
    card.appendChild(el("div", "ds-note", "Connect a folder to start chatting with your codebase — ask questions, get edits, and review diffs before they're applied. Git repos get branches and pull requests; plain folders work too with file tools only."));
    const row = el("div", "ds-row ds-approval-row");
    const skipBtn = el("button", "ds-btn ds-btn-ghost", "Skip for now");
    const connectBtn = el("button", "ds-btn", "Connect a git repo");
    const newWsBtn = el("button", "ds-btn", "New workspace…");
    row.appendChild(skipBtn); row.appendChild(connectBtn); row.appendChild(newWsBtn);
    card.appendChild(row);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    const dismiss = () => { markRepoWizardSeen(); overlay.classList.remove("open"); };
    x.onclick = dismiss;
    skipBtn.onclick = dismiss;
    overlay.addEventListener("click", (e) => { if (e.target === overlay) dismiss(); });
    const afterConnect = (ok) => { if (ok) { refreshLocal(); markRepoWizardSeen(); overlay.classList.remove("open"); } };
    connectBtn.onclick = async () => { connectBtn.disabled = true; const ok = await connectFolderFlow(); connectBtn.disabled = false; afterConnect(ok); };
    newWsBtn.onclick = async () => { newWsBtn.disabled = true; const ok = await createWorkspaceFlow(); newWsBtn.disabled = false; afterConnect(ok); };
  }
  overlay.classList.add("open");
}

async function maybeShowRepoWizard() {
  try { if (localStorage.getItem("nas-llm-repo-wizard-seen") === "1") return; } catch {}
  const r = await sid("repos/local");
  const count = (r.ok && Array.isArray(r.data)) ? r.data.length : 0;
  if (count > 0) { markRepoWizardSeen(); return; }
  showRepoWizard();
}

// --- Header icon set + state badges ----------------------------------------
// The bridge doesn't import the shared www/lib.js icon set, so the header
// buttons carry their own inline SVGs. My Work shows an attention badge (active
// sessions + open PRs across workspaces); GitHub shows a connected-state dot.
const DS_ICONS = {
  drawer: '<svg class="ds-ic" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/></svg>',
  mywork: '<svg class="ds-ic" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6h11"/><path d="M9 12h11"/><path d="M9 18h11"/><path d="m3 6 1.5 1.5L7 5"/><path d="m3 12 1.5 1.5L7 11"/><path d="m3 18 1.5 1.5L7 17"/></svg>',
  changes: '<svg class="ds-ic" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="6" width="6" height="5" rx="1"/><rect x="15" y="13" width="6" height="5" rx="1"/><path d="M9 8.5h3a3 3 0 0 1 3 3V13"/></svg>',
  github:  '<svg class="ds-ic" width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2C6.48 2 2 6.58 2 12.26c0 4.5 2.87 8.32 6.84 9.67.5.1.68-.22.68-.48 0-.24-.01-.88-.01-1.73-2.78.62-3.37-1.37-3.37-1.37-.45-1.18-1.11-1.5-1.11-1.5-.91-.64.07-.62.07-.62 1 .07 1.53 1.06 1.53 1.06.89 1.56 2.34 1.11 2.91.85.09-.66.35-1.11.63-1.37-2.22-.26-4.55-1.14-4.55-5.07 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.3.1-2.71 0 0 .84-.28 2.75 1.05A9.4 9.4 0 0 1 12 6.84c.85 0 1.71.12 2.51.34 1.91-1.33 2.75-1.05 2.75-1.05.55 1.41.2 2.45.1 2.71.64.72 1.03 1.63 1.03 2.75 0 3.94-2.34 4.81-4.57 5.06.36.32.68.94.68 1.9 0 1.37-.01 2.48-.01 2.82 0 .27.18.59.69.48A10.02 10.02 0 0 0 22 12.26C22 6.58 17.52 2 12 2Z"/></svg>',
};
function dsIcon(name){ return DS_ICONS[name] || ''; }

// refreshChangesBadge updates the single header drawer button's dirty-count
// badge from the active chat's rail state. Shows ●N dirty, or ↑N ahead when the
// tree is clean but unpushed; hidden when clean and pushed. Best-effort: no rail
// state (non-repo chat / login) hides the badge.
function refreshChangesBadge(){
  const btn = document.querySelector(".ds-drawer-btn"); if(!btn) return;
  const badge = btn.querySelector(".ds-badge"); if(!badge) return;
  const s = railState || {};
  const dirty = s.dirty || 0, ahead = s.ahead || 0;
  if (dirty > 0) { badge.textContent = String(dirty); badge.classList.remove("zero"); }
  else if (ahead > 0) { badge.textContent = "\u2191" + ahead; badge.classList.remove("zero"); }
  else { badge.classList.add("zero"); badge.textContent = ""; }
}

// refreshMyWorkBadge counts active sessions + open PRs across workspaces and
// updates the My Work icon's attention badge. Best-effort: failures leave the
// last badge. Capped at the first 8 repos so a large fleet doesn't fan out into
// a request storm on every poll.
async function refreshMyWorkBadge(){
  const btn = document.querySelector(".ds-mywork-btn"); if(!btn) return;
  let count = 0;
  try{
    const jr = await fetch("/api/jobs/active");
    if(jr.ok){ const m = await jr.json().catch(()=>({})); count += Object.keys(m||{}).length; }
  }catch{}
  try{
    const rr = await fetch("/api/repos");
    if(rr.ok){
      const repos = await rr.json().catch(()=>[]);
      const prsP = (Array.isArray(repos)?repos:[]).slice(0,8).map(async rp=>{
        const fullName = rp.fullName || rp.name || ""; if(!fullName) return 0;
        try{ const p = await sid("repos/prs?name="+encodeURIComponent(fullName));
             if(p && p.ok && p.data && Array.isArray(p.data.prs)) return p.data.prs.length; }catch{}
        return 0;
      });
      const counts = await Promise.all(prsP);
      count += counts.reduce((a,b)=>a+b,0);
    }
  }catch{}
  const badge = btn.querySelector(".ds-badge");
  if(!badge) return;
  if(count>0){ badge.textContent = count>99?"99+":String(count); badge.classList.remove("zero"); }
  else { badge.classList.add("zero"); badge.textContent=""; }
}

// refreshGithubDot toggles the GitHub icon's connected dot from /github/status.
// Lightweight (one fetch) so it can poll alongside the My Work badge.
async function refreshGithubDot(){
  const btn = document.querySelector(".ds-repos-btn"); if(!btn) return;
  let connected=false, login="";
  try{ const r = await sid("github/status"); const d=(r&&r.data)||{}; connected=!!d.connected; login=d.login||""; }catch{}
  const dot = btn.querySelector(".ds-dot");
  if(dot) dot.classList.toggle("off", !connected);
  btn.title = connected ? ("GitHub — connected as "+login) : "GitHub — connect account, browse & clone repos";
  btn.setAttribute("aria-label", connected ? ("GitHub — "+login) : "GitHub");
}

function makeGear() {
  const btn = el("button", "ds-gear");
  btn.title = "Desktop settings"; btn.setAttribute("aria-label", "Desktop settings");
  btn.textContent = "⚙";
  btn.onclick = (e) => { e.stopPropagation(); openSettings(); };
  return btn;
}

// makeDrawerBtn is the single top-right header icon. It opens the unified drawer
// (My Work / Changes / Models / Settings / GitHub), carrying a small dirty-count
// attention badge so uncommitted work still surfaces at a glance.
function makeDrawerBtn() {
  const btn = el("button", "ds-head-btn ds-drawer-btn");
  btn.title = "Workspace — sessions, changes, models, settings"; btn.setAttribute("aria-label", "Workspace");
  btn.innerHTML = dsIcon("drawer") + '<span class="ds-badge zero"></span>';
  btn.onclick = (e) => { e.stopPropagation(); openDrawer(); };
  return btn;
}

// One header icon that opens the drawer. It must be reachable BEFORE login too —
// to set the backend URL and to open the paste-link sign-in. When #app is visible
// (authed), place it in the header; when #app is hidden (login view), pin a fixed
// copy to the viewport. Called on boot and whenever #app's class toggles.
function addSettingsButton() {
  const app = $("app");
  const appVisible = !!app && !app.classList.contains("hidden");
  const header = document.querySelector("#app header");
  let cluster = header ? header.querySelector(".ds-head-actions") : null;
  if (appVisible && header && !cluster) {
    cluster = el("div", "ds-head-actions");
    header.appendChild(cluster);
  }
  const headerBtn = header ? header.querySelector(".ds-drawer-btn") : null;
  if (appVisible && cluster && !headerBtn) cluster.appendChild(makeDrawerBtn());
  else if (!appVisible && headerBtn) headerBtn.remove();
  let fixed = document.querySelector("body > .ds-drawer-btn.ds-gear-fixed");
  if (!appVisible && !fixed) {
    fixed = makeDrawerBtn();
    fixed.classList.add("ds-gear-fixed");
    document.body.appendChild(fixed);
  } else if (appVisible && fixed) {
    fixed.remove();
  }
}

function hookLogin() {
  const login = $("login");
  if (!login) return;
  const update = () => {
    const hidden = login.classList.contains("hidden");
    let box = $("dsLoginBox");
    if (!hidden) {
      if (!box) {
        const card = login.querySelector(".card");
        if (!card) return;
        box = el("div", "ds-login-box");
        box.id = "dsLoginBox";
        box.appendChild(el("div", "ds-sep", "or paste a sign-in link"));
        const row = el("div", "ds-row");
        const linkInput = document.createElement("input");
        linkInput.id = "dsLoginUrl"; linkInput.type = "url";
        linkInput.placeholder = "https://chat.selected.systems/api/auth/verify?token=…";
        const signInBtn = el("button", "ds-btn", "Sign in");
        row.appendChild(linkInput); row.appendChild(signInBtn);
        box.appendChild(row);
        const out = el("div", "ds-note"); out.id = "dsLoginOut";
        box.appendChild(out);
        card.appendChild(box);
        signInBtn.onclick = async () => {
          const url = linkInput.value.trim();
          if (!url) { out.textContent = "Paste the sign-in link from your email."; return; }
          signInBtn.disabled = true; out.textContent = "Signing in…";
          const r = await sid("verify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }) });
          signInBtn.disabled = false;
          const d = r.data || {};
          if (d.ok) { out.textContent = "Signed in as " + (d.email || "?") + (d.backend_url ? " (backend " + d.backend_url + ")" : "") + ". Reloading…"; setTimeout(() => location.reload(), 600); }
          else out.textContent = "Failed: " + (d.error || r.status);
        };
      }
    } else if (box) {
      box.remove();
    }
  };
  update();
  new MutationObserver(update).observe(login, { attributes: true, attributeFilter: ["class"] });
}

async function bootDesktop() {
  // A reload after a manual Ollama start sets this guard; consume it and skip
  // auto-start this boot so a start that didn't actually bring Ollama up can't
  // loop the reload.
  let justReloaded = false;
  try { justReloaded = sessionStorage.getItem("nasllm-ollama-reloaded") === "1"; sessionStorage.removeItem("nasllm-ollama-reloaded"); } catch {}
  await refreshState();
  buildDrawer();          // unified right-side drawer; settings/github cards mount into it
  initDsDrawerResize();  // inject the drawer's left-edge drag handle
  buildOverlay();         // settings card -> #dsDrawerPanel_settings
  buildReposOverlay();    // github card -> #dsDrawerPanel_github
  fillOverlay();
  loadAgentGlobalAutoApprove();
  // Intercept the composer's model button so it opens the drawer's Models tab
  // (which hosts the www/app.js #modelsModal) instead of the standalone modal.
  // Both this listener and app.js's modelBtn listener fire: this opens the
  // drawer, app.js's openModelsPanel renders the hosted modal's rows/banner.
  const _mb = $("modelBtn");
  if (_mb && !_mb._dsIntercept) {
    _mb._dsIntercept = true;
    _mb.addEventListener("click", () => { if (!_dsModelsTabActivating) openDrawer("models"); });
  }
  // syncAuthedUI places the header actions cluster (Changes / My Work / GitHub / gear)
  // and — once #app is actually visible (authed) — builds the sidebar Repos
  // section, populates it, and (only the first time, with zero repos
  // connected) shows the connect wizard. Also seeds the header state badges.
  const syncAuthedUI = () => {
    addSettingsButton();
    const app = $("app");
    if (app && !app.classList.contains("hidden")) {
      buildSidebarRepos();
      buildSidebarChatsHeader();
      refreshLocal();
      maybeShowRepoWizard();
      syncBranchRail();
      refreshMyWorkBadge();
      refreshGithubDot();
    } else {
      hideBranchRail();
    }
  };
  syncAuthedUI();
  hookLogin();
  // Re-run gear + sidebar-repos placement when the auth view toggles (#app
  // hidden ⇄ shown) — the initial auth check in app.js resolves after this
  // boot script runs, so #app may still be hidden the first time above.
  const app = $("app");
  if (app) new MutationObserver(syncAuthedUI).observe(app, { attributes: true, attributeFilter: ["class"] });
  // Keep the header state badges (active sessions + open PRs, GitHub connection
  // dot) fresh while authed. Best-effort; skipped on the login view.
  setInterval(() => {
    if ($("app") && !$("app").classList.contains("hidden")) { refreshMyWorkBadge(); refreshGithubDot(); }
  }, 20000);
  // Branch rail: re-derive the active repo-bound chat when the sidebar
  // re-renders (app.js marks the active conv row) or when desktop.js navigates
  // to a chat via the nasllm:openConv event.
  const convListEl = $("convList");
  if (convListEl) new MutationObserver(() => syncBranchRail()).observe(convListEl, { childList: true, subtree: true });
  window.addEventListener("nasllm:openConv", () => syncBranchRail());
  // app.js announces the active conversation (openConversation/newChat) so the
  // repo sidebar can highlight the chat you're viewing and the branch rail can
  // bind to a repo-bound chat — both need the active id, and repo chats are
  // filtered out of #convList so activeConvIdFromDOM() can't see them.
  window.addEventListener("nasllm:activeConv", (e) => {
    activeConvId = (e && e.detail) ? String(e.detail) : null;
    highlightActiveRepoChat();
    syncBranchRail();
  });
  // Auto-start a local Ollama if installed but not running, so local models are
  // discoverable through the /__ollama proxy by the time the web UI needs them.
  // If the app is already authed and Ollama just came up, reload once so app.js
  // re-attaches local models (its reattachLocalModels already ran pre-start).
  (async () => {
    if (justReloaded) return;
    const s = await sid("ollama/status"); const sd = (s && s.data) || {};
    if (sd.running || !sd.installed) return;
    const r = await sid("ollama/start", { method: "POST" }); const d = (r && r.data) || {};
    if (d.ok && $("app") && !$("app").classList.contains("hidden")) {
      try { sessionStorage.setItem("nasllm-ollama-reloaded", "1"); } catch {}
      location.reload();
    }
  })();
}

// --- Unified drawer horizontal resize ---------------------------------------
// The desktop unified drawer (.ds-drawer-card) defaults to 480px. This injects
// a left-edge grab handle, drives width via --ds-drawer-w, and persists it. The
// drawer is pinned to the right edge, so width = viewport width - left-edge x.
// No-op on mobile where the card goes full-width.
const DS_DRAWER_MIN=360, DS_DRAWER_KEY="nas-llm-ds-drawer-w";
function dsDrawerMaxW(){ return Math.floor(window.innerWidth*0.92); }
function applyDsDrawerW(card,w){ card.style.setProperty("--ds-drawer-w", Math.max(DS_DRAWER_MIN, Math.min(w, dsDrawerMaxW()))+"px"); }
function initDsDrawerResize(){
  document.querySelectorAll(".ds-drawer-card").forEach(card=>{
    if(card.querySelector(".ds-drawer-resize")) return;
    const handle=document.createElement("div"); handle.className="ds-drawer-resize";
    handle.setAttribute("role","separator"); handle.setAttribute("aria-orientation","vertical"); handle.title="Drag to resize";
    card.prepend(handle);
    const saved=parseFloat(localStorage.getItem(DS_DRAWER_KEY)); if(saved>0) applyDsDrawerW(card,saved);
    handle.addEventListener("pointerdown",e=>{
      e.preventDefault();
      document.body.classList.add("ds-drawer-resizing");
      const move=ev=>applyDsDrawerW(card, window.innerWidth-ev.clientX);
      const up=()=>{
        document.removeEventListener("pointermove",move);
        document.removeEventListener("pointerup",up);
        document.removeEventListener("pointercancel",up);
        document.body.classList.remove("ds-drawer-resizing");
        const w=parseFloat(getComputedStyle(card).getPropertyValue("--ds-drawer-w"));
        if(w>0) localStorage.setItem(DS_DRAWER_KEY,String(w));
      };
      document.addEventListener("pointermove",move);
      document.addEventListener("pointerup",up);
      document.addEventListener("pointercancel",up);
      move(e);
    });
  });
}
window.addEventListener("resize",()=>{
  document.querySelectorAll(".ds-drawer-card").forEach(card=>{
    const w=parseFloat(getComputedStyle(card).getPropertyValue("--ds-drawer-w"));
    if(w>0) applyDsDrawerW(card,w);
  });
});

// The injected <script> is placed after app.js, so #app/#login already exist.
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootDesktop);
} else {
  bootDesktop();
}
