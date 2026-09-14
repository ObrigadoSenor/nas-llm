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

  addUpdatesSection(card);

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

// --- Updates section (in-app updater) ---
// Shows the current app version, a Check-for-updates button that fetches the
// latest release + its notes from the updater endpoint, and an on-click
// "Update to latest" that downloads + installs + relaunches. Talks to the
// Tauri commands in updater.rs over IPC; degrades gracefully when IPC isn't
// available (e.g. served outside the installed app).
function addUpdatesSection(card) {
  card.appendChild(el("div", "ds-label", "Updates"));
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

// Run one file-tool call via the sidecar. Write tools (apply_patch, run_command)
// require per-invocation approval: the sidecar returns {needs_approval:true} with
// a preview; we show an approval dialog and only re-POST with approved:true once
// the user clicks Approve. On Reject, we post a rejection as the observation so
// the agent loop can adjust. Read tools run immediately.
// d.branch (from the toolExec payload, sourced from conversations.repo_branch)
// is passed straight through to the sidecar so the tool runs in THIS chat's
// worktree, not whichever tree happens to be checked out — dropping it would
// silently send a background chat's edits into the wrong tree.
// Write tools that auto-approve covers run immediately (no dialog) when the
// backend says auto-approve is on for this chat. create_pr is never in this set —
// opening a PR is external/irreversible, so it always prompts regardless.
const AUTO_APPROVE_TOOLS = new Set(["apply_patch", "run_command", "git_commit", "git_push"]);
async function runToolExec(convId, d) {
  const execBody = { repo: d.repo, tool: d.tool, args: d.args || "" };
  if (d.branch) execBody.branch = d.branch;
  if (d.autoApprove && AUTO_APPROVE_TOOLS.has(d.tool)) execBody.approved = true;
  let execRes;
  try {
    const r = await fetch("/__sidecar/repos/exec", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(execBody) });
    execRes = await r.json();
  } catch (err) {
    execRes = { observation: String(err && err.message || err), preview: "exec error", is_error: true };
  }
  // Write tools need approval — show a dialog and await the user's decision.
  if (execRes && execRes.needs_approval) {
    const branch = d.branch || (await branchForRepo(d.repo));
    const title = await titleForConv(convId);
    const approved = await showApprovalDialog(execRes.approval_kind || d.tool, execRes.approval_preview || "", { repo: d.repo, branch, title });
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
  // A write tool may have changed the working tree — refresh the branch rail,
  // but only when it's for the chat currently on screen; a background chat's
  // tool call shouldn't repaint the foreground rail with unrelated state.
  if (!convId || convId === activeConvIdFromDOM()) refreshRailState();
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
  const kindText = (ctx && ctx.repo) ? (kind + " → " + ctx.repo + (ctx.branch ? " @ " + ctx.branch : "")) : kind;
  $("dsApprovalKind").textContent = kindText;
  renderApprovalContent($("dsApprovalPre"), kind, preview);
  overlay.classList.add("open");
}

// renderApprovalContent fills the scrollable container with either a
// line-by-line colored diff (for apply_patch) or a raw <pre> (for run_command
// and anything that isn't a unified diff). The diff parser splits on newlines,
// classifies each line, and builds a DOM fragment with red/green gutters.
function renderApprovalContent(container, kind, preview) {
  container.innerHTML = "";
  if (kind === "apply_patch" && preview.includes("@@")) {
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
  return activeConvIdFromDOM() === convId;
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
  if (repos.length === 1) return addLocalRepo(repos[0].path);
  return showConnectPicker(repos);
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
// The active conversation's id is owned by app.js (module-private). We detect
// it from the sidebar DOM: app.js marks the active conv row with `.active` and
// gives its title element id `ct-<convId>` (renderConv in app.js). A
// MutationObserver on #convList + the `nasllm:openConv` event tell us when to
// re-derive it. The rail then polls /__sidecar/repos/state for the bound repo.
let railRepo = null;       // full_name of the repo the active repo-bound chat is on
let railState = null;      // last repos/state result for railRepo
let railConvId = null;     // id of the active conversation the rail is bound to
let railConv = null;       // that conversation's record (for its own repoBranch)
let railTimer = null;      // the ~5s repos/state poll interval
let railMaps = { convById: new Map(), repoById: new Map(), repoByFullName: new Map() };
let railSyncTimer = null;  // debounce for syncBranchRail

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
  const chatBranch = (railConv && railConv.repoBranch) || s.branch || "";
  status.innerHTML = "";
  status.appendChild(document.createTextNode(railRepo));
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
  // Auto-approve toggle: reflects this chat's effective setting (per-chat
  // override, else the global default). Click flips the per-chat override.
  const aaOn = effectiveAutoApprove(railConv);
  status.appendChild(document.createTextNode(" · "));
  const aaChip = el("span", "ds-aa-chip " + (aaOn ? "on" : "off"), aaOn ? "✓ auto-approve" : "○ auto-approve off");
  aaChip.title = aaOn
    ? "Edits, commands, commit and push run without an approval dialog. create_pr still asks. Click to turn off for this chat."
    : "Each edit/command/commit/push asks before running. Click to turn auto-approve on for this chat.";
  aaChip.onclick = (e) => { e.stopPropagation(); toggleConvAutoApprove(railConvId, railConv); };
  status.appendChild(aaChip);
  // Hover popup: explain the symbols (● = uncommitted files, ⎇ = branch, ↑/↓ =
  // ahead/behind) and that clicking opens the review/commit session panel.
  const tip = [railRepo];
  if (chatBranch) tip.push("branch: " + chatBranch + " (click ⎇ to change)");
  if (s.dirty) tip.push(s.dirty + " uncommitted/modified files (●)");
  if (s.ahead) tip.push(s.ahead + " commits ahead of origin (↑)");
  if (s.behind) tip.push(s.behind + " commits behind origin (↓)");
  if (s.hasRemote === false) tip.push("no remote configured");
  tip.push(aaOn ? "auto-approve on (edits/commands/commit/push run without asking)" : "auto-approve off (click ✓/○ to toggle for this chat)");
  tip.push("click to open the session panel (review changes, commit & push, open PR)");
  status.title = tip.join(" · ");
  status.classList.remove("hidden");
}

function stopRailPoll() { if (railTimer) { clearInterval(railTimer); railTimer = null; } }
function startRailPoll() { stopRailPoll(); if (railRepo) railTimer = setInterval(refreshRailState, 5000); }

async function refreshRailState() {
  if (!railRepo) return;
  const r = await sid("repos/state?name=" + encodeURIComponent(railRepo));
  if (r.ok && r.data) { railState = r.data; renderComposerStatus(); }
}

function hideBranchRail() {
  railRepo = null; railState = null; railConvId = null; railConv = null; stopRailPoll();
  const status = $("dsComposerStatus");
  if (status) { status.classList.add("hidden"); status.textContent = ""; }
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
  const convId = activeConvIdFromDOM();
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
  if (changed) { await refreshRailState(); startRailPoll(); }
  renderComposerStatus();
}

// Create a repo-bound agent chat in its own git worktree on its own branch,
// place it in the workspace folder, enable agent mode with file + git tools,
// and navigate to it without a full page reload. Reused by "+ New chat".
//
// Order matters: we register the repo with the backend and confirm its id
// BEFORE creating any conversation. If registration fails we surface the real
// error and bail without creating a chat — so a failed connect never leaves an
// orphaned "normal" chat behind (which is what happened when the conversation
// was created first and the repo lookup threw after it).
async function createRepoChat(r) {
  const fullName = r.name;

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
  // the same slice, so a chat, its title, and its worktree all carry one handle
  // you can match by eye.
  const shortId = String(convId).slice(0, 7);
  const title = fullName + " (agent " + shortId + ")";

  // Give this chat its own branch in its own git worktree.
  //
  // Two things matter here. First, the name must be unique per chat. Branch
  // names used to come from a slug of the chat title, and since every chat on a
  // repo shared one title, every chat shared ONE branch — "a branch per chat"
  // was really a branch per repo. The conversation-id slice fixes that.
  //
  // Second, we provision a worktree rather than `git switch`-ing the repo
  // folder. Switching moved the branch of the checkout the user has open in
  // their editor, and carried any uncommitted changes there onto the new
  // branch. A worktree is a separate directory, so the repo folder is left
  // exactly as it was and two chats can hold two branches at once.
  const shortName = (fullName.split("/").pop() || fullName);
  const branchName = "agent/" + slugifyTitle(shortName) + "-" + shortId;
  let branch = "";
  let branchErr = "";
  try {
    const wr = await sid("repos/worktree", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: fullName, branch: branchName, create: true }) });
    const wd = (wr && wr.data) || {};
    if (wr.ok && wd.ok && wd.branch) branch = wd.branch;
    else branchErr = wd.error || wr.status || "unknown error";
  } catch (e) { branchErr = String((e && e.message) || e); }

  if (!branch) {
    // Provisioning failed (unwritable worktrees dir, a stale directory git no
    // longer tracks, a repo that moved). Surface the real git error and let the
    // user fall back to the repo folder's current branch rather than silently
    // landing the agent's edits somewhere they don't expect. Never force.
    flashDsErr("Could not create this chat's worktree: " + branchErr);
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

  // PATCH title + repoId + agentTools (file + git) + folder + repoBranch in one
  // go — no extra round trip for the rename. A title set this way is marked
  // custom server-side, which is correct: it is deliberate, not auto-derived.
  const agentTools = "read_file,list_files,glob,grep,git_status,apply_patch,run_command,ask_user,get_time,git_commit,git_push,create_pr";
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
  // Navigate to the new chat without a full location.reload(): the app.js
  // listener for `nasllm:openConv` runs the existing openConversation path.
  // Refresh the repo dropdown first so the new chat appears under its repo
  // immediately (refreshLocal re-fetches /api/conversations and re-renders
  // the dropdown; the repo stays expanded via the persisted expandedRepos set).
  refreshLocal();
  navigateToConv(convId);
}

