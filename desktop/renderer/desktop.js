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
  function patched(url) {
    const es = new OrigES(url);
    // Extract the conversation ID from the /api/conversations/:id/events URL.
    let convId = null;
    try { const m = String(url).match(/\/api\/conversations\/([^/]+)\/events/); if (m) convId = decodeURIComponent(m[1]); } catch {}
    es.addEventListener("toolExec", async (e) => {
      let d = {}; try { d = JSON.parse(e.data); } catch { return; }
      if (!d.jobId || !d.tool) return;
      await runToolExec(convId, d);
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

function openSettings() { $("desktopSettings")?.classList.add("open"); }
function closeSettings() { $("desktopSettings")?.classList.remove("open"); }

function buildOverlay() {
  if ($("desktopSettings")) return;
  const overlay = el("div", "ds-overlay");
  overlay.id = "desktopSettings";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "Desktop settings");

  const card = el("div", "ds-card");

  const head = el("div", "ds-head");
  head.appendChild(el("h2", null, "Desktop settings"));
  const x = el("button", "ds-x"); x.textContent = "×"; x.title = "Close"; x.setAttribute("aria-label", "Close");
  x.onclick = closeSettings;
  head.appendChild(x);
  card.appendChild(head);

  // Backend URL
  card.appendChild(el("div", "ds-label", "NAS backend URL"));
  const urlRow = el("div", "ds-row");
  const urlInput = document.createElement("input");
  urlInput.id = "dsBackendUrl"; urlInput.type = "url";
  urlInput.placeholder = "https://chat.selected.systems";
  const saveBtn = el("button", "ds-btn", "Save");
  const testBtn = el("button", "ds-btn ds-btn-ghost", "Test");
  urlRow.appendChild(urlInput); urlRow.appendChild(saveBtn); urlRow.appendChild(testBtn);
  card.appendChild(urlRow);
  const testOut = el("div", "ds-note"); testOut.id = "dsTestOut";
  card.appendChild(testOut);

  // Auth / magic link
  card.appendChild(el("div", "ds-label", "Sign in (magic link)"));
  const note = el("div", "ds-note", "Click “Send link” in the app to get a sign-in email, then paste the link from that email here to sign the desktop app in.");
  card.appendChild(note);
  const linkRow = el("div", "ds-row");
  const linkInput = document.createElement("input");
  linkInput.id = "dsVerifyUrl"; linkInput.type = "url";
  linkInput.placeholder = "https://chat.selected.systems/api/auth/verify?token=…";
  const signInBtn = el("button", "ds-btn", "Sign in");
  const logoutBtn = el("button", "ds-btn ds-btn-ghost", "Sign out");
  linkRow.appendChild(linkInput); linkRow.appendChild(signInBtn); linkRow.appendChild(logoutBtn);
  card.appendChild(linkRow);
  const authOut = el("div", "ds-note"); authOut.id = "dsAuthOut";
  card.appendChild(authOut);

  // Ollama (local models) — status + Start/Stop, backed by /__sidecar/ollama/*.
  card.appendChild(el("div", "ds-label", "Ollama (local models)"));
  const ollamaOut = el("div", "ds-note");
  card.appendChild(ollamaOut);
  const ollamaRow = el("div", "ds-row");
  const startOllama = el("button", "ds-btn", "Start Ollama");
  const stopOllama = el("button", "ds-btn ds-btn-ghost", "Stop Ollama");
  ollamaRow.appendChild(startOllama); ollamaRow.appendChild(stopOllama);
  card.appendChild(ollamaRow);
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

  overlay.appendChild(card);
  document.body.appendChild(overlay);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeSettings(); });

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
  const a = $("dsAuthOut");
  if (a) a.textContent = state.authed ? ("Signed in as " + (state.email || "?")) : "Not signed in.";
}

