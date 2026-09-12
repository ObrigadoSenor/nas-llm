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
  await refreshState();
  buildOverlay();
  fillOverlay();
  addSettingsButton();
  hookLogin();
  // Re-run gear placement when the auth view toggles (#app hidden ⇄ shown).
  const app = $("app");
  if (app) new MutationObserver(addSettingsButton).observe(app, { attributes: true, attributeFilter: ["class"] });
}

// The injected <script> is placed after app.js, so #app/#login already exist.
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootDesktop);
} else {
  bootDesktop();
}