// --- Repos panel (GitHub connect/browse/clone; local repos live in the sidebar) ---
function openRepos() { $("dsReposOverlay")?.classList.add("open"); refreshGithub(); }
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
  add("Pull", "git pull --ff-only", () => pullRepo(r));
  add("Branch…", "Switch to a different branch (local or remote)", () => openBranchPicker(r));
  add("Session…", "Diff, commit & push, open PR, revert", () => openSessionPanel(r.name));
  add("Ship…", "Versioned release (changelog + commit/push)", () => openShipChanges(r));
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

// openChatBranchPicker lets the user move THIS CHAT (not the repo's shared
// checkout) onto a different git worktree: pick an existing branch, or create
// a new one (defaulting to agent/<slug of the chat title>, but editable).
// Either path ends in POST /__sidecar/repos/worktree to ensure the worktree
// exists, then PATCHes the conversation's repoBranch — the pair that makes
// this chat's tools actually run in that tree (see runToolExec). Distinct
// from openBranchPicker, which switches the repo's single shared checkout.
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
    card.appendChild(el("div", "ds-note", "Each chat gets its own git worktree, isolated from other chats on this repo — switching here never touches another chat's branch."));
    card.appendChild(el("div", "ds-label", "Existing branches"));
    list = el("div", "ds-branch-list"); list.id = "dsChatBranchList";
    card.appendChild(list);
    card.appendChild(el("div", "ds-label", "Or create a new branch"));
    const row = el("div", "ds-row");
    newInput = document.createElement("input"); newInput.id = "dsChatBranchNew"; newInput.type = "text";
    createBtn = el("button", "ds-btn", "Create & switch"); createBtn.id = "dsChatBranchCreateBtn";
    row.appendChild(newInput); row.appendChild(createBtn);
    card.appendChild(row);
    card.appendChild(el("div", "ds-note", "A new worktree starts clean — no node_modules, .env, or build caches — so the first run may need an install step."));
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
  createBtn.onclick = () => switchChatBranch(overlay, newInput.value.trim(), true);
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
    const isCur = bname === currentBranch;
    const row = el("div", "ds-branch-item" + (isCur ? " current" : ""));
    row.title = isCur ? "This chat's current branch" : "Switch this chat to " + bname;
    row.appendChild(el("span", "ds-branch-name", bname));
    if (isCur) row.appendChild(el("span", "ds-branch-badge ds-branch-cur", "current"));
    if (!isCur) row.onclick = () => switchChatBranch(overlay, bname, false);
    list.appendChild(row);
  });
}