// Run one file-tool call via the sidecar. Write tools (apply_patch, run_command)
// require per-invocation approval: the sidecar returns {needs_approval:true} with
// a preview; we show an approval dialog and only re-POST with approved:true once
// the user clicks Approve. On Reject, we post a rejection as the observation so
// the agent loop can adjust. Read tools run immediately.
async function runToolExec(convId, d) {
  const execBody = { repo: d.repo, tool: d.tool, args: d.args || "" };
  let execRes;
  try {
    const r = await fetch("/__sidecar/repos/exec", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(execBody) });
    execRes = await r.json();
  } catch (err) {
    execRes = { observation: String(err && err.message || err), preview: "exec error", is_error: true };
  }
  // Write tools need approval — show a dialog and await the user's decision.
  if (execRes && execRes.needs_approval) {
    const approved = await showApprovalDialog(execRes.approval_kind || d.tool, execRes.approval_preview || "");
    if (!approved) {
      // Rejected: tell the agent so it can adjust.
      execRes = { observation: "The user rejected this " + d.tool + " call. Do not retry it; adjust your approach.", preview: "rejected", is_error: true };
    } else {
      // Approved: re-POST with approved:true to actually execute.
      try {
        const r = await fetch("/__sidecar/repos/exec", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...execBody, approved: true }) });
        execRes = await r.json();
      } catch (err) {
        execRes = { observation: String(err && err.message || err), preview: "exec error", is_error: true };
      }
    }
  }
  // Post the observation back to the backend so the agent loop continues.
  try {
    await fetch("/api/conversations/" + encodeURIComponent(convId) + "/tool-response", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: d.jobId, observation: execRes.observation || "", preview: execRes.preview || "", isError: !!execRes.is_error })
    });
  } catch {}
}

// showApprovalDialog returns a Promise<boolean> — true if the user clicks
// Approve, false if Reject. Renders an overlay with the tool kind, a
// scrollable <pre> preview (diff or command), and the two buttons.
function showApprovalDialog(kind, preview) {
  return new Promise((resolve) => {
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
      const x = el("button", "ds-x"); x.textContent = "×"; x.title = "Reject"; x.setAttribute("aria-label", "Reject");
      x.onclick = () => { closeApproval(false); };
      head.appendChild(x);
      card.appendChild(head);
      const kindLabel = el("div", "ds-label", "Tool");
      card.appendChild(kindLabel);
      const kindVal = el("div", "ds-approval-kind", kind);
      card.appendChild(kindVal);
      const preWrap = el("div", "ds-approval-pre-wrap");
      card.appendChild(preWrap);
      const row = el("div", "ds-row ds-approval-row");
      const approve = el("button", "ds-btn ds-btn-approve", "Approve");
      const reject = el("button", "ds-btn ds-btn-ghost", "Reject");
      row.appendChild(reject); row.appendChild(approve);
      card.appendChild(row);
      overlay.appendChild(card);
      document.body.appendChild(overlay);
      overlay._close = (val) => { overlay.classList.remove("open"); resolve(val); };
      const closeApproval = (val) => { if (overlay._close) overlay._close(val); };
      approve.onclick = () => closeApproval(true);
      reject.onclick = () => closeApproval(false);
      overlay.addEventListener("click", (e) => { if (e.target === overlay) closeApproval(false); });
    overlay._kind = kindVal;
      overlay._content = preWrap; // the scrollable container
    }
    overlay._kind.textContent = kind;
    renderApprovalContent(overlay._content, kind, preview);
    overlay.classList.add("open");
  });
}

// renderApprovalContent fills the scrollable container with either a
// line-by-line colored diff (for apply_patch) or a raw <pre> (for run_command
// and anything that isn't a unified diff). The diff parser splits on newlines,
// classifies each line, and builds a DOM fragment with red/green gutters.
function renderApprovalContent(container, kind, preview) {
  container.innerHTML = "";
  if (kind === "apply_patch" && preview.includes("@@")) {
    container.appendChild(renderDiff(preview));
  } else {
    const pre = document.createElement("pre");
    pre.className = "ds-approval-pre";
    pre.textContent = preview;
    container.appendChild(pre);
  }
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

// Open the native directory picker; returns a single absolute path or null.
function pickFolder(title) {
  return tauriInvoke("plugin:dialog|open", { options: { directory: true, multiple: false, title: title || "Select repository folder" } })
    .then((res) => (Array.isArray(res) ? (res[0] || null) : (res || null)))
    .catch(() => null);
}

// Small confirm dialog (replaces native confirm(), which the browser can block).
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
      const ok = el("button", "ds-btn ds-btn-approve", "Yes");
      const cancel = el("button", "ds-btn ds-btn-ghost", "Cancel");
      row.appendChild(cancel); row.appendChild(ok);
      card.appendChild(row);
      overlay.appendChild(card);
      document.body.appendChild(overlay);
      overlay._close = (v) => { overlay.classList.remove("open"); resolve(v); };
      ok.onclick = () => overlay._close(true);
      cancel.onclick = () => overlay._close(false);
      overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay._close(false); });
    }
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

