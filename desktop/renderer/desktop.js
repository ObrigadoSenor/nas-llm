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

function localRow(r) {
  const row = el("div", "ds-repo-row");
  const main = el("div", "ds-repo-main");
  const name = el("div", "ds-repo-name", r.name);
  const dirtyBadge = r.dirty > 0 ? el("span", "ds-badge ds-badge-dirty", r.dirty + " dirty") : el("span", "ds-badge ds-badge-clean", "clean");
  name.appendChild(dirtyBadge);
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
  return row;
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
    const rr = await sid("github/repos");
    body.innerHTML = "";
    if (rr.ok && Array.isArray(rr.data)) {
      if (!rr.data.length) body.appendChild(el("div", "ds-note", "No repositories found."));
      rr.data.forEach(r => body.appendChild(ghRow(r)));
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
  const res = await sid("repos/local");
  body.innerHTML = "";
  if (res.ok && Array.isArray(res.data)) {
    if (!res.data.length) { body.appendChild(el("div", "ds-note", "No local clones yet. Connect GitHub and clone a repo above.")); return; }
    res.data.forEach(r => body.appendChild(localRow(r)));
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
  const ghBody = el("div", null); ghBody.id = "dsGhBody";
  listWrap.appendChild(ghBody);
  card.appendChild(listWrap);
  // Local clones
  card.appendChild(el("div", "ds-label", "Local clones"));
  const localBody = el("div", null); localBody.id = "dsLocalBody";
  card.appendChild(localBody);
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