// Ensures the worktree exists (creating the branch too when `create`), then
// PATCHes the conversation's repoBranch so runToolExec/branchForRepo pick it
// up immediately — that PATCH, not the worktree itself, is what actually
// isolates this chat's future tool calls.
async function switchChatBranch(overlay, branchName, create) {
  const out = $("dsChatBranchOut");
  if (!branchName) { if (out) out.textContent = "Enter a branch name."; return; }
  const ctx = overlay._ctx || {};
  const { convId, repoName } = ctx;
  if (!convId || !repoName) return;
  if (out) out.textContent = create ? "Creating worktree…" : "Switching…";
  const wr = await sid("repos/worktree", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: repoName, branch: branchName, create }) });
  const wd = (wr && wr.data) || {};
  if (!wr.ok || !wd.ok) { if (out) out.textContent = "Failed: " + (wd.error || wr.status || "unknown error"); return; }
  const finalBranch = wd.branch || branchName;
  try {
    await fetch("/api/conversations/" + encodeURIComponent(convId), { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repoBranch: finalBranch }) });
  } catch (e) {
    if (out) out.textContent = "Worktree ready, but could not update the chat: " + String((e && e.message) || e);
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
  nameBtn.title = r.branch ? (r.name + " · on " + r.branch) : r.name;
  // Name line: repo full name + (optional) dirty badge, then a branch subtitle
  // below it so the current branch is visible at a glance in the sidebar.
  const nameLine = el("span", "ds-repo-name-line");
  nameLine.appendChild(el("span", "ds-repo-name", r.name));
  if (r.dirty > 0) {
    const dirty = el("span", "ds-repo-dirty", "●" + r.dirty);
    dirty.title = r.dirty + " uncommitted/modified files — open ⋯ → Session to review and commit";
    nameLine.appendChild(dirty);
  }
  nameBtn.appendChild(nameLine);
  if (r.branch) nameBtn.appendChild(el("span", "ds-repo-branch", "⎇ " + r.branch));
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
    try { await createRepoChat(r); }
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
      const cr = el("div", "ds-repo-chat");
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
  const overlay = el("div", "ds-overlay");
  overlay.id = "dsReposOverlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "GitHub");
  const card = el("div", "ds-card ds-card-wide");
  const head = el("div", "ds-head");
  head.appendChild(el("h2", null, "GitHub"));
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

// --- Repo session panel (desktop-only) ---
// One per-repo view opened from the branch rail / per-repo ⋯ that merges the
// working-changes review with commit/push/open-PR/ship. Modeled on the Ship
// overlay: built once and reused; loadSessionPanel refreshes state + diff.
function openSessionPanel(repoName) {
  let overlay = $("dsSessionOverlay");
  if (!overlay) {
    overlay = el("div", "ds-overlay");
    overlay.id = "dsSessionOverlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "Repo session");
    const card = el("div", "ds-card ds-card-wide");
    const head = el("div", "ds-head");
    head.appendChild(el("h2", null, "Repo session"));
    const x = el("button", "ds-x"); x.textContent = "×"; x.title = "Close"; x.setAttribute("aria-label", "Close");
    x.onclick = () => overlay.classList.remove("open");
    head.appendChild(x);
    card.appendChild(head);
    const status = el("div", "ds-note"); status.id = "dsSessionStatus";
    card.appendChild(status);
    const diffWrap = el("div", "ds-approval-pre-wrap"); diffWrap.id = "dsSessionDiff";
    card.appendChild(diffWrap);
    card.appendChild(el("div", "ds-label", "Commit message"));
    const msgInput = document.createElement("input"); msgInput.id = "dsSessionMsg"; msgInput.type = "text"; msgInput.placeholder = "Describe what changed";
    card.appendChild(msgInput);
    const commitRow = el("div", "ds-row ds-approval-row");
    const commitBtn = el("button", "ds-btn", "Commit");
    const pushBtn = el("button", "ds-btn ds-btn-approve", "Commit & push");
    commitRow.appendChild(commitBtn); commitRow.appendChild(pushBtn);
    card.appendChild(commitRow);
    const commitOut = el("div", "ds-note"); commitOut.id = "dsSessionCommitOut";
    card.appendChild(commitOut);
    card.appendChild(el("div", "ds-label", "Open pull request"));
    const prTitle = document.createElement("input"); prTitle.id = "dsSessionPrTitle"; prTitle.type = "text"; prTitle.placeholder = "PR title";
    card.appendChild(prTitle);
    const prBody = document.createElement("textarea"); prBody.id = "dsSessionPrBody"; prBody.rows = 4; prBody.placeholder = "PR body (markdown)";
    card.appendChild(prBody);
    const prRow = el("div", "ds-row ds-approval-row");
    const prBtn = el("button", "ds-btn ds-btn-approve", "Open PR");
    prRow.appendChild(prBtn);
    card.appendChild(prRow);
    const prOut = el("div", "ds-note"); prOut.id = "dsSessionPrOut";
    card.appendChild(prOut);
    const actRow = el("div", "ds-row ds-approval-row");
    const revertBtn = el("button", "ds-btn ds-btn-ghost", "Revert");
    const shipBtn = el("button", "ds-btn ds-btn-ghost", "Ship…");
    actRow.appendChild(revertBtn); actRow.appendChild(shipBtn);
    card.appendChild(actRow);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.classList.remove("open"); });
    overlay._rebind = (name) => {
      overlay._repo = name;
      overlay._commit = (push) => sessionCommit(name, push);
      overlay._createPR = () => sessionCreatePR(name);
      overlay._revert = () => sessionRevert(name);
      overlay._ship = () => { overlay.classList.remove("open"); openShipChanges({ name }); };
    };
    commitBtn.onclick = () => overlay._commit(false);
    pushBtn.onclick = () => overlay._commit(true);
    prBtn.onclick = () => overlay._createPR();
    revertBtn.onclick = () => overlay._revert();
    shipBtn.onclick = () => overlay._ship();
  }
  const prev = overlay._repo;
  overlay._rebind(repoName);
  if (prev !== repoName) {
    const m = $("dsSessionMsg"); if (m) m.value = "";
    const pt = $("dsSessionPrTitle"); if (pt) pt.value = "";
    const pb = $("dsSessionPrBody"); if (pb) pb.value = "";
  }
  const co = $("dsSessionCommitOut"); if (co) co.textContent = "";
  const po = $("dsSessionPrOut"); if (po) po.textContent = "";
  overlay.classList.add("open");
  loadSessionPanel(repoName);
}