// Create a repo-bound agent chat, place it in the workspace folder, enable
// agent mode with file tools, and navigate to it. Reused by "+ New chat".
async function createRepoChat(r) {
  const title = r.name + " (agent)";
  const model = localStorage.getItem("nas-llm-model") || "";
  const cr = await fetch("/api/conversations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title, model }) });
  const cj = await cr.json();
  const convId = cj && cj.id;
  if (!convId) throw new Error("Could not create conversation.");
  // Re-push repo context in case the earlier push failed.
  try { await sid("repos/open", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: r.name }) }); } catch {}
  // Resolve the backend repo id (re-fetch so a just-connected repo is found).
  let repoId = "";
  try {
    const rr = await fetch("/api/repos");
    if (rr.ok) { const repos = await rr.json(); const found = (repos || []).find((x) => x.fullName === r.name); if (found) repoId = found.id; }
  } catch {}
  if (!repoId) throw new Error("Repo not registered with backend. Re-connect it.");
  // Workspace folder so chats group in the sidebar.
  const folderId = await ensureWorkspaceFolder(r.name);
  const patchBody = { repoId, agentTools: "read_file,list_files,glob,grep,git_status,apply_patch,run_command,ask_user,get_time" };
  if (folderId) patchBody.folderId = folderId;
  try {
    await fetch("/api/conversations/" + encodeURIComponent(convId), { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patchBody) });
  } catch (e) { throw new Error(String(e && e.message || e)); }
  if (folderId) { try { await sid("repos/set-folder", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repo: r.name, folder_id: folderId }) }); } catch {} }
  try {
    let extras = []; try { extras = JSON.parse(localStorage.getItem("nas-llm-extras") || "[]") || []; } catch {}
    if (!extras.includes("agent")) { extras.push("agent"); localStorage.setItem("nas-llm-extras", JSON.stringify(extras)); }
    localStorage.setItem("nas-llm-conv", convId);
  } catch {}
  location.reload();
}

// --- Repos panel (GitHub + local clones) ---
function openRepos() { $("dsReposOverlay")?.classList.add("open"); refreshGithub(); refreshLocal(); }
function closeRepos() { $("dsReposOverlay")?.classList.remove("open"); }

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