async function loadSessionPanel(repoName) {
  const overlay = $("dsSessionOverlay"); if (!overlay) return;
  const status = $("dsSessionStatus");
  const diffWrap = $("dsSessionDiff");
  if (status) status.textContent = "Loading repo state…";
  if (diffWrap) diffWrap.innerHTML = "";
  const sr = await sid("repos/state?name=" + encodeURIComponent(repoName));
  const sd = (sr && sr.data) || {};
  const dr = await sid("repos/diff", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: repoName }) });
  const dd = (dr && dr.data) || {};
  if (status) {
    const segs = [repoName];
    if (sd.branch) segs.push("⎇ " + sd.branch);
    if (sd.dirty) segs.push("●" + sd.dirty + " dirty");
    if (sd.ahead) segs.push("↑" + sd.ahead);
    if (sd.behind) segs.push("↓" + sd.behind);
    if (sd.hasRemote === false) segs.push("no remote");
    status.textContent = segs.join(" · ");
  }
  if (diffWrap) {
    if (dr.ok && dd.diff && dd.diff.trim()) renderApprovalContent(diffWrap, "apply_patch", dd.diff);
    else diffWrap.appendChild(el("div", "ds-note", "No uncommitted changes."));
  }
  // Commit & push + Open PR both need a remote.
  const hasRemote = sd.hasRemote !== false;
  overlay.querySelectorAll(".ds-btn-approve").forEach((b) => {
    if (!hasRemote) { b.disabled = true; b.title = "No remote configured for this repo."; }
    else { b.disabled = false; b.title = ""; }
  });
}