// localRow renders one connected repo as a workspace: the repo row (name,
// badges, Pull/Ship/+ New chat) plus the list of chats attached to it.
function localRow(r, chats) {
  const wrap = el("div", "ds-repo-wrap");
  const row = el("div", "ds-repo-row");
  const main = el("div", "ds-repo-main");
  const name = el("div", "ds-repo-name", r.name);
  const dirtyBadge = r.dirty > 0 ? el("span", "ds-badge ds-badge-dirty", r.dirty + " dirty") : el("span", "ds-badge ds-badge-clean", "clean");
  name.appendChild(dirtyBadge);
  if (r.linked) name.appendChild(el("span", "ds-badge ds-badge-linked", "linked"));
  else name.appendChild(el("span", "ds-badge ds-badge-cloned", "cloned"));
  const host = hostOf(r.remote);
  if (host) name.appendChild(el("span", "ds-badge ds-badge-remote", host));
  main.appendChild(name);
  const meta = el("div", "ds-repo-meta", r.branch);
  main.appendChild(meta);
  row.appendChild(main);

  const refresh = el("button", "ds-btn ds-btn-ghost ds-btn-sm", "Pull");
  refresh.onclick = async () => {
    refresh.disabled = true; refresh.textContent = "Pulling…";
    const res = await sid("repos/refresh", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: r.name }) });
    refresh.disabled = false; refresh.textContent = "Pull";
    const d = (res && res.data) || {};
    if (!d.ok) flashDsErr(d.error || res.status);
    refreshLocal();
  };
  row.appendChild(refresh);

  const ship = el("button", "ds-btn ds-btn-ghost ds-btn-sm", "Ship");
  ship.title = "Review changes, write a changelog, and commit/push a version";
  ship.onclick = () => openShipChanges(r);
  row.appendChild(ship);

  const agent = el("button", "ds-btn ds-btn-sm", "+ New chat");
  agent.onclick = async () => {
    agent.disabled = true; agent.textContent = "Creating…";
    try { await createRepoChat(r); }
    catch (e) { flashDsErr(String(e && e.message || e)); agent.disabled = false; agent.textContent = "+ New chat"; }
  };
  row.appendChild(agent);
  wrap.appendChild(row);

  // Attached chats (the workspace).
  const chatsEl = el("div", "ds-repo-chats");
  if (chats && chats.length) {
    const head = el("div", "ds-repo-chats-head", chats.length + " chat" + (chats.length === 1 ? "" : "s"));
    chatsEl.appendChild(head);
    chats.forEach((c) => {
      const cr = el("div", "ds-repo-chat");
      const t = el("span", "ds-repo-chat-title", c.title || "New chat");
      cr.appendChild(t);
      const tm = el("span", "ds-repo-chat-time", dsTime(c.updatedAt));
      cr.appendChild(tm);
      cr.onclick = () => { try { localStorage.setItem("nas-llm-conv", c.id); } catch {} location.reload(); };
      chatsEl.appendChild(cr);
    });
  } else {
    chatsEl.appendChild(el("div", "ds-note", "No chats yet. Click + New chat to start one against this repo."));
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
    if (!res.data.length) { body.appendChild(el("div", "ds-note", "No local repos yet. Click “Connect folder” to add an existing repo, or connect GitHub and clone one above.")); return; }
    res.data.forEach((r) => {
      const rp = repoByFullName.get(r.name || (r.full_name || ""));
      const chats = rp ? (chatsByRepoId.get(rp.id) || []) : [];
      body.appendChild(localRow(r, chats));
    });
  } else {
    body.appendChild(el("div", "ds-note", "Could not load local repos."));
  }
}

function flashDsErr(msg) {
  const e = $("dsReposErr"); if (e) { e.textContent = String(msg || "error"); e.classList.remove("hidden"); setTimeout(() => e.classList.add("hidden"), 4000); }
}

function buildReposOverlay() {
  if ($("dsReposOverlay")) return;
  const overlay = el("div", "ds-overlay");
  overlay.id = "dsReposOverlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "Repositories");
  const card = el("div", "ds-card ds-card-wide");
  const head = el("div", "ds-head");
  head.appendChild(el("h2", null, "Repositories"));
  const x = el("button", "ds-x"); x.textContent = "×"; x.title = "Close"; x.setAttribute("aria-label", "Close");
  x.onclick = closeRepos;
  head.appendChild(x);
  card.appendChild(head);
  // GitHub connect
  const connectWrap = el("div", null); connectWrap.id = "dsGhConnect";
  connectWrap.appendChild(el("div", "ds-label", "GitHub"));
  connectWrap.appendChild(el("div", "ds-note", "Paste a Personal Access Token (with repo read). It is stored in the macOS Keychain, never on disk or sent to the NAS."));
  const tokRow = el("div", "ds-row");
  const tokInput = document.createElement("input");
  tokInput.id = "dsGhToken"; tokInput.type = "password"; tokInput.placeholder = "ghp_…";
  const connectBtn = el("button", "ds-btn", "Connect");
  tokRow.appendChild(tokInput); tokRow.appendChild(connectBtn);
  connectWrap.appendChild(tokRow);
  const ghStatus = el("div", "ds-note"); ghStatus.id = "dsGhStatus";
  connectWrap.appendChild(ghStatus);
  card.appendChild(connectWrap);
  // GitHub repo list
  const listWrap = el("div", "hidden"); listWrap.id = "dsGhList";
  const ghHead = el("div", "ds-label", "Your GitHub repos");
  const discBtn = el("button", "ds-btn ds-btn-ghost ds-btn-sm", "Disconnect");
  ghHead.appendChild(discBtn);
  listWrap.appendChild(ghHead);
  // Search filter
  const searchRow = el("div", "ds-row");
  const searchInput = document.createElement("input");
  searchInput.id = "dsGhSearch"; searchInput.type = "search"; searchInput.placeholder = "Filter repos…";
  searchRow.appendChild(searchInput);
  listWrap.appendChild(searchRow);
  let ghReposCache = [];
  searchInput.addEventListener("input", () => {
    const q = searchInput.value.trim().toLowerCase();
    const body = $("dsGhBody"); if (!body) return;
    body.innerHTML = "";
    const filtered = !q ? ghReposCache : ghReposCache.filter(r => r.full_name.toLowerCase().includes(q));
    if (!filtered.length) { body.appendChild(el("div", "ds-note", "No matching repos.")); return; }
    filtered.forEach(r => body.appendChild(ghRow(r)));
  });
  const ghBody = el("div", null); ghBody.id = "dsGhBody";
  listWrap.appendChild(ghBody);
  card.appendChild(listWrap);
  // Local clones + working changes + connect-folder wizard
  const localHead = el("div", "ds-label", "Local clones");
  const connectFolderBtn = el("button", "ds-btn ds-btn-sm", "Connect folder");
  connectFolderBtn.title = "Connect an existing folder on this computer as a repo";
  const changesBtn = el("button", "ds-btn ds-btn-ghost ds-btn-sm", "Working changes");
  localHead.appendChild(connectFolderBtn);
  localHead.appendChild(changesBtn);
  card.appendChild(localHead);
  const localBody = el("div", null); localBody.id = "dsLocalBody";
  card.appendChild(localBody);
  changesBtn.onclick = () => openWorkingChanges();
  connectFolderBtn.onclick = async () => {
    connectFolderBtn.disabled = true;
    const path = await pickFolder("Select a repository folder");
    if (!path) { connectFolderBtn.disabled = false; return; }
    connectFolderBtn.disabled = true; connectFolderBtn.textContent = "Adding…";
    const r = await sid("repos/add-local", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path }) });
    connectFolderBtn.disabled = false; connectFolderBtn.textContent = "Connect folder";
    const d = (r && r.data) || {};
    if (d.ok) refreshLocal();
    else flashDsErr(d.error || r.status || "Could not connect folder");
  };
  // Error line
  const err = el("div", "ds-note hidden"); err.id = "dsReposErr";
  card.appendChild(err);
  overlay.appendChild(card);
  document.body.appendChild(overlay);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeRepos(); });
  connectBtn.onclick = async () => {
    const token = tokInput.value.trim();
    if (!token) { ghStatus.textContent = "Paste a token."; return; }
    connectBtn.disabled = true; ghStatus.textContent = "Connecting…";
    const r = await sid("github/connect", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
    connectBtn.disabled = false;
    const d = (r && r.data) || {};
    if (d.ok) { tokInput.value = ""; refreshGithub(); }
    else ghStatus.textContent = "Failed: " + (d.error || r.status);
  };
  discBtn.onclick = async () => { await sid("github/disconnect", { method: "POST" }); refreshGithub(); };
}