async function sessionCommit(repoName, push) {
  const out = $("dsSessionCommitOut");
  const msg = ($("dsSessionMsg") && $("dsSessionMsg").value.trim()) || "";
  if (!msg) { if (out) out.textContent = "Enter a commit message."; return; }
  if (push) {
    const ok = await dsConfirm("Push to the remote?", "This commits and pushes " + repoName + " to its origin.");
    if (!ok) return;
  }
  if (out) out.textContent = push ? "Committing and pushing…" : "Committing…";
  const res = await sid("repos/commit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repo: repoName, message: msg, push }) });
  const d = (res && res.data) || {};
  if (d.ok) {
    const head = (d.head || "").slice(0, 7);
    if (out) out.textContent = push ? (d.pushed ? "Pushed ✓ (head " + head + ")" : ("Committed, but push failed: " + (d.error || "unknown"))) : "Committed ✓ (head " + head + ")";
    loadSessionPanel(repoName);
    refreshRailState();
    refreshLocal();
  } else {
    if (out) out.textContent = "Failed: " + (d.error || res.status || "unknown");
  }
}

async function sessionCreatePR(repoName) {
  const out = $("dsSessionPrOut");
  const title = ($("dsSessionPrTitle") && $("dsSessionPrTitle").value.trim()) || "";
  const body = ($("dsSessionPrBody") && $("dsSessionPrBody").value) || "";
  if (!title) { if (out) out.textContent = "Enter a PR title."; return; }
  if (out) out.textContent = "Pushing branch and opening PR…";
  const res = await sid("repos/create-pr", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repo: repoName, title, body }) });
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