// openWorkingChanges shows a panel with the current `git diff` across all
// local clones and a Revert button per repo (git checkout -- . + git clean -fd).
// Lets the user review and undo agent-made edits without a terminal.
function openWorkingChanges() {
  let overlay = $("dsChangesOverlay");
  if (!overlay) {
    overlay = el("div", "ds-overlay");
    overlay.id = "dsChangesOverlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "Working changes");
    const card = el("div", "ds-card ds-card-wide");
    const head = el("div", "ds-head");
    head.appendChild(el("h2", null, "Working changes"));
    const x = el("button", "ds-x"); x.textContent = "×"; x.title = "Close"; x.setAttribute("aria-label", "Close");
    x.onclick = () => overlay.classList.remove("open");
    head.appendChild(x);
    card.appendChild(head);
    const note = el("div", "ds-note", "Showing uncommitted changes across all local clones. Revert discards all working-tree changes in a repo (git checkout -- . && git clean -fd).");
    card.appendChild(note);
    const body = el("div", null); body.id = "dsChangesBody";
    card.appendChild(body);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.classList.remove("open"); });
  }
  overlay.classList.add("open");
  refreshWorkingChanges();
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
    const section = el("div", "ds-changes-section");
    const head = el("div", "ds-changes-head");
    head.appendChild(el("div", "ds-changes-name", r.name + " (" + r.branch + ")"));
    const revertBtn = el("button", "ds-btn ds-btn-ghost ds-btn-sm", "Revert");
    revertBtn.onclick = async () => {
      revertBtn.disabled = true; revertBtn.textContent = "Reverting…";
      const res = await sid("repos/revert", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: r.name }) });
      revertBtn.disabled = false; revertBtn.textContent = "Revert";
      const d = (res && res.data) || {};
      if (!d.ok) flashDsErr(d.error || res.status);
      refreshWorkingChanges();
    };
    head.appendChild(revertBtn);
    section.appendChild(head);
    const diffWrap = el("div", "ds-approval-pre-wrap");
    section.appendChild(diffWrap);
    body.appendChild(section);
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

function makeReposBtn() {
  const btn = el("button", "ds-repos-btn");
  btn.title = "Repositories"; btn.setAttribute("aria-label", "Repositories");
  btn.textContent = " Repos";
  btn.onclick = (e) => { e.stopPropagation(); openRepos(); };
  return btn;
}

function makeGear() {
  const btn = el("button", "ds-gear");
  btn.title = "Desktop settings"; btn.setAttribute("aria-label", "Desktop settings");
  btn.textContent = "⚙";
  btn.onclick = (e) => { e.stopPropagation(); openSettings(); };
  return btn;
}

// The gear must be reachable BEFORE login too — to set the backend URL and to
// open the paste-link sign-in. When #app is visible (authed), place the gear in
// the header; when #app is hidden (login view), pin a fixed gear to the viewport
// so it's always visible. Called on boot and whenever #app's class toggles.
function addSettingsButton() {
  const app = $("app");
  const appVisible = !!app && !app.classList.contains("hidden");
  const header = document.querySelector("#app header");
  // Gear (settings)
  const headerGear = header ? header.querySelector(".ds-gear") : null;
  if (appVisible && header && !headerGear) {
    const gear = makeGear();
    const sel = header.querySelector(".model-select");
    if (sel) header.insertBefore(gear, sel); else header.appendChild(gear);
  } else if (!appVisible && headerGear) {
    headerGear.remove();
  }
  let fixed = document.querySelector("body > .ds-gear-fixed");
  if (!appVisible && !fixed) {
    fixed = makeGear();
    fixed.classList.add("ds-gear-fixed");
    document.body.appendChild(fixed);
  } else if (appVisible && fixed) {
    fixed.remove();
  }
  // Repos button (header only — repos require auth + backend)
  const headerRepos = header ? header.querySelector(".ds-repos-btn") : null;
  if (appVisible && header && !headerRepos) {
    const reposBtn = makeReposBtn();
    const sel = header.querySelector(".model-select");
    if (sel) header.insertBefore(reposBtn, sel); else header.appendChild(reposBtn);
  } else if (!appVisible && headerRepos) {
    headerRepos.remove();
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
  buildOverlay();
  buildReposOverlay();
  fillOverlay();
  addSettingsButton();
  hookLogin();
  // Re-run gear placement when the auth view toggles (#app hidden ⇄ shown).
  const app = $("app");
  if (app) new MutationObserver(addSettingsButton).observe(app, { attributes: true, attributeFilter: ["class"] });
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

// The injected <script> is placed after app.js, so #app/#login already exist.
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootDesktop);
} else {
  bootDesktop();
}