async function sessionRevert(repoName) {
  const ok = await dsConfirm("Revert all working changes in " + repoName + "?", "This runs git checkout -- . && git clean -fd, discarding all uncommitted edits.");
  if (!ok) return;
  const res = await sid("repos/revert", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: repoName }) });
  const d = (res && res.data) || {};
  if (!d.ok) flashDsErr(d.error || res.status);
  loadSessionPanel(repoName);
  refreshRailState();
  refreshLocal();
}

function makeReposBtn() {
  const btn = el("button", "ds-repos-btn");
  btn.title = "GitHub (connect account, browse & clone repos)"; btn.setAttribute("aria-label", "GitHub");
  btn.textContent = "GitHub";
  btn.onclick = (e) => { e.stopPropagation(); openRepos(); };
  return btn;
}

// --- Sidebar "Repos" section: local repos live in the left sidebar (not the
// GitHub modal), with a "+" to connect a folder and a "⋯" for cross-repo
// working changes. Injected into #sidebar, between #sideHead and #convList. ---
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
  const title = el("div", "ds-sidebar-repos-title", "Repos");
  head.appendChild(chev); head.appendChild(title);
  const changesBtn = el("button", "ds-sidebar-icon-btn", "⋯");
  changesBtn.title = "Working changes across all repos"; changesBtn.setAttribute("aria-label", "Working changes");
  changesBtn.onclick = (e) => { e.stopPropagation(); openWorkingChanges(); };
  const addBtn = el("button", "ds-sidebar-icon-btn", "+");
  addBtn.title = "Connect a folder"; addBtn.setAttribute("aria-label", "Connect a folder");
  addBtn.onclick = async (e) => {
    e.stopPropagation();
    addBtn.disabled = true;
    const ok = await connectFolderFlow();
    addBtn.disabled = false;
    if (ok) refreshLocal();
  };
  head.appendChild(changesBtn); head.appendChild(addBtn);
  head.addEventListener("click", () => toggleSidebarRepos());
  wrap.appendChild(head);
  const body = el("div", "ds-sidebar-repos-body"); body.id = "dsLocalBody";
  wrap.appendChild(body);
  sidebar.insertBefore(wrap, sideHead.nextSibling);
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
    overlay.setAttribute("aria-label", "Connect your repos");
    const card = el("div", "ds-card");
    const head = el("div", "ds-head");
    head.appendChild(el("h2", null, "Connect your repos"));
    const x = el("button", "ds-x"); x.textContent = "×"; x.title = "Skip"; x.setAttribute("aria-label", "Skip");
    head.appendChild(x);
    card.appendChild(head);
    card.appendChild(el("div", "ds-note", "Connect a local git repo to start chatting with your codebase — ask questions, get edits, and review diffs before they're applied."));
    const row = el("div", "ds-row ds-approval-row");
    const skipBtn = el("button", "ds-btn ds-btn-ghost", "Skip for now");
    const connectBtn = el("button", "ds-btn", "Connect a folder");
    row.appendChild(skipBtn); row.appendChild(connectBtn);
    card.appendChild(row);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    const dismiss = () => { markRepoWizardSeen(); overlay.classList.remove("open"); };
    x.onclick = dismiss;
    skipBtn.onclick = dismiss;
    overlay.addEventListener("click", (e) => { if (e.target === overlay) dismiss(); });
    connectBtn.onclick = async () => {
      connectBtn.disabled = true;
      const ok = await connectFolderFlow();
      connectBtn.disabled = false;
      if (ok) { refreshLocal(); markRepoWizardSeen(); overlay.classList.remove("open"); }
    };
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
  loadAgentGlobalAutoApprove();
  // syncAuthedUI places the gear/GitHub buttons and — once #app is actually
  // visible (authed) — builds the sidebar Repos section, populates it, and
  // (only the first time, with zero repos connected) shows the connect wizard.
  const syncAuthedUI = () => {
    addSettingsButton();
    const app = $("app");
    if (app && !app.classList.contains("hidden")) {
      buildSidebarRepos();
      refreshLocal();
      maybeShowRepoWizard();
      syncBranchRail();
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
  // Branch rail: re-derive the active repo-bound chat when the sidebar
  // re-renders (app.js marks the active conv row) or when desktop.js navigates
  // to a chat via the nasllm:openConv event.
  const convListEl = $("convList");
  if (convListEl) new MutationObserver(() => syncBranchRail()).observe(convListEl, { childList: true, subtree: true });
  window.addEventListener("nasllm:openConv", () => syncBranchRail());
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
