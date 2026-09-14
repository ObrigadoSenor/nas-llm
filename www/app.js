// nas-llm chat UI — app logic, split out of the old single-file index.html.
// Imports UI helpers (icons, markdown rendering) from lib.js. No build step.
import { icon, setIcon, renderMessage, escapeHtml, StreamRenderer, thinkingDots, renderSearchBlock, appendSearchEntry, showSearchPending, clearSearchPending, renderSourceLinks, appendSourceLinks, renderClarifyCard, renderAgentSteps, appendAgentStep, buildThoughtsWrap, renderThoughts, appendThought, setThoughtsSummary } from './lib.js?v=28';

const $ = id => document.getElementById(id);
const app=$("app"), loginView=$("login");
const chat=$("chat"), input=$("input"), send=$("send"), modelBtn=$("modelBtn"), modelBanner=$("modelBanner");
const convList=$("convList"), whoEmail=$("whoEmail");
const chatTitle=$("chatTitle"), chatMeta=$("chatMeta");
const loginEmail=$("loginEmail"), loginBtn=$("loginBtn"), loginInfo=$("loginInfo");
const sidebar=$("sidebar"), scrim=$("scrim"), menuBtn=$("menuBtn"), closeSide=$("closeSide");
const plusBtn=$("plusBtn"), plusPopup=$("plusPopup"), slashPopup=$("slashPopup"), pills=$("pills");
const attachBtn=$("attachBtn"), fileInput=$("fileInput"), imgPills=$("imgPills");

// Static button icons (set once; the buttons live inside #app, which is hidden
// until auth, so there's no flash of unstyled content).
setIcon($("newChat"), "new-chat", 16); $("newChat").insertAdjacentHTML("beforeend", '<span>New chat</span>');
setIcon($("newFolder"), "folder-plus", 18);
setIcon($("closeSide"), "close", 18);
setIcon($("menuBtn"), "menu", 18);
setIcon($("plusBtn"), "plus", 18);
setIcon($("send"),"send",16); $("send").setAttribute("aria-label","Send");
setIcon(attachBtn,"paperclip",16);
setIcon($("logout"), "logout", 15); $("logout").insertAdjacentHTML("beforeend", '<span>Log out</span>');
setIcon($("closeModels"), "close", 18);
setIcon($("closeAgent"), "close", 18);

let me = null;                 // {email} once logged in
let models = [];
let selectedModel = localStorage.getItem("nas-llm-model") || "";
let conversations = [];
let folders = [];
let collapsedFolders = JSON.parse(localStorage.getItem("nas-llm-collapsed")||"{}");
let activeId = null;           // null = new, unsaved chat
let messages = [];
let openMenu = null;           // currently shown row action menu element
let dragConv = null;           // conversation being dragged onto a folder
// Extras: add-ons the user toggles via the + menu. Active ones ride along on
// the next generate request and show as removable pills above the input.
const EXTRA_DEFS = [
  { id:"web", label:"Web search", icon:"globe", exclusive:["clarify","agent"], needsTools:true },
  { id:"clarify", label:"Clarify", icon:"help", exclusive:["web","agent"], needsTools:true },
  { id:"agent", label:"Agent", icon:"sparkles", exclusive:["web","clarify"], needsTools:true },
];
let activeExtras = loadExtras();
function loadExtras(){
  let ids=[]; try{ ids=JSON.parse(localStorage.getItem("nas-llm-extras")||"[]")||[]; }catch{}
  // Web search is opt-in via the + menu and persists in nas-llm-extras. Drop the
  // legacy single-toggle key so it can't re-add the pill on every refresh.
  try{ localStorage.removeItem("nas-llm-search"); }catch{}
  return new Set(ids.filter(id=>EXTRA_DEFS.some(d=>d.id===id)));
}
function saveExtras(){ localStorage.setItem("nas-llm-extras", JSON.stringify([...activeExtras])); }
function webSearchOn(){ return activeExtras.has("web"); }
function clarifyOn(){ return activeExtras.has("clarify"); }
function agentOn(){ return activeExtras.has("agent"); }
let generatingIds = new Set(); // conversation IDs with an active background job
let finishedIds = new Set();   // conversation IDs with an unseen completion badge (cleared on open)
let activeES = null;           // the current EventSource tail (active conversation)
let activeJobConvId = null;    // conversation whose tail is currently open
let pendingClarifyAnswer = null; // option clicked while a question was still finalizing
let inputHistory = loadInputHistory(); // sent questions, oldest→newest
let histIndex = inputHistory.length;   // pointer; ==length means "current draft"
let draft = "";                        // in-progress text saved on first ArrowUp
let pendingImages = [];                // staged data URLs for the next send
const modelCaps = new Map();           // name -> string[] (capabilities from /info)
const capsChecked = new Set();         // model names already queried via /info
// Visitor's local Ollama models (localhost:11434), discovered from the
// browser. NAMES persist to localStorage so a reload reattaches them in the
// selector even before the re-probe finishes; rich info (size/details) is
// kept in memory only. modelEntries merges server + local for the selector.
let localModelNames = loadLocalModelNames();
let localModels = [];                  // [{name,sizeGB,details}] from the last successful probe
let modelEntries = [];                 // merged server+local entries driving the selector
let lastServerModels = [];             // raw /api/models data, cached for re-merges after a probe
// Per-conversation AbortControllers for in-flight localhost inference, keyed by
// convId. A map (not a singleton) so stopping or switching away from one chat
// can never abort a different chat's local-model relay — that used to be the
// bug that made a second chat kill the first. Set when a modelCall round
// starts (foreground tailJob or the headless global-stream path), cleared when
// the round finishes/fails/aborts.
const localAborts = new Map();
// jobIds already turned into a "finished" toast/badge/CustomEvent, so a job
// whose terminal event arrives on both the foreground tail and the global
// stream (a real race — see openGlobalStream) is never notified twice.
const notifiedJobIds = new Set();
// convIds the user explicitly Stopped from the foreground. tailJob's "done"
// handler can't otherwise tell a clean finish from a user-requested stop (the
// backend's per-conversation "done" event carries no payload), so stopActive
// marks it here just before calling /cancel.
const stoppedByUser = new Set();
let localDiscoverMsg = null;           // last discovery error string (shown in the Local section)
function loadLocalModelNames(){ try{ return JSON.parse(localStorage.getItem("nas-llm-local-models")||"[]")||[]; }catch{ return []; } }
function saveLocalModelNames(){ localStorage.setItem("nas-llm-local-models", JSON.stringify(localModelNames)); }
function isLocalModel(name){ return localModelNames.includes(name); }
function hostLabel(h){ return {nas:"NAS",mac:"Mac"}[h]||h; }
// Merge server models (from /api/models, carrying host/hostOnline) with the
// local set. Dedupe by name: if a name is both local and on a server host,
// keep the Local entry and drop the server duplicate. Ordered NAS, Mac, Local.
function buildModelEntries(serverData, localEntries){
  // localEntries may be rich objects ({name,capabilities,…}) or persisted
  // name strings (pre-probe); normalize so a reload still seeds the selector
  // before the localhost re-probe finishes.
  const locs=(localEntries||[]).map(x=> typeof x==="string" ? {name:x, capabilities:[]} : x);
  const localByName=new Map(locs.map(m=>[m.name, m]));
  const entries=[]; const seen=new Set();
  for(const m of serverData){
    const name=m.name||m.id; if(!name) continue;
    if(localByName.has(name)) continue;        // local wins -> drop server duplicate
    if(seen.has(name)) continue; seen.add(name);
    entries.push({name, host:m.host||"nas", hostOnline:m.hostOnline!==false, local:false, capabilities:m.capabilities||[]});
  }
  for(const m of locs){ if(seen.has(m.name)) continue; seen.add(m.name); entries.push({name:m.name, host:"local", hostOnline:true, local:true, capabilities:m.capabilities||[]}); }
  const order={nas:0,mac:1,local:2};
  entries.sort((a,b)=>(order[a.host]??9)-(order[b.host]??9)||a.name.localeCompare(b.name));
  return entries;
}
function syncSelectedFromEntries(){
  if(modelEntries.length && !models.includes(selectedModel)){
    const onl=modelEntries.find(e=>e.hostOnline);
    selectedModel = onl?onl.name:modelEntries[0].name;
  }
}
// Rich local entries for the selector: use discovered models (with caps) when
// available, else the persisted name list so a reload reattaches immediately.
function localEntries(){ return localModels.length ? localModels : localModelNames; }
// Capabilities for a selected model name, from the merged selector entries.
// Returns [] when unknown (e.g. older Ollama that doesn't report capabilities).
function modelCapabilities(name){
  // Prefer the authoritative caps from /api/models/:name/info (modelCaps) when
  // available; fall back to the merged selector entry caps (from /api/models
  // for server models, /api/tags for local models) so gating works before the
  // lazy /info probe finishes and for local models (whose /info can't run).
  const cached=modelCaps.get(name);
  if(cached && cached.length) return cached;
  const e=modelEntries.find(e=>e.name===name);
  return e ? (e.capabilities||[]) : [];
}
// modelSupportsTools returns true/false when the model's capabilities are known,
// or null when unknown. renderPlusPopup blocks new activation on null
// ("checking tool support…") and on false (no tool support); enforceToolGating
// only drops an existing pill on false, leaving a stale unknown pill for the
// backend's runGeneration guard to catch (so a reload never wipes a tool-capable
// user's Web search toggle while the lazy /info probe is still in flight).
function modelSupportsTools(name){
  const caps=modelCapabilities(name);
  if(!caps.length) return null;
  return caps.includes("tools");
}
// Drop any active tool-requiring extra (web/clarify/agent) when the selected
// model is known to lack tool support, so a non-tool model can't sit in a mode
// that will silently just answer. Called after model lists refresh and on model
// change. No-op when capabilities are unknown.
function enforceToolGating(){
  if(modelSupportsTools(selectedModel)===false){
    let changed=false;
    EXTRA_DEFS.forEach(d=>{ if(d.needsTools && activeExtras.has(d.id)){ activeExtras.delete(d.id); changed=true; } });
    if(changed) saveExtras();
  }
  renderExtras();
}

function renderPills(){
  pills.innerHTML="";
  activeExtras.forEach(id=>{
    const def=EXTRA_DEFS.find(d=>d.id===id); if(!def) return;
    const pill=document.createElement("span"); pill.className="pill";
    pill.innerHTML=icon(def.icon,13)+'<span>'+escapeHtml(def.label)+'</span>';
    const x=document.createElement("button"); x.type="button"; x.className="pill-x"; x.setAttribute("aria-label","Remove "+def.label);
    x.innerHTML=icon("close",12);
    x.addEventListener("click",e=>{ e.stopPropagation(); activeExtras.delete(id); saveExtras(); renderExtras(); });
    pill.appendChild(x); pills.appendChild(pill);
  });
  pills.classList.toggle("hidden", activeExtras.size===0);
}
function renderPlusPopup(){
  plusPopup.innerHTML="";
  const toolsOk=modelSupportsTools(selectedModel); // null=unknown, true, false
  EXTRA_DEFS.forEach(def=>{
    const on=activeExtras.has(def.id);
    const blocked=!!def.needsTools && toolsOk!==true; // also block while unknown (null)
    const b=document.createElement("button"); b.type="button"; b.className="plus-item"+(on?" on":"")+(blocked?" disabled":"");
    b.setAttribute("role","menuitemcheckbox"); b.setAttribute("aria-checked",String(on));
    if(blocked) b.title = toolsOk===false
      ? selectedModel+" has no tool support — use a tool-capable model (e.g. llama3.1:8b, qwen3:1.7b) for "+def.label+"."
      : selectedModel+" — checking tool support…";
    b.disabled=blocked;
    b.innerHTML=icon(def.icon,16)+'<span>'+escapeHtml(def.label)+'</span>'+(on?icon("check",14):'');
    b.addEventListener("click",e=>{ e.stopPropagation(); if(blocked) return; if(activeExtras.has(def.id)){ activeExtras.delete(def.id); } else { activeExtras.add(def.id); (def.exclusive||[]).forEach(x=>activeExtras.delete(x)); } saveExtras(); renderExtras(); });
    plusPopup.appendChild(b);
  });
  const sep=document.createElement("div"); sep.className="plus-sep";
  const cfg=document.createElement("button"); cfg.type="button"; cfg.className="plus-item plus-cfg";
  cfg.innerHTML=icon("wrench",16)+'<span>Agent settings…</span>';
  cfg.addEventListener("click",e=>{ e.stopPropagation(); setPlusPopup(false); openAgentPanel(); });
  plusPopup.appendChild(sep); plusPopup.appendChild(cfg);
}
function renderExtras(){ renderPills(); renderPlusPopup(); }
function setPlusPopup(open){ plusPopup.classList.toggle("hidden", !open); plusBtn.classList.toggle("on", open); plusBtn.setAttribute("aria-expanded", String(open)); }
plusBtn.addEventListener("click", e=>{ e.stopPropagation(); setPlusPopup(plusPopup.classList.contains("hidden")); });
document.addEventListener("click", e=>{ if(plusPopup.classList.contains("hidden")) return; if(!plusPopup.contains(e.target) && !plusBtn.contains(e.target)) setPlusPopup(false); });
document.addEventListener("keydown", e=>{ if(e.key==="Escape" && !plusPopup.classList.contains("hidden")) setPlusPopup(false); });
renderExtras();

// --- Image attachments (vision models only) --------------------------------
// The backend stores per-message images as base64 data URLs and turns them into
// OpenAI image_url parts for vision-capable models (e.g. gemma3:4b). The UI
// stages them as removable thumbnails above the input and sends them with the
// next user turn. Attach is only offered when the selected model reports the
// "vision" capability, queried lazily from /api/models/:name/info.
function modelCapsFor(name){ return modelCaps.get(name)||[]; }
function isVisionModel(name){ return modelCapsFor(name).includes("vision"); }
// Fetch /api/models/:name/info once per session and cache its capabilities so
// the model dropdown can badge vision/tools/thinking without a per-click call.
// syncVision awaits it for the selected model so the composer's attach button
// appears as soon as the capability is known; prefetchCaps fans it out to all.
async function ensureCaps(name){
  if(!name || capsChecked.has(name)) return;
  capsChecked.add(name);
  // A local (browser-relay) model lives on the visitor's own Ollama, which the
  // NAS backend can't introspect — /api/models/:name/info 404s for it. Query
  // localhost:11434/api/show directly from the browser instead (text/plain keeps
  // it a CORS simple request with no preflight, same dodge as the relay/pull).
  if(isLocalModel(name)){
    try{
      const r=await fetch("http://localhost:11434/api/show",{method:"POST",headers:{"Content-Type":"text/plain"},body:JSON.stringify({model:name})});
      if(r.ok){ const j=await r.json(); modelCaps.set(name, j.capabilities||[]); }
    }catch{}
    if(name===selectedModel) enforceToolGating();
    return;
  }
  try{
    const r=await fetchRetry("/api/models/"+encodeURIComponent(name)+"/info",{},{label:"Model info"});
    if(!r.ok) return;
    const j=await r.json();
    modelCaps.set(name, j.capabilities||[]);
    if(name===selectedModel) enforceToolGating();
  }catch{}
}
async function syncVision(){ renderComposer(); await ensureCaps(selectedModel); renderComposer(); }
function renderComposer(){
  const vision=isVisionModel(selectedModel);
  attachBtn.classList.toggle("hidden", !vision);
  document.querySelector(".input-wrap").classList.toggle("has-attach", vision);
  input.placeholder = vision ? "Message, or paste / drop an image" : "";
  if(!vision && pendingImages.length){ pendingImages=[]; }
  renderImgPills();
}
function renderImgPills(){
  imgPills.innerHTML="";
  pendingImages.forEach((src,i)=>{
    const pill=document.createElement("div"); pill.className="img-pill";
    const im=document.createElement("img"); im.src=src; im.alt="attachment"; pill.appendChild(im);
    const x=document.createElement("button"); x.type="button"; x.className="img-x"; x.setAttribute("aria-label","Remove image");
    x.innerHTML=icon("close",12);
    x.addEventListener("click",e=>{ e.stopPropagation(); pendingImages.splice(i,1); renderImgPills(); autosize(); });
    pill.appendChild(x); imgPills.appendChild(pill);
  });
  imgPills.classList.toggle("hidden", pendingImages.length===0);
}
function readAsDataURL(file){ return new Promise((res,rej)=>{ const r=new FileReader(); r.onload=()=>res(String(r.result)); r.onerror=()=>rej(r.error); r.readAsDataURL(file); }); }
// Downscale large uploads (phone photos) so multi-MB base64 blobs aren't stored
// in SQLite or pushed to the N100. Longest edge capped at max; smaller passes.
function downscaleImage(dataURL, max=1280){
  return new Promise(resolve=>{
    const img=new Image();
    img.onload=()=>{
      const w=img.naturalWidth, h=img.naturalHeight;
      if(!w||!h||Math.max(w,h)<=max){ resolve(dataURL); return; }
      const s=max/Math.max(w,h);
      const c=document.createElement("canvas"); c.width=Math.round(w*s); c.height=Math.round(h*s);
      const ctx=c.getContext("2d"); ctx.drawImage(img,0,0,c.width,c.height);
      try{ resolve(c.toDataURL("image/jpeg",0.82)); }catch{ resolve(dataURL); }
    };
    img.onerror=()=>resolve(dataURL);
    img.src=dataURL;
  });
}
async function addImageFiles(files){
  if(!isVisionModel(selectedModel)) return;
  for(const file of files){
    if(!file.type.startsWith("image/")) continue;
    try{ let url=await readAsDataURL(file); url=await downscaleImage(url); pendingImages.push(url); }catch{}
  }
  renderImgPills(); autosize();
}
attachBtn.addEventListener("click",()=>{ if(isVisionModel(selectedModel)) fileInput.click(); });
fileInput.addEventListener("change",()=>{ if(fileInput.files && fileInput.files.length){ addImageFiles([...fileInput.files]); } fileInput.value=""; });
input.addEventListener("paste",e=>{
  if(!isVisionModel(selectedModel)) return;
  const items=e.clipboardData && e.clipboardData.items; if(!items) return;
  const files=[];
  for(const it of items){ if(it.kind==="file" && it.type.startsWith("image/")){ const f=it.getAsFile(); if(f) files.push(f); } }
  if(files.length){ e.preventDefault(); addImageFiles(files); }
});
const composer=document.querySelector(".composer");
composer.addEventListener("dragover",e=>{
  if(!isVisionModel(selectedModel)) return;
  if(e.dataTransfer && [...e.dataTransfer.types].includes("Files")){ e.preventDefault(); composer.classList.add("drag-over"); }
});
composer.addEventListener("dragleave",e=>{ if(!composer.contains(e.relatedTarget)) composer.classList.remove("drag-over"); });
composer.addEventListener("drop",e=>{
  composer.classList.remove("drag-over");
  if(!isVisionModel(selectedModel)) return;
  if(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length){
    const imgs=[...e.dataTransfer.files].filter(f=>f.type.startsWith("image/"));
    if(imgs.length){ e.preventDefault(); addImageFiles(imgs); }
  }
});
renderComposer();

// The Send button becomes Stop while the open conversation is generating.
function renderSend(){
  const gen = activeJobConvId !== null && activeJobConvId === activeId;
  if(gen){ setIcon(send,"stop",16); send.classList.add("stop"); send.setAttribute("aria-label","Stop"); send.disabled=false; }
  else { setIcon(send,"send",16); send.classList.remove("stop"); send.setAttribute("aria-label","Send"); send.disabled=false; }
}
async function stopActive(){
  if(activeJobConvId !== activeId) return;
  const id=activeId;
  send.disabled=true;
  // For a local-model job, abort the in-flight localhost inference immediately
  // so Stop is responsive — don't wait for the SSE "done" round-trip. Looked
  // up by convId (not a singleton) so this can never abort a different chat's
  // relay. The backend /cancel still finalizes the connection-bound job.
  const ctrl=localAborts.get(id);
  if(ctrl){ ctrl.abort(); localAborts.delete(id); }
  // The per-conversation "done" event carries no payload, so tailJob can't
  // otherwise distinguish a clean finish from a user-requested stop — stash
  // the intent here so it can report "cancelled" instead of "done".
  stoppedByUser.add(id);
  try{ await fetch("/api/conversations/"+encodeURIComponent(id)+"/cancel",{method:"POST"}); }catch{}
  // The SSE "done" event from the cancelled job finalizes the UI; if it never
  // arrives (e.g. the job already finished), fall back after a short delay.
  setTimeout(()=>{ if(activeJobConvId === activeId){ activeJobConvId=null; renderSend(); } }, 4000);
}

// --- Retry with exponential backoff (network/CORS/429/5xx are retryable) ----
const MAX_RETRIES = 4, BASE_DELAY = 1000, MAX_DELAY = 16000;
const sleep = ms => new Promise(r=>setTimeout(r,ms));
function isRetryableErr(e){
  const t=String(e&&e.message||e);
  if(/load failed|failed to fetch|networkerror|network request failed/i.test(t)) return true;
  if(e&&e.status===429) return true;
  if(e&&e.status>=500 && e.status<600) return true;
  return false;
}
function errText(e){
  const t=String(e&&e.message||e);
  if(/load failed|failed to fetch|networkerror/i.test(t))
    return "could not reach the server (network or rate-limit)";
  return t;
}
async function fetchRetry(url, opts, {onRetry, label="request"}={}){
  let lastErr;
  for(let attempt=0; attempt<=MAX_RETRIES; attempt++){
    let r, threw=false;
    try{ r=await fetch(url, opts); }
    catch(e){ threw=true; lastErr=e; }
    if(!threw){
      if(r.ok) return r;
      const err=new Error("HTTP "+r.status+(r.status===401?" — session expired?":""));
      err.status=r.status;
      if(!isRetryableErr(err)) throw err;            // 401/4xx -> fail fast
      lastErr=err;
    }
    if(attempt===MAX_RETRIES) break;
    const delay=Math.min(MAX_DELAY, BASE_DELAY*2**attempt) * (0.7+Math.random()*0.6);
    if(onRetry) onRetry(attempt+1, Math.round(delay));
    await sleep(delay);
  }
  throw new Error(label+" failed after "+(MAX_RETRIES+1)+" attempts: "+errText(lastErr));
}

// --- Auth gate --------------------------------------------------------------
async function boot(){
  try{
    const r=await fetch("/api/auth/me");
    if(r.ok){ me=await r.json(); await showApp(); }
    else showLogin();
  }catch{ showLogin(); }
}
function showLogin(){
  app.classList.add("hidden"); loginView.classList.remove("hidden");
  loginInfo.textContent=""; loginEmail.focus();
}
async function showApp(){
  loginView.classList.add("hidden"); app.classList.remove("hidden");
  whoEmail.textContent=me.email;
  await loadModels();
  reattachLocalModels();          // re-probe localhost so a reload reattaches
  resumeLocalPull();              // re-drive a local pull that was mid-download before the reload
  await loadConversations();
  await loadActiveJobs();
  // The global stream is user-scoped and multiplexed (contract 1), so opening
  // it once here already covers every active job — including ones that were
  // mid-run before this reload — with no per-conversation reattachment needed.
  openGlobalStream();
  if(conversations.length) await openConversation(conversations[0].id);
  else newChat();
  input.focus();
  // Keep the sidebar's generating indicators fresh while jobs run in the
  // background (a job can finish on a chat the user isn't viewing).
  setInterval(syncGenerating, 5000);
}

loginBtn.addEventListener("click", async ()=>{
  const email=loginEmail.value.trim().toLowerCase();
  loginInfo.textContent=""; loginBtn.disabled=true;
  if(!email || email.indexOf("@")<1){ loginInfo.textContent="Enter a valid email."; loginBtn.disabled=false; return; }
  try{
    const r=await fetch("/api/auth/request",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email})});
    if(r.ok) loginInfo.textContent="Check your email for a sign-in link. It expires in 15 minutes.";
    else if(r.status===429) loginInfo.textContent="Too many attempts. Wait a few minutes and try again.";
    else { let j={}; try{j=await r.json()}catch{} loginInfo.textContent=j.error||"Could not send a link."; }
  }catch{ loginInfo.textContent="Network error — could not reach the server."; }
  finally{ loginBtn.disabled=false; }
});
loginEmail.addEventListener("keydown", e=>{ if(e.key==="Enter"){ e.preventDefault(); loginBtn.click(); } });

async function logout(){
  closeTail(); activeJobConvId=null; generatingIds=new Set();
  closeGlobalStream();
  localAborts.forEach(ctrl=>ctrl.abort()); localAborts.clear();
  notifiedJobIds.clear(); stoppedByUser.clear(); finishedIds=new Set();
  try{ await fetch("/api/auth/logout",{method:"POST"}); }catch{}
  me=null; activeId=null; messages=[]; conversations=[]; selectedModel="";
  showLogin(); renderSend();
}
$("logout").addEventListener("click", logout);
$("newChat").addEventListener("click", ()=>{ newChat(); closeSidebar(); });

// --- Models -----------------------------------------------------------------
async function loadModels(){
  try{
    const r=await fetchRetry("/api/models",{},{label:"Load models"});
    const j=await r.json();
    lastServerModels=j.data||[];
    modelEntries=buildModelEntries(lastServerModels, localEntries());
    models=modelEntries.map(e=>e.name);
    syncSelectedFromEntries();
    renderModels();
    syncVision();
    enforceToolGating();
  }catch(e){ renderModels(); modelBtn.title=String(e.message||e); }
}
// Re-probe localhost on boot/showApp so a reload reattaches the visitor's
// local Ollama models without making them click Connect again. Silent on
// failure: the persisted name list still seeds the selector, and no error is
// surfaced (the user didn't ask to connect this session).
async function reattachLocalModels(){
  const res=await discoverLocalModels();
  if(res.ok){ localModels=res.models; localModelNames=res.models.map(m=>m.name); saveLocalModelNames(); }
  modelEntries=buildModelEntries(lastServerModels, localEntries());
  models=modelEntries.map(e=>e.name);
  syncSelectedFromEntries();
  renderModels();
  enforceToolGating();
  if($("modelsModal").classList.contains("open") && modelsTab==="installed") renderInstalledTab();
}
// Discover the visitor's local Ollama (localhost:11434). A cross-origin GET
// that Ollama 403s (no OLLAMA_ORIGINS) is surfaced by the browser as a thrown
// TypeError, not an exposed 403 — so the catch below is hit for the common
// "needs OLLAMA_ORIGINS" case too, not only when nothing is listening. The
// HTTPS-page-to-http-localhost request can also trip Chrome's Local Network
// Access gate; both land in the same catch as opaque TypeErrors.
async function discoverLocalModels(){
  let r;
  try{ r=await fetch("http://localhost:11434/api/tags"); }
  catch(e){ return {ok:false, kind:"refused", error:String(e&&e.message||e)}; }
  if(r.status===403) return {ok:false, kind:"origins"};
  if(!r.ok) return {ok:false, kind:"http", status:r.status};
  let j; try{ j=await r.json(); }catch{ return {ok:false, kind:"http", status:r.status}; }
  const mods=(j.models||[]).map(m=>({name:m.name, sizeGB:m.size?m.size/1e9:0, details:m.details||{}, capabilities:m.capabilities||[]}));
  return {ok:true, models:mods};
}
function hostBadge(host){
  const b=document.createElement("span"); b.className="model-badge host host-"+host;
  b.textContent={nas:"NAS",mac:"Mac",local:"Local"}[host]||host;
  return b;
}
function speedBadgeFor(tps){
  if(!tps || tps<=0) return null;
  const cls=tps>=12?"speed-fast":tps>=6?"speed-ok":"speed-slow";
  const b=document.createElement("span"); b.className="model-badge speed "+cls;
  b.textContent=tps.toFixed(0)+" t/s";
  return b;
}
function capBadge(c){
  if(c==="completion") return null;                 // chat is universal — skip
  const label={vision:"vision",tools:"tools",thinking:"thinking",embedding:"embed"}[c];
  if(!label) return null;
  const b=document.createElement("span"); b.className="model-badge cap cap-"+c;
  b.textContent=label; return b;
}
// --- Unified model picker (drawer) ------------------------------------------
// The header model button opens a single drawer: an Installed tab that is a
// one-click selectable list (the current model is always bannered at the top)
// and a "Get more models" tab for downloads. There is no separate dropdown
// popover or manage-models button — picking and managing happen in one place.
// A selectable installed-model row (NAS/Mac server). Clicking selects the model
// and updates the banner/header/row highlights in place — the drawer stays open
// so the choice is visible. A per-row ⋯ menu offers Benchmark / Details / Remove.
function buildInstalledRow(m){
  const host=m.host||"nas";
  const online=m.hostOnline!==false;
  const row=document.createElement("div");
  row.className="model-row inst-row"+(m.name===selectedModel?" selected":"")+(!online?" offline":"");
  row.setAttribute("role","option"); row.tabIndex=online?0:-1; row.dataset.name=m.name;
  row.setAttribute("aria-selected", String(m.name===selectedModel));
  const main=document.createElement("div"); main.className="model-row-main";
  const name=document.createElement("span"); name.className="model-row-name"; name.textContent=m.name;
  main.appendChild(name);
  const badges=document.createElement("span"); badges.className="model-row-badges";
  badges.appendChild(hostBadge(host));
  if(m.benchmark && m.benchmark.tokPerSec>0){
    const b=document.createElement("span"); b.className="model-badge speed speed-fast";
    b.textContent=m.benchmark.tokPerSec.toFixed(0)+" t/s";
    b.title=`load ${m.benchmark.loadMs||0}ms · prompt ${(m.benchmark.promptTokPerSec||0).toFixed(1)} tok/s`;
    badges.appendChild(b);
  }
  for(const c of (m.capabilities||[])){ const cb=capBadge(c); if(cb) badges.appendChild(cb); }
  main.appendChild(badges);
  row.appendChild(main);
  const sub=document.createElement("div"); sub.className="model-row-sub";
  const d=m.details||{}; const bits=[d.parameter_size, d.quantization_level, d.family].filter(Boolean);
  if(m.sizeGB) bits.push(m.sizeGB.toFixed(1)+" GB");
  sub.textContent=bits.join(" · ") || (!online ? "offline" : "");
  row.appendChild(sub);
  const act=document.createElement("span"); act.className="model-row-actions";
  const chk=document.createElement("span"); chk.className="model-row-check"; chk.innerHTML=icon("check",14);
  act.appendChild(chk);
  const more=document.createElement("button"); more.type="button"; more.className="inst-more"; more.title="More"; more.setAttribute("aria-label","Model actions");
  more.innerHTML=icon("more",16);
  more.addEventListener("click",e=>{ e.stopPropagation(); openInstalledMenu(m, more, row); });
  act.appendChild(more);
  row.appendChild(act);
  if(online) row.addEventListener("click",e=>{ if(e.target.closest(".inst-more,.inst-confirm,.mcard-details")) return; chooseModel(m.name); });
  return row;
}
// A Local (this computer) model row: selectable only — we can't benchmark or
// remove the visitor's own Ollama models from here.
function buildLocalRow(m){
  const row=document.createElement("div");
  row.className="model-row local-row"+(m.name===selectedModel?" selected":"");
  row.setAttribute("role","option"); row.tabIndex=0; row.dataset.name=m.name;
  row.setAttribute("aria-selected", String(m.name===selectedModel));
  const main=document.createElement("div"); main.className="model-row-main";
  const name=document.createElement("span"); name.className="model-row-name"; name.textContent=m.name;
  main.appendChild(name);
  const badges=document.createElement("span"); badges.className="model-row-badges";
  badges.appendChild(hostBadge("local"));
  for(const c of (m.capabilities||[])){ const cb=capBadge(c); if(cb) badges.appendChild(cb); }
  main.appendChild(badges);
  row.appendChild(main);
  const sub=document.createElement("div"); sub.className="model-row-sub";
  const d=m.details||{}; const bits=[d.parameter_size, d.quantization_level, d.family].filter(Boolean);
  if(m.sizeGB) bits.push(m.sizeGB.toFixed(1)+" GB");
  sub.textContent=bits.join(" · ");
  row.appendChild(sub);
  const act=document.createElement("span"); act.className="model-row-actions";
  const chk=document.createElement("span"); chk.className="model-row-check"; chk.innerHTML=icon("check",14);
  act.appendChild(chk);
  row.appendChild(act);
  row.addEventListener("click",()=>chooseModel(m.name));
  return row;
}
// Per-row ⋯ menu for a server model: Benchmark, Details, Remove.
function openInstalledMenu(m, anchor, row){
  closeMenu();
  const menu=document.createElement("div"); menu.className="menu";
  const bench=menuButton("gauge","Benchmark");
  bench.addEventListener("click",e=>{ e.stopPropagation(); closeMenu(); benchmarkRow(m.name, row); });
  const det=menuButton("search","Details");
  det.addEventListener("click",e=>{ e.stopPropagation(); closeMenu(); toggleDetails(m.name, row); });
  const rm=menuButton("trash","Remove"); rm.classList.add("danger");
  rm.addEventListener("click",e=>{ e.stopPropagation(); closeMenu(); confirmRemoveRow(m.name, row); });
  const sep1=document.createElement("div"); sep1.className="sep";
  const sep2=document.createElement("div"); sep2.className="sep";
  if(m.hostOnline===false) bench.disabled=true;
  menu.appendChild(bench); menu.appendChild(sep1); menu.appendChild(det); menu.appendChild(sep2); menu.appendChild(rm);
  document.body.appendChild(menu);
  const r=anchor.getBoundingClientRect();
  menu.style.left=Math.min(r.left, window.innerWidth-menu.offsetWidth-8)+"px";
  menu.style.top=(r.bottom+4)+"px";
  openMenu=menu;
  setTimeout(()=>document.addEventListener("click",closeMenu),0);
}
// Run a benchmark and drop the result into the row's badge row as a tok/s badge
// (replacing any prior benchmark badge). Keeps the row compact.
function benchmarkRow(name, row){
  const badges=row.querySelector(".model-row-badges"); if(!badges) return;
  const old=badges.querySelector(".model-badge.speed"); if(old) old.remove();
  const slot=document.createElement("span"); slot.className="model-badge speed bench-pending"; slot.textContent="…";
  badges.appendChild(slot);
  fetchRetry("/api/models/"+encodeURIComponent(name)+"/benchmark",{method:"POST"},{label:"Benchmark"})
    .then(r=>r.json().catch(()=>({})))
    .then(j=>{ slot.remove();
      if(j && j.tokPerSec>0){
        const b=document.createElement("span"); b.className="model-badge speed speed-fast"; b.textContent=j.tokPerSec.toFixed(0)+" t/s";
        b.title=`load ${j.loadMs||0}ms · prompt ${(j.promptTokPerSec||0).toFixed(1)} tok/s`;
        badges.appendChild(b);
      } else {
        const b=document.createElement("span"); b.className="model-badge speed bench-fail"; b.textContent="n/a";
        b.title=(j&&j.error)||"Benchmark failed"; badges.appendChild(b);
      }
    })
    .catch(()=>{ slot.remove(); const b=document.createElement("span"); b.className="model-badge speed bench-fail"; b.textContent="n/a"; badges.appendChild(b); });
}
// Inline remove-confirm that expands under the row (replaces native confirm).
function confirmRemoveRow(name, row, err){
  let box=row.querySelector(".inst-confirm"); if(box) box.remove();
  box=document.createElement("div"); box.className="inst-confirm";
  const msg=document.createElement("span"); msg.className = err ? "rm-msg err-note" : "rm-msg muted";
  msg.textContent = err ? err : `Remove "${name}" from the NAS? This frees disk space.`;
  const cancel=document.createElement("button"); cancel.textContent="Cancel";
  cancel.addEventListener("click",e=>{ e.stopPropagation(); box.remove(); });
  const ok=document.createElement("button"); ok.className="danger"; ok.textContent="Remove";
  ok.addEventListener("click",e=>{ e.stopPropagation(); deleteRowModel(name, row); });
  box.appendChild(msg); box.appendChild(cancel); box.appendChild(ok);
  row.appendChild(box);
}
async function deleteRowModel(name, row){
  try{
    const r=await fetchRetry("/api/models/"+encodeURIComponent(name),{method:"DELETE"},{label:"Remove model"});
    if(r.status===404){ confirmRemoveRow(name, row, "Model not found."); return; }
    if(!r.ok && r.status!==204){ let j={}; try{j=await r.json()}catch{}; confirmRemoveRow(name, row, j.error||"Could not remove model"); return; }
    row.remove();
    await loadModels(); renderModels();
    if(modelsTab==="browse") await renderBrowseTab();
  }catch(e){ confirmRemoveRow(name, row, errText(e)); }
}
// Refresh one row's capability badges after its /info resolves (keeps the
// drawer's scroll/selection intact instead of a full re-render).
function refreshRowBadges(name){
  const row=document.querySelector('#tabBody .model-row[data-name="'+name+'"]');
  if(!row) return;
  const badges=row.querySelector(".model-row-badges"); if(!badges) return;
  const e=modelEntries.find(x=>x.name===name); if(!e) return;
  badges.replaceChildren();
  badges.appendChild(hostBadge(e.host));
  const sp=speedBadgeFor(e.tokPerSec); if(sp) badges.appendChild(sp);
  for(const c of modelCapsFor(name)){ const cb=capBadge(c); if(cb) badges.appendChild(cb); }
}
function renderModels(){
  // Trigger button: current model name + host badge + chevron.
  const cur=modelEntries.find(e=>e.name===selectedModel);
  modelBtn.replaceChildren();
  modelBtn.disabled=!modelEntries.length;
  const nameEl=document.createElement("span"); nameEl.className="model-btn-name";
  nameEl.textContent = cur ? cur.name : (modelEntries.length ? "Select model" : "No models");
  modelBtn.appendChild(nameEl);
  if(cur) modelBtn.appendChild(hostBadge(cur.host));
  const chev=document.createElement("span"); chev.className="model-chev"; chev.innerHTML=icon("chevron-down",14);
  modelBtn.appendChild(chev);
  modelBtn.setAttribute("aria-expanded", String($("modelsModal").classList.contains("open")));
  // Keep the drawer's banner in sync when models refresh while the panel is
  // open (e.g. after a pull or local re-probe). Row highlights are updated in
  // place by chooseModel/useModel, so no full re-render here (preserves scroll).
  if($("modelsModal").classList.contains("open")) renderModelBanner();
}
// Current-selection banner: pinned above the tab body, always visible across
// both tabs so the chosen model is obvious. Empty state nudges to pick/get more.
function renderModelBanner(){
  const b=modelBanner; if(!b) return;
  const cur=modelEntries.find(e=>e.name===selectedModel);
  b.replaceChildren();
  b.classList.toggle("empty", !cur);
  if(!cur){
    const t=document.createElement("div"); t.className="model-banner-title"; t.textContent="No model selected";
    const s=document.createElement("div"); s.className="model-banner-sub muted"; s.textContent="Pick one below, or get more models.";
    b.appendChild(t); b.appendChild(s); return;
  }
  const t=document.createElement("div"); t.className="model-banner-title";
  const nm=document.createElement("span"); nm.textContent=cur.name; t.appendChild(nm);
  const badges=document.createElement("span"); badges.className="model-row-badges";
  badges.appendChild(hostBadge(cur.host));
  for(const c of modelCapsFor(cur.name)){ const cb=capBadge(c); if(cb) badges.appendChild(cb); }
  t.appendChild(badges);
  b.appendChild(t);
  const s=document.createElement("div"); s.className="model-banner-sub muted"; s.textContent="Selected — click another model to switch.";
  b.appendChild(s);
}
// Update the installed rows' selected highlight in place (no full re-render, so
// scroll position is preserved when switching models).
function updateRowSelection(){
  document.querySelectorAll('#tabBody .model-row').forEach(r=>{
    const on=r.dataset.name===selectedModel;
    r.classList.toggle("selected", on);
    r.setAttribute("aria-selected", String(on));
  });
}
function chooseModel(name){
  selectedModel=name; localStorage.setItem("nas-llm-model", selectedModel);
  syncVision(); renderModels();
  enforceToolGating();
  // Persist the selection immediately so it survives a reload or chat switch
  // without a refresh. A model-only PATCH is safe even while a background job
  // is mid-generation: it touches just the model column, so the job's
  // appendAssistantMessage finalization (which writes messages) is unaffected.
  if(activeId) saveModelSelection();
  // Update the drawer in place (banner + row highlights) instead of closing a
  // popup, so the new choice stays visible and the user can keep managing.
  renderModelBanner();
  updateRowSelection();
}
// Persist just the selected model for the active conversation. Model-only (no
// messages) so it's safe to call during generation — see chooseModel. Refreshes
// the sidebar so a changed updated_at stays in sync.
async function saveModelSelection(){
  if(!activeId) return;
  try{
    await fetchRetry("/api/conversations/"+encodeURIComponent(activeId),{
      method:"PATCH",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({model:selectedModel})
    },{label:"Save model"});
    await loadConversations();
  }catch{}
}
// Background-fetch capabilities for every known model so the dropdown can badge
// vision/tools/thinking. Cached per session via capsChecked; re-renders each
// row's badges as its /info resolves. One at a time to be gentle on the N100.
function prefetchCaps(){
  const names=modelEntries.map(e=>e.name);
  let i=0;
  (function next(){
    if(i>=names.length) return;
    const n=names[i++];
    if(capsChecked.has(n)){ next(); return; }
    ensureCaps(n).then(()=>{ refreshRowBadges(n); if(n===selectedModel) renderComposer(); next(); });
  })();
}
modelBtn.addEventListener("click", e=>{ e.stopPropagation(); openModelsPanel("installed"); });
// Keyboard navigation across the installed list: ArrowUp/Down move focus,
// Enter/Space selects. Escape is handled by the modal-level listener.
document.addEventListener("keydown", e=>{
  if(!$("modelsModal").classList.contains("open") || modelsTab!=="installed") return;
  const body=$("tabBody"); if(!body) return;
  const rows=[...body.querySelectorAll(".model-row:not(.offline)")];
  if(!rows.length) return;
  if(e.key=="ArrowDown"||e.key=="ArrowUp"){
    e.preventDefault();
    const cur=body.querySelector(".model-row:focus");
    let idx=cur?rows.indexOf(cur):rows.findIndex(r=>r.classList.contains("selected"));
    if(idx<0) idx=0;
    idx=e.key=="ArrowDown"?Math.min(rows.length-1,idx+1):Math.max(0,idx-1);
    rows[idx].focus();
  } else if(e.key=="Enter"||e.key==" "){
    const cur=body.querySelector(".model-row:focus");
    if(cur){ e.preventDefault(); chooseModel(cur.dataset.name); }
  }
});

// --- Sidebar / conversations ------------------------------------------------
async function loadConversations(){
  try{
    const r=await fetch("/api/conversations");
    conversations=r.ok ? await r.json() : [];
  }catch{ conversations=[]; }
  await loadFolders();
  renderSidebar();
  updateHeader();
}
async function loadFolders(){
  try{
    const r=await fetchRetry("/api/folders",{},{label:"Load folders"});
    folders=r.ok ? await r.json() : [];
  }catch{ folders=[]; }
}
function saveCollapsed(){ localStorage.setItem("nas-llm-collapsed", JSON.stringify(collapsedFolders)); }
function renderSidebar(){
  convList.innerHTML="";
  // When the desktop repo sidebar is present (#dsSidebarRepos, injected by the
  // sidecar bridge), repo-bound chats are shown nested under their repo there —
  // so skip them here to avoid duplicating them in the flat folder list. On the
  // plain web UI (no repo sidebar) every chat stays in the folder list.
  const hasRepoSidebar=!!document.getElementById("dsSidebarRepos");
  const visible=hasRepoSidebar?conversations.filter(c=>!c.repoId):conversations;
  const byFolder={};
  visible.forEach(c=>{ const key=c.folderId||""; (byFolder[key]=byFolder[key]||[]).push(c); });
  folders.forEach(f=>{ convList.appendChild(renderFolder(f, byFolder[f.id]||[])); delete byFolder[f.id]; });
  if(byFolder[""]) convList.appendChild(renderFolder(null, byFolder[""]));
}
function makeFolderDropTarget(el, folderId){
  el.addEventListener("dragover",e=>{ e.preventDefault(); try{e.dataTransfer.dropEffect="move";}catch{} el.classList.add("drag-over"); });
  el.addEventListener("dragleave",e=>{ if(!el.contains(e.relatedTarget)) el.classList.remove("drag-over"); });
  el.addEventListener("drop",e=>{ e.preventDefault(); el.classList.remove("drag-over"); if(dragConv) moveConversation(dragConv, folderId); dragConv=null; });
}
function renderFolder(f, convs){
  const wrap=document.createElement("div"); wrap.className="folder"+(f&&collapsedFolders[f.id]?" collapsed":"");
  const head=document.createElement("div"); head.className="folder-head";
  const chev=document.createElement("span"); chev.className="folder-chev";
  chev.innerHTML = f ? icon(collapsedFolders[f.id]?"chevron-right":"chevron-down", 14) : "";
  const name=document.createElement("div"); name.className="folder-name";
  if(f){
    name.id="fn-"+f.id;
    name.textContent=f.name;
    head.appendChild(chev); head.appendChild(name);
    const more=document.createElement("button"); more.className="folder-act"; more.title="More"; more.draggable=false;
    more.innerHTML = icon("more", 16);
    more.addEventListener("click",e=>{ e.stopPropagation(); openFolderMenu(f, more, name); });
    head.appendChild(more);
    head.addEventListener("click",e=>{ if(e.target.closest("input")) return; collapsedFolders[f.id]=!collapsedFolders[f.id]; saveCollapsed(); renderSidebar(); });
    makeFolderDropTarget(head, f.id);
  } else {
    chev.style.visibility="hidden";
    name.textContent="Unsorted";
    head.appendChild(chev); head.appendChild(name);
    makeFolderDropTarget(head, "");
  }
  wrap.appendChild(head);
  const body=document.createElement("div"); body.className="folder-body";
  convs.forEach(c=>body.appendChild(renderConv(c)));
  wrap.appendChild(body);
  return wrap;
}
function renderConv(c){
  const row=document.createElement("div"); row.className="conv"+(c.id===activeId?" active":"")+(generatingIds.has(c.id)?" generating":"")+(finishedIds.has(c.id)?" finished":""); row.draggable=true;
  const main=document.createElement("div"); main.className="conv-main";
  const t=document.createElement("div"); t.className="conv-title"; t.id="ct-"+c.id; t.textContent=c.title||"New chat";
  const tm=document.createElement("div"); tm.className="conv-time"; tm.textContent=absTime(c.updatedAt); tm.title=relTime(c.updatedAt);
  main.appendChild(t); main.appendChild(tm);
  row.appendChild(main);
  const more=document.createElement("button"); more.className="conv-act"; more.title="More"; more.draggable=false;
  more.innerHTML = icon("more", 16);
  more.addEventListener("click",e=>{ e.stopPropagation(); openConvMenu(c, more); });
  row.appendChild(more);
  row.addEventListener("dragstart",e=>{ dragConv=c; row.classList.add("dragging"); try{e.dataTransfer.effectAllowed="move";e.dataTransfer.setData("text/plain",c.id);}catch{} });
  row.addEventListener("dragend",()=>{ row.classList.remove("dragging"); dragConv=null; });
  row.addEventListener("click",e=>{ if(e.target.closest("input")) return; openConversation(c.id); closeSidebar(); });
  return row;
}
// --- Row action menu (rename / move / delete) ---
function closeMenu(){ if(openMenu){ openMenu.remove(); openMenu=null; document.removeEventListener("click",closeMenu); } }
function menuButton(iconName, label){
  const b=document.createElement("button");
  b.innerHTML = icon(iconName, 15) + '<span>'+escapeHtml(label)+'</span>';
  return b;
}
// Morph the open action menu into an inline yes/no confirm (replaces native
// confirm(), which the browser can block via "prevent additional dialogs").
function confirmInMenu(m, message, sub, onConfirm){
  m.replaceChildren();
  const msg=document.createElement("div"); msg.className="menu-msg"; msg.textContent=message; m.appendChild(msg);
  if(sub){ const s=document.createElement("div"); s.className="menu-sub muted"; s.textContent=sub; m.appendChild(s); }
  const sep=document.createElement("div"); sep.className="sep"; m.appendChild(sep);
  const cancel=document.createElement("button"); cancel.textContent="Cancel";
  cancel.addEventListener("click",e=>{ e.stopPropagation(); closeMenu(); });
  const ok=document.createElement("button"); ok.className="danger"; ok.textContent="Delete";
  ok.addEventListener("click",e=>{ e.stopPropagation(); closeMenu(); onConfirm(); });
  m.appendChild(cancel); m.appendChild(ok);
  const left=parseFloat(m.style.left)||0;                 // re-clip if the confirm is wider than the menu was
  m.style.left=Math.min(left, window.innerWidth-m.offsetWidth-8)+"px";
}
function openConvMenu(c, anchor){
  closeMenu();
  const m=document.createElement("div"); m.className="menu";
  const rename=menuButton("rename","Rename");
  rename.addEventListener("click",e=>{ e.stopPropagation(); closeMenu(); startConvRename(c); });
  const move=document.createElement("div"); move.className="sub";
  const moveLabel=document.createElement("button"); moveLabel.className="label";
  moveLabel.innerHTML = '<span>Move to</span>' + icon("chevron-right", 14);
  const panel=document.createElement("div"); panel.className="panel";
  const unsort=document.createElement("button"); unsort.textContent="Unsorted";
  unsort.addEventListener("click",e=>{ e.stopPropagation(); closeMenu(); moveConversation(c, ""); });
  panel.appendChild(unsort);
  folders.forEach(f=>{ const b=document.createElement("button"); b.textContent=f.name; b.addEventListener("click",e=>{ e.stopPropagation(); closeMenu(); moveConversation(c, f.id); }); panel.appendChild(b); });
  move.appendChild(moveLabel); move.appendChild(panel);
  const del=menuButton("trash","Delete");
  del.addEventListener("click",e=>{ e.stopPropagation(); confirmInMenu(m, "Delete this conversation?", null, ()=>deleteConversation(c.id)); });
  const sep1=document.createElement("div"); sep1.className="sep";
  const sep2=document.createElement("div"); sep2.className="sep";
  m.appendChild(rename); m.appendChild(sep1); m.appendChild(move); m.appendChild(sep2); m.appendChild(del);
  document.body.appendChild(m);
  const r=anchor.getBoundingClientRect();
  m.style.left=Math.min(r.left, window.innerWidth-m.offsetWidth-8)+"px";
  m.style.top=(r.bottom+4)+"px";
  openMenu=m;
  setTimeout(()=>document.addEventListener("click",closeMenu),0);
}
function openFolderMenu(f, anchor, name){
  closeMenu();
  const m=document.createElement("div"); m.className="menu";
  const rename=menuButton("rename","Rename");
  rename.addEventListener("click",e=>{ e.stopPropagation(); closeMenu(); startFolderRename(f, name); });
  const sep=document.createElement("div"); sep.className="sep";
  const del=menuButton("trash","Delete");
  del.addEventListener("click",e=>{ e.stopPropagation(); confirmInMenu(m, 'Delete folder "'+f.name+'"?', "Its chats move to Unsorted (not deleted).", ()=>deleteFolder(f.id)); });
  m.appendChild(rename); m.appendChild(sep); m.appendChild(del);
  document.body.appendChild(m);
  const r=anchor.getBoundingClientRect();
  m.style.left=Math.min(r.left, window.innerWidth-m.offsetWidth-8)+"px";
  m.style.top=(r.bottom+4)+"px";
  openMenu=m;
  setTimeout(()=>document.addEventListener("click",closeMenu),0);
}
async function moveConversation(c, folderId){
  if((c.folderId||"")===(folderId||"")) return;
  try{
    const r=await fetchRetry("/api/conversations/"+encodeURIComponent(c.id),{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({folderId})},{label:"Move chat"});
    if(!r.ok) return;
    await loadConversations();
  }catch{}
}
function startConvRename(c){
  const cell=$("ct-"+c.id); if(!cell) return;
  const row=cell.closest(".conv"); if(row) row.draggable=false;   // don't start a drag while renaming
  cell.innerHTML="";
  const inp=document.createElement("input"); inp.value=c.title||""; inp.maxLength=80;
  inp.addEventListener("click",e=>e.stopPropagation());
  inp.addEventListener("mousedown",e=>e.stopPropagation());
  cell.appendChild(inp); inp.focus(); inp.select();
  let done=false;
  const commit=async ()=>{ if(done) return; done=true;
    const v=inp.value.trim(); if(!v||v===(c.title||"")){ renderSidebar(); return; }
    try{ await fetchRetry("/api/conversations/"+encodeURIComponent(c.id),{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({title:v})},{label:"Rename chat"}); }catch{}
    await loadConversations();
  };
  const cancel=()=>{ done=true; renderSidebar(); };
  inp.addEventListener("keydown",e=>{ if(e.key==="Enter"){ e.preventDefault(); commit(); } else if(e.key==="Escape"){ e.preventDefault(); cancel(); } });
  inp.addEventListener("blur",commit);
}
// --- Folder CRUD ---
async function createFolder(){
  let f;
  try{
    const r=await fetchRetry("/api/folders",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:"New folder"})},{label:"Create folder"});
    if(!r.ok) return;
    f=await r.json();
  }catch{ return; }
  if(!f||!f.id) return;
  await loadConversations();                 // show the new folder in the tree...
  const cell=$("fn-"+f.id); if(cell) startFolderRename(f, cell, true);  // ...then rename it inline
}
async function deleteFolder(id){
  try{ await fetchRetry("/api/folders/"+encodeURIComponent(id),{method:"DELETE"},{label:"Delete folder"}); }catch{}
  await loadConversations();
}
function startFolderRename(f, cell, isNew){
  cell.innerHTML="";
  const inp=document.createElement("input"); inp.value=f.name; inp.maxLength=80;
  inp.addEventListener("click",e=>e.stopPropagation());
  inp.addEventListener("mousedown",e=>e.stopPropagation());
  cell.appendChild(inp); inp.focus(); inp.select();
  let done=false;
  const removeNew=async ()=>{ try{ await fetchRetry("/api/folders/"+encodeURIComponent(f.id),{method:"DELETE"},{label:"Delete folder"}); }catch{} await loadConversations(); };
  const commit=async ()=>{ if(done) return; done=true;
    const v=inp.value.trim();
    if(isNew && !v){ await removeNew(); return; }      // cleared the new folder's name -> discard it
    if(!v || v===f.name){ renderSidebar(); return; }   // unchanged -> keep
    try{ await fetchRetry("/api/folders/"+encodeURIComponent(f.id),{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:v})},{label:"Rename folder"}); }catch{}
    await loadConversations();
  };
  const cancel=()=>{ done=true; if(isNew) removeNew(); else renderSidebar(); };
  inp.addEventListener("keydown",e=>{ if(e.key==="Enter"){ e.preventDefault(); commit(); } else if(e.key==="Escape"){ e.preventDefault(); cancel(); } });
  inp.addEventListener("blur",commit);
}
async function openConversation(id){
  // Closing the old tail does NOT stop generation — it runs detached on the
  // NAS. We just stop listening; if this conversation has an active job we
  // reopen the tail below and resume live.
  closeTail();
  activeJobConvId=null; renderSend();
  pendingImages=[]; renderImgPills();
  finishedIds.delete(id); // the user is looking at it now — clear its badge
  try{
    const r=await fetch("/api/conversations/" + encodeURIComponent(id));
    if(!r.ok) return;
    const c=await r.json();
    activeId=c.id; messages=c.messages||[];
    histIndex=inputHistory.length; draft="";
    if(models.includes(c.model)) selectedModel=c.model;
    syncVision();
    renderModels();
    rerenderChat();
    renderSidebar();
    updateHeader();
  }catch{}
  await resumeIfGenerating(id);
}

// --- Desktop bridge hook: no-reload chat navigation ---
// desktop.js dispatches `nasllm:openConv` (detail = conversation id) to open a
// chat without a full location.reload(), routed through openConversation so
// the normal state/sidebar/header updates all run.
window.addEventListener("nasllm:openConv", (e) => {
  const id = e && e.detail ? String(e.detail) : "";
  if (id) openConversation(id);
});
// Desktop bridge hook: refresh the conversation list after a desktop-side
// change (e.g. deleting a repo chat from the repo dropdown) so the flat list
// stays in sync without a full reload.
window.addEventListener("nasllm:refreshConvs", () => { loadConversations(); });

// --- Background generation ---

// Load the set of conversations with active jobs (for sidebar indicators).
async function loadActiveJobs(){
  try{
    const r=await fetch("/api/jobs/active");
    if(!r.ok) return;
    const map=await r.json();
    generatingIds=new Set(Object.keys(map||{}));
  }catch{}
}
// Reconcile generatingIds with the server and re-render the sidebar if it
// changed. Called on a 5s interval so a job that finished on a chat the user
// isn't viewing drops its spinner.
async function syncGenerating(){
  const before=new Set(generatingIds);
  await loadActiveJobs();
  const same=before.size===generatingIds.size && [...before].every(x=>generatingIds.has(x));
  if(!same) renderSidebar();
}

// Closing the foreground tail only detaches the EventSource — it must NOT
// abort any in-flight local-model relay (localAborts). That was the original
// bug: switching chats aborted the OTHER chat's still-running localhost
// inference because both shared one activeLocalAbort singleton. A relay's
// fetch is independent of the tail's EventSource, so it keeps streaming after
// this closes; the global stream (openGlobalStream) picks up any further
// modelCall rounds for that job once nothing is listening on its own tail.
function closeTail(){ if(activeES){ activeES.close(); activeES=null; } }

// If the conversation has an active background job, render its partial content
// and reopen the SSE tail so switching back resumes live.
async function resumeIfGenerating(id){
  let job;
  try{
    const r=await fetch("/api/conversations/" + encodeURIComponent(id) + "/job");
    if(r.status===204 || !r.ok){
      if(generatingIds.has(id)){ generatingIds.delete(id); renderSidebar(); }
      return;
    }
    job=await r.json();
  }catch{ return; }
  if(job.status!=="queued" && job.status!=="generating"){
    if(generatingIds.has(id)){ generatingIds.delete(id); renderSidebar(); }
    return;
  }
  generatingIds.add(id); renderSidebar();
  activeJobConvId=id; renderSend();
  const hasQ = !!(job.questions && job.questions.questions && job.questions.questions.length);
  const {bubble, searchWrap, srcLinks, stepsWrap, thoughtsWrap, thoughtsDet}=addMsg("assistant", hasQ ? "" : (job.content||""), job.createdAt||Date.now(), job.searches||null, null, job.questions||null, false, job.steps||null, job.thoughts||null);
  // A generating job with no reasoning yet collapses the empty drawer; one with
  // reasoning stays open and tailJob sets the streaming summary/elapsed timer.
  if(thoughtsDet && (!job.thoughts || !job.thoughts.length)) thoughtsDet.open = false;
  tailJob(id, job.id, bubble, hasQ ? "" : (job.content||""), searchWrap, srcLinks, job.questions||null, stepsWrap, job.steps||null, thoughtsWrap, thoughtsDet, job.thoughts||null);
}

// --- Local-model relay (browser -> visitor's Ollama, results back to NAS) ---
// On a `modelCall` SSE event the backend hands the browser the OpenAI
// chat-completions payload it would have sent to a server Ollama. The browser
// streams it to the visitor's localhost Ollama, paints content into the answer
// bubble via the same StreamRenderer as server-model chunks, then POSTs the
// assembled {content, tool_calls} back so the backend can continue the tool
// loop (web_search/clarify/agent) or finalize. `tools` is null for plain chat.
// The localhost:11434 fetch threw before any HTTP response. The common cause
// is Ollama 403'ing the cross-origin request because OLLAMA_ORIGINS isn't set:
// the browser hides that 403 behind an opaque TypeError, so we never reach the
// r.status===403 branch above. Lead with the OLLAMA_ORIGINS fix (the page's own
// origin) and append the raw error when we have it. `detail` is e.message.
function localFetchErrMsg(detail){
  const origin = location.origin || "*";
  const lead = "Could not reach Ollama on this computer. If it's running, restart it with OLLAMA_ORIGINS=" + origin + " (or OLLAMA_ORIGINS=*); check DevTools → Console if that doesn't resolve it.";
  return detail ? lead + " (" + detail + ")" : lead;
}
function localStatusErrMsg(status){
  if(status===403) return "Your local Ollama rejected the request — start it with OLLAMA_ORIGINS=https://chat.selected.systems ollama serve (or OLLAMA_ORIGINS=*).";
  return "Local Ollama returned HTTP "+status+".";
}
async function postModelResponse(convId, jobId, content, toolCalls, error){
  try{
    const payload = error ? { jobId, error } : { jobId, content, tool_calls: toolCalls||null };
    await fetch("/api/conversations/"+encodeURIComponent(convId)+"/model-response",{
      method:"POST", headers:{"Content-Type":"application/json"},
      body:JSON.stringify(payload)
    });
  }catch{}
}
// Drive one local-model inference round. Streams content into the renderer as
// it arrives (the bubble updates live), assembles fragmented tool_calls by
// index, and returns {content, toolCalls}. On a fetch/HTTP failure it shows
// the contract error message in the bubble via bubbleError and POSTs
// {jobId, error} so the backend finalizes the connection-bound job as an
// error (the message survives the done/reload) instead of an empty success;
// returns null.
// renderer/bubble are optional: a background chat the user isn't watching has
// no StreamRenderer or bubble to paint into (relayModelCallHeadless passes
// null for both), so content is still assembled and returned/posted, but
// nothing is rendered live and a failure surfaces as a toast instead of
// bubbleError (which would throw on a null bubble).
async function relayLocalModelCall(convId, call, renderer, bubble, signal){
  const body={ model:call.model, messages:call.messages, stream:true };
  if(call.tools && call.tools.length) body.tools=call.tools;
  const reportErr=(msg)=>{ if(bubble) bubbleError(bubble, msg); else showToast(msg, "err"); };
  let resp;
  // text/plain (not application/json) to keep this a CORS "simple request" with
  // no preflight — same Private Network Access dodge as startLocalPull. Ollama's
  // /v1/chat/completions decodes the JSON body regardless of Content-Type.
  try{ resp=await fetch("http://localhost:11434/v1/chat/completions",{ method:"POST", headers:{"Content-Type":"text/plain"}, body:JSON.stringify(body), signal }); }
  catch(e){ if(signal.aborted) return null; const msg=localFetchErrMsg(String(e&&e.message||e)); reportErr(msg); postModelResponse(convId, call.jobId, null, null, msg); return null; }
  if(!resp.ok){ const msg=localStatusErrMsg(resp.status); reportErr(msg); postModelResponse(convId, call.jobId, null, null, msg); return null; }
  let content=""; const calls=[];
  const reader=resp.body.getReader(); const dec=new TextDecoder(); let buf=""; let finished=false;
  try{
    while(!finished){
      const {done, value}=await reader.read();
      if(done) break;
      buf+=dec.decode(value,{stream:true});
      let idx;
      while((idx=buf.indexOf("\n"))>=0){
        const line=buf.slice(0,idx).trim(); buf=buf.slice(idx+1);
        if(!line.startsWith("data:")) continue;
        const data=line.slice(5).trim();
        if(data==="[DONE]"){ finished=true; break; }
        let j; try{ j=JSON.parse(data); }catch{ continue; }
        const delta=j.choices && j.choices[0] && j.choices[0].delta;
        if(!delta) continue;
        if(delta.content){ content+=delta.content; if(renderer) renderer.append(delta.content); }
        if(delta.tool_calls){
          // Accumulate by id-presence (mirrors the backend streamOllamaChatWithTools):
          // a delta carrying a new id starts a new call; one with no id continues
          // the last call. Ollama emits index:0 for every call, so index-based
          // merging would concatenate unrelated calls — key on id instead.
          for(const tc of delta.tool_calls){
            if(tc.id){
              calls.push({id:tc.id, type:tc.type||"function", function:{name:tc.function?.name||"", arguments:tc.function?.arguments||""}});
            } else if(calls.length){
              const c=calls[calls.length-1];
              if(tc.type) c.type=tc.type;
              if(tc.function){ if(tc.function.name) c.function.name+=tc.function.name; if(tc.function.arguments) c.function.arguments+=tc.function.arguments; }
            }
          }
        }
      }
    }
  }catch(e){
    // Intentional abort (Stop / done / closeTail): bail without posting — the
    // backend's connection-bound job is finalized by the SSE done/cancel path.
    if(signal.aborted) return null;
    // Mid-stream network drop: fall through and return whatever streamed so
    // far so the backend gets partial content instead of hanging.
  }
  const toolCalls=calls.length?calls:null;
  return { content, toolCalls };
}

// --- Toasts (background job completions / headless relay failures) --------
// Unlike slashNote (one message at a time, for command feedback), toasts stack
// since multiple background chats can finish or error around the same time.
// Clicking a toast (when a handler is given) jumps to that chat.
function showToast(text, cls, onClick){
  let wrap=document.getElementById("toasts");
  if(!wrap){ wrap=document.createElement("div"); wrap.id="toasts"; document.body.appendChild(wrap); }
  const t=document.createElement("div"); t.className="toast"+(cls?" "+cls:"")+(onClick?" clickable":"");
  t.textContent=String(text||"");
  if(onClick) t.addEventListener("click",onClick);
  wrap.appendChild(t);
  requestAnimationFrame(()=>t.classList.add("show"));
  setTimeout(()=>{ t.classList.remove("show"); setTimeout(()=>t.remove(),200); }, 6000);
}
function toastText(status, title, error){
  if(status==="error") return title+" \u2014 "+(error||"generation failed");
  if(status==="cancelled") return title+" stopped";
  return title+" finished";
}
// Central terminal-event handler for BOTH the foreground tail and the global
// stream (contract 4): dispatches nasllm:jobDone unconditionally, then
// suppresses the in-app toast/badge for the chat the user is currently
// viewing ("they can already see it"). Deduped by jobId since the same
// terminal event can legitimately arrive on both streams — see
// openGlobalStream's modelCall/done/joberror handlers.
function finishJob(convId, jobId, status, error){
  if(jobId){
    if(notifiedJobIds.has(jobId)) return;
    notifiedJobIds.add(jobId);
    if(notifiedJobIds.size>500) notifiedJobIds.delete(notifiedJobIds.values().next().value); // bounded
  }
  generatingIds.delete(convId);
  const conv=conversations.find(c=>c.id===convId);
  const title=(conv&&conv.title)||"Chat";
  window.dispatchEvent(new CustomEvent("nasllm:jobDone",{detail:{convId, title, status, error:error||null}}));
  if(convId!==activeId){
    finishedIds.add(convId);
    showToast(toastText(status, title, error), status==="error"?"err":"", ()=>{ openConversation(convId); closeSidebar(); });
  }
  renderSidebar();
}
// Refresh the open chat's messages from the server when a terminal event for
// it arrives on a path other than its own foreground tail (e.g. the global
// stream saw it finish before resumeIfGenerating's tail attached).
async function reloadIfOpen(convId){
  if(convId!==activeId) return;
  try{
    const r=await fetch("/api/conversations/"+encodeURIComponent(convId));
    if(r.ok){ const c=await r.json(); messages=c.messages||[]; rerenderChat(); updateHeader(); }
  }catch{}
}

// Run one local-model round with no renderer/bubble (relayLocalModelCall
// already tolerates both being null), tracking the abort controller in
// localAborts by convId so a later Stop/leave can target just this round.
async function relayModelCallHeadless(convId, call){
  const ctrl=new AbortController(); localAborts.set(convId, ctrl);
  try{
    const res=await relayLocalModelCall(convId, call, null, null, ctrl.signal);
    if(res===null) return; // fetch failed or aborted: error already posted / nothing to post
    await postModelResponse(convId, call.jobId, res.content, res.toolCalls);
  }catch(err){
    if(ctrl.signal.aborted) return;
    const msg=localFetchErrMsg(String(err&&err.message||err));
    showToast(msg, "err");
    postModelResponse(convId, call.jobId, null, null, msg);
  }finally{
    if(localAborts.get(convId)===ctrl) localAborts.delete(convId);
  }
}

// --- Global job stream (drives chats the user isn't looking at) -----------
// GET /api/events is a user-scoped, multiplexed SSE stream carrying modelCall/
// toolExec/phase/done/joberror for EVERY active job the caller owns, each
// payload tagged with convId+jobId (contract 1). We open it once after auth
// and use it only to (a) keep a backgrounded local-model relay running and
// (b) fire completion toasts/badges for jobs finishing off-screen. toolExec is
// intentionally not handled here — it belongs exclusively to the desktop
// renderer's EventSource shim (contract 5), which wraps window.EventSource and
// therefore already receives this same stream. If the route is missing (older
// backend) or the connection keeps failing, back off and keep retrying: the
// rest of the app already works with no background progress/notifications.
let globalES=null;
let globalRetryDelay=1000;
let globalRetryTimer=null;
const GLOBAL_RETRY_MAX=30000;
function openGlobalStream(){
  if(globalES || globalRetryTimer) return;
  const es=new EventSource("/api/events");
  globalES=es;
  let openedOnce=false;
  es.addEventListener("open", ()=>{ openedOnce=true; globalRetryDelay=1000; });
  es.addEventListener("modelCall", e=>{
    let d={}; try{ d=JSON.parse(e.data); }catch{ return; }
    if(!d.convId || !d.jobId || !d.model) return;
    if(d.convId===activeJobConvId) return;    // the foreground tail already owns this round
    if(localAborts.has(d.convId)) return;     // a relay for this conversation is already in flight
    relayModelCallHeadless(d.convId, d);
  });
  es.addEventListener("done", e=>{
    let d={}; try{ d=JSON.parse(e.data); }catch{ d={}; }
    if(!d.convId) return;
    if(d.convId===activeJobConvId) return;    // tailJob's own "done" handler already covers this
    finishJob(d.convId, d.jobId, d.status==="cancelled"?"cancelled":"done", null);
    reloadIfOpen(d.convId);
    loadConversations();
  });
  es.addEventListener("joberror", e=>{
    let d={}; try{ d=JSON.parse(e.data); }catch{ d={}; }
    if(!d.convId) return;
    if(d.convId===activeJobConvId) return;    // tailJob's own "joberror" handler already covers this
    finishJob(d.convId, d.jobId, "error", d.error||null);
    reloadIfOpen(d.convId);
    loadConversations();
  });
  es.onerror=()=>{
    es.close();
    if(globalES===es) globalES=null;
    // Never got a working connection (older backend without this route, or a
    // network drop) — back off exponentially instead of hammering it; a
    // native EventSource's default retry is a fixed ~3s, which is too eager
    // for a route that may simply not exist yet.
    const delay=globalRetryDelay;
    globalRetryDelay=Math.min(GLOBAL_RETRY_MAX, globalRetryDelay*2);
    globalRetryTimer=setTimeout(()=>{ globalRetryTimer=null; openGlobalStream(); }, delay);
  };
}
function closeGlobalStream(){
  if(globalRetryTimer){ clearTimeout(globalRetryTimer); globalRetryTimer=null; }
  if(globalES){ globalES.close(); globalES=null; }
  globalRetryDelay=1000;
}

// tailJob opens an EventSource to /events and renders into bubble via a
// StreamRenderer (one markdown re-parse per animation frame). On reconnect the
// server sends a "reset" with the full prefix, which re-anchors acc so
// reconnects never double-count. A "questions" event (agent loop) swaps the
// bubble to a clickable option card and suspends the renderer so a queued
// flush can't wipe it. "done" reloads the conversation from the server
// (source of truth — the assistant reply is persisted there).
function tailJob(convId, jobId, bubble, initialAcc, searchWrap, srcLinks, initialClarify, stepsWrap, initialSteps, thoughtsWrap, thoughtsDet, initialThoughts){
  closeTail();
  const renderer = new StreamRenderer(bubble);
  const onAnswer=(value)=>sendClarifyAnswer(value, bubble);
  if(initialClarify){
    // Reattaching to a job that already reached a clarifying question: paint
    // the card now and freeze the renderer so a queued flush can't wipe it.
    renderer.suspend();
    renderClarifyCard(bubble, initialClarify, false, onAnswer, null);
  } else {
    renderer.set(initialAcc);
  }
  if(initialSteps && stepsWrap) renderAgentSteps(stepsWrap, initialSteps);
  let thoughtStart=null;
  if(initialThoughts && initialThoughts.length && thoughtsWrap){
    // Reattaching to a generating job that already has reasoning: show it open
    // with the streaming summary and start the elapsed timer from now.
    renderThoughts(thoughtsWrap, initialThoughts);
    thoughtStart=Date.now();
    setThoughtsSummary(thoughtsDet, "Thinking", {streaming:true});
    if(thoughtsDet) thoughtsDet.open=true;
  }
  let esClosed=false;
  activeJobConvId=convId;
  const es=new EventSource("/api/conversations/"+encodeURIComponent(convId)+"/events");
  activeES=es;
  es.addEventListener("reset", e=>{ let acc=""; try{ acc=JSON.parse(e.data); }catch{} renderer.set(acc); });
  es.addEventListener("searches", e=>{ let arr=[]; try{ arr=JSON.parse(e.data)||[]; }catch{} renderSearchBlock(searchWrap, arr); renderSourceLinks(srcLinks, arr); });
  es.addEventListener("search", e=>{ let entry=null; try{ entry=JSON.parse(e.data); }catch{} appendSearchEntry(searchWrap, entry); appendSourceLinks(srcLinks, entry); });
  es.addEventListener("questions", e=>{ let q=null; try{ q=JSON.parse(e.data); }catch{} renderer.suspend(); renderClarifyCard(bubble, q, false, onAnswer, null); });
  es.addEventListener("steps", e=>{ let arr=[]; try{ arr=JSON.parse(e.data)||[]; }catch{} renderAgentSteps(stepsWrap, arr); });
  es.addEventListener("tool", e=>{ let st=null; try{ st=JSON.parse(e.data); }catch{} appendAgentStep(stepsWrap, st); });
  es.addEventListener("thoughts", e=>{ let arr=[]; try{ arr=JSON.parse(e.data)||[]; }catch{} renderThoughts(thoughtsWrap, arr); if(arr&&arr.length){ if(!thoughtStart) thoughtStart=Date.now(); setThoughtsSummary(thoughtsDet,"Thinking",{streaming:true}); if(thoughtsDet) thoughtsDet.open=true; } });
  es.addEventListener("thought", e=>{ let t=""; try{ t=JSON.parse(e.data); }catch{} appendThought(thoughtsWrap, t); if(t!=null&&t!==""){ if(!thoughtStart) thoughtStart=Date.now(); setThoughtsSummary(thoughtsDet,"Thinking",{streaming:true}); if(thoughtsDet) thoughtsDet.open=true; } });
  es.addEventListener("clear", ()=>{ renderer.set(""); });
  // Local-model relay: the backend needs the visitor's Ollama to infer. Stream
  // the response into the bubble as it arrives, then POST the assembled result
  // back. The existing thoughts/clear handlers tolerate this ordering (a
  // thinking round's content streams first, then thoughts + clear arrive and
  // move the text to the thinking drawer / wipe the bubble).
  es.addEventListener("modelCall", async e=>{
    let d={}; try{ d=JSON.parse(e.data); }catch{ return; }
    if(!d.jobId || !d.model) return;
    const ctrl=new AbortController(); localAborts.set(convId, ctrl);
    try{
      const res=await relayLocalModelCall(convId, d, renderer, bubble, ctrl.signal);
      if(res===null) return;                  // fetch failed or aborted: error shown / nothing to post
      await postModelResponse(convId, d.jobId, res.content, res.toolCalls);
    }catch(err){
      // Unexpected throw relayLocalModelCall didn't handle: finalize as an
      // error so the backend's connection-bound job doesn't hang.
      if(ctrl.signal.aborted) return;
      const msg=localFetchErrMsg(String(err&&err.message||err));
      bubbleError(bubble, msg);
      postModelResponse(convId, d.jobId, null, null, msg);
    }finally{
      if(localAborts.get(convId)===ctrl) localAborts.delete(convId);
    }
  });
  es.addEventListener("phase", e=>{
    const p=e.data;
    renderer.setPhase(p);
    if(p==="searching") showSearchPending(searchWrap, null);
    else if(p.startsWith("searching:")) showSearchPending(searchWrap, p.slice(10).trim());
    else if(p==="answering") clearSearchPending(searchWrap);
  });
  es.addEventListener("chunk", e=>{ let d=""; try{ d=JSON.parse(e.data); }catch{} renderer.append(d); });
  es.addEventListener("done", ()=>{
    esClosed=true; es.close(); if(activeES===es) activeES=null;
    const ctrl=localAborts.get(convId); if(ctrl){ ctrl.abort(); localAborts.delete(convId); }
    if(thoughtsDet){ if(thoughtStart){ const secs=((Date.now()-thoughtStart)/1000).toFixed(1); setThoughtsSummary(thoughtsDet,"Thought for "+secs+"s",{streaming:false}); } else setThoughtsSummary(thoughtsDet,"Thinking",{streaming:false}); thoughtsDet.open=false; }
    // The per-conversation "done" event carries no payload, so a user-requested
    // stop is distinguished via stoppedByUser (set by stopActive) rather than
    // anything on this event.
    const status = stoppedByUser.has(convId) ? "cancelled" : "done";
    stoppedByUser.delete(convId);
    finishJob(convId, jobId, status, null);
    onGenerationDone(convId);
  });
  es.addEventListener("joberror", e=>{
    esClosed=true; es.close(); if(activeES===es) activeES=null;
    const ctrl=localAborts.get(convId); if(ctrl){ ctrl.abort(); localAborts.delete(convId); }
    let msg=e.data; try{ msg=JSON.parse(e.data); }catch{}
    const acc = renderer.acc;
    if(acc) renderer.finalize(acc);
    else bubbleError(bubble, msg);
    if(thoughtsDet){ setThoughtsSummary(thoughtsDet,"Thinking",{streaming:false}); thoughtsDet.open=false; } // collapse thinking on terminal
    stoppedByUser.delete(convId);
    finishJob(convId, jobId, "error", msg);
    activeJobConvId=null; renderSend(); input.focus();
  });
  es.onerror=()=>{ if(esClosed) return; /* transport drop: EventSource auto-reconnects; reset re-anchors acc */ };
}

async function onGenerationDone(convId){
  // generatingIds/sidebar/badge/toast/CustomEvent are already handled by
  // finishJob, called just before this from tailJob's "done" handler.
  if(activeJobConvId===convId) activeJobConvId=null;
  if(convId===activeId){
    renderSend();
    // Reload from the server: the assistant reply is persisted there now.
    await reloadIfOpen(convId);
  }
  await loadConversations();
  // If the user clicked a clarifying option while the question was still
  // finalizing, send it now that the turn is done and the card is reloaded.
  if(convId===activeId && pendingClarifyAnswer){
    const v=pendingClarifyAnswer; pendingClarifyAnswer=null;
    input.value=v; stream(); return;
  }
  input.focus();
}
function newChat(){
  closeTail(); activeJobConvId=null; renderSend();
  activeId=null; messages=[]; chat.innerHTML=""; histIndex=inputHistory.length; draft="";
  pendingImages=[]; renderImgPills();
  renderSidebar(); updateHeader(); input.focus();
}
async function deleteConversation(id){
  try{ await fetch("/api/conversations/"+encodeURIComponent(id),{method:"DELETE"}); }catch{}
  if(id===activeId) newChat();
  await loadConversations();
}

// --- Chat rendering ---------------------------------------------------------
// Render an error line (icon + message) into an assistant bubble. Used when
// generation fails before any content lands.
function bubbleError(bubble, msg){
  bubble.replaceChildren();
  const s=document.createElement("span"); s.className="status";
  const ic=document.createElement("span"); ic.className="status-ic"; ic.innerHTML=icon("error",15);
  const t=document.createElement("span"); t.textContent = String(msg||"generation failed");
  s.appendChild(ic); s.appendChild(t);
  bubble.appendChild(s);
}

function addMsg(role, text, ts, searches, images, clarify, answered, steps, thoughts, live=true, selectedValue=null){
  const d=document.createElement("div"); d.className="msg "+role;
  if(role==="user"){
    // Questions: text + any attached images — no header, right-aligned.
    const b=document.createElement("div"); b.className="bubble";
    if(images && images.length){
      const imgs=document.createElement("div"); imgs.className="msg-images";
      images.forEach(src=>{ const im=document.createElement("img"); im.src=src; im.alt="attached image"; im.loading="lazy"; imgs.appendChild(im); });
      b.appendChild(imgs);
    }
    if(text) b.appendChild(document.createTextNode(text)); // escaped; pre-wrap inherits from .bubble
    d.appendChild(b);
    chat.appendChild(d);
    chat.scrollTop=chat.scrollHeight;
    return {bubble:b, searchWrap:null, srcLinks:null, stepsWrap:null, thoughtsWrap:null, thoughtsDet:null};
  }
  // Answers: agent thinking (per-round reasoning, collapsible) and tool-call
  // trace (steps drawer) above the answer, then search evidence (readable
  // snippets), then the answer bubble, then a meta row (date/time + source-link
  // chips + tool badge + copy icon) below. Left-aligned.
  //
  // The thinking accordion is always built inline — for live turns it streams
  // open then collapses on done; for finalized/reloaded turns it renders
  // collapsed with a static "Thinking" label and small dim text behind the
  // accordion (no longer hidden behind the tool-badge popup). Steps and search
  // evidence stay inline for live turns and compact into the tool-badge popup
  // for finalized turns. Clarify turns render an interactive card in the
  // bubble, so they get no badge. The wraps live outside the StreamRenderer's
  // container so streaming re-parses never wipe them.
  const hasClarify = !!(clarify && clarify.questions && clarify.questions.length);
  let thoughtsWrap=null, thoughtsDet=null, stepsWrap=null, searchWrap=null, srcLinks=null;
  // Thinking accordion — inline for both live and finalized turns.
  const built=buildThoughtsWrap(); thoughtsWrap=built.wrap; thoughtsDet=built.det;
  if(thoughts && thoughts.length){
    // Persisted/reloaded reasoning: render collapsed with a static "Thinking"
    // label (no live timer). A live resume (resumeIfGenerating -> tailJob)
    // flips it open with the streaming summary; fresh live turns have none.
    renderThoughts(thoughtsWrap, thoughts);
    setThoughtsSummary(thoughtsDet,"Thinking",{streaming:false});
    if(thoughtsDet) thoughtsDet.open=false;
  } else thoughtsWrap.classList.add("hidden");
  d.appendChild(thoughtsWrap);
  if(live){
    stepsWrap=document.createElement("div"); stepsWrap.className="msg-steps";
    if(steps && steps.length) renderAgentSteps(stepsWrap, steps);
    else stepsWrap.classList.add("hidden");
    d.appendChild(stepsWrap);
    searchWrap=document.createElement("div"); searchWrap.className="msg-search";
    if(searches && searches.length) renderSearchBlock(searchWrap, searches);
    else searchWrap.classList.add("hidden");
    d.appendChild(searchWrap);
  }
  const b=document.createElement("div"); b.className="bubble prose";
  if(hasClarify){
    // A clarifying turn renders the question/options card instead of markdown
    // prose. The question text is also persisted as Content for the model's own
    // context next round, but we don't show it twice.
    b.classList.remove("prose");
    renderClarifyCard(b, clarify, !!answered, (value)=>sendClarifyAnswer(value, b), selectedValue);
  } else if(text){
    renderMessage(b, text);
  }
  d.appendChild(b);
  const meta=document.createElement("div"); meta.className="msg-meta";
  if(ts){ const t=document.createElement("span"); t.className="ts"; t.textContent=fmtTs(ts); meta.appendChild(t); }
  srcLinks=document.createElement("span"); srcLinks.className="src-links";
  if(searches && searches.length) renderSourceLinks(srcLinks, searches);
  meta.appendChild(srcLinks);
  if(!live && !hasClarify){
    const badge=toolBadgeFor({searches, steps});
    if(badge){ badge.addEventListener("click",e=>{ e.stopPropagation(); openToolPopup(badge, {searches, steps}); }); meta.appendChild(badge); }
  }
  if(text && !hasClarify) addCopyMsg(meta, text);
  d.appendChild(meta);
  chat.appendChild(d);
  chat.scrollTop=chat.scrollHeight;
  return {bubble:b, searchWrap, srcLinks, stepsWrap, thoughtsWrap, thoughtsDet};
}
function addCopyMsg(roleRow, text){
  const btn=document.createElement("button"); btn.type="button";
  btn.className="copy-msg"; btn.setAttribute("aria-label","Copy message");
  btn.innerHTML = icon("copy", 14);
  btn.addEventListener("click", async ()=>{
    try{
      await navigator.clipboard.writeText(text);
      btn.classList.add("copied"); btn.innerHTML = icon("check", 14);
      setTimeout(()=>{ btn.classList.remove("copied"); btn.innerHTML = icon("copy", 14); }, 1200);
    }catch{}
  });
  roleRow.appendChild(btn);
}
// --- Tool-usage indicator (finalized answers) -----------------------------
// makeToolBadge builds the small meta-row icon button; toolBadgeFor picks the
// icon from the persisted tool data. Agent steps → sparkles; pure web search
// → globe, dimmed when the only entry is a skipped/no-op marker (the old "Web
// search on — model answered without searching" text). Thinking is rendered
// inline (collapsed accordion), so it no longer drives the badge. Plain
// answers and clarify cards get no badge.
function makeToolBadge(iconName, title){
  const btn=document.createElement("button"); btn.type="button";
  btn.className="tool-badge"; btn.setAttribute("aria-label", title); btn.title=title;
  btn.innerHTML=icon(iconName,14);
  return btn;
}
function toolBadgeFor({searches, steps}){
  if(steps && steps.length) return makeToolBadge("sparkles","Agent mode");
  if(searches && searches.length){
    const b=makeToolBadge("globe","Web search");
    if(searches.every(e=>e && e.skipped)) b.classList.add("dim");
    return b;
  }
  return null;
}
// openToolPopup builds a floating panel with the full search/steps detail
// (rendered by the same lib helpers used inline) and closes on outside-click,
// mirroring the row action menus (closeMenu/positionMenu). Thinking is not
// included — it renders inline as a collapsed accordion on the message.
function openToolPopup(anchor, data){
  closeMenu();
  const m=document.createElement("div"); m.className="tool-popup";
  if(data.searches && data.searches.length){ const sw=document.createElement("div"); sw.className="msg-search"; renderSearchBlock(sw, data.searches); m.appendChild(sw); }
  if(data.steps && data.steps.length){ const st=document.createElement("div"); st.className="msg-steps"; renderAgentSteps(st, data.steps); m.appendChild(st); }
  if(!m.children.length) return;
  document.body.appendChild(m);
  const r=anchor.getBoundingClientRect();
  let top=r.top-m.offsetHeight-4;
  if(top<8) top=Math.min(r.bottom+4, window.innerHeight-m.offsetHeight-8);
  m.style.left=Math.max(8, Math.min(r.left, window.innerWidth-m.offsetWidth-8))+"px";
  m.style.top=top+"px";
  openMenu=m;
  setTimeout(()=>document.addEventListener("click",closeMenu),0);
}

function rerenderChat(){
  chat.innerHTML="";
  messages.forEach((m,i)=>{
    // A clarifying question is "answered" once a user turn follows it, so on a
    // reload we render its option controls disabled and highlight the chosen
    // one. selectedValue is that following user turn's content.
    const answered = m.role==="assistant" && !!m.clarify && i<messages.length-1 && messages[i+1] && messages[i+1].role==="user";
    const selectedValue = answered ? (messages[i+1] && messages[i+1].content) : null;
    addMsg(m.role, m.content, m.ts, m.search ? m.search.searches : null, m.images||null, m.clarify||null, answered, m.steps||null, m.thoughts||null, false, selectedValue);
  });
}
function updateHeader(){
  if(!activeId){ chatTitle.textContent="New chat"; chatMeta.textContent=""; return; }
  const c=conversations.find(x=>x.id===activeId);
  if(!c){ chatTitle.textContent="Chat"; chatMeta.textContent=""; return; }
  chatTitle.textContent=c.title||"New chat";
  chatMeta.textContent=c.updatedAt?("Updated "+absTimeFull(c.updatedAt)):"";
}

// --- Streaming (enqueue a background job, then tail it over SSE) ------------
async function stream(){
  const text=input.value.trim();
  // Slash command: a "/name [args]" line runs the matching command instead
  // of being sent. Unknown /-prefixed text falls through and sends normally,
  // so "/etc/hosts" or code paths aren't hijacked.
  const parsed=parseSlash(text);
  if(parsed){
    const c=findCommand(parsed.name);
    if(c){
      input.value=""; autosize(); closeSlashPopup();
      if(c.args && !parsed.args){ slashNote("Usage: /"+c.name+" "+argHint(c.name)); input.value="/"+c.name+" "; autosize(); input.focus(); return; }
      runCommand(c, parsed.args);
      return;
    }
  }
  const images=pendingImages.slice();
  if((!text && images.length===0) || send.disabled) return;
  if(images.length){ pendingImages=[]; renderImgPills(); }
  recordHistory(text);
  histIndex=inputHistory.length; draft="";
  input.value=""; autosize();
  const uTs=Date.now();
  const userMsg={role:"user",content:text,ts:uTs};
  if(images.length) userMsg.images=images;
  messages.push(userMsg);
  addMsg("user",text,uTs,null,images);

  // Create the conversation on the first turn. The generate call below persists
  // the user turn for existing conversations, so no separate save is needed.
  if(!activeId){
    try{
      const r=await fetch("/api/conversations",{
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({title:titleFrom(text), model:selectedModel, messages})
      });
      if(r.ok){ const c=await r.json(); activeId=c.id; await loadConversations(); }
      else return;
    }catch{ return; }
  }
  if(!activeId) return;

  const aTs=Date.now();
  const {bubble, searchWrap, srcLinks, stepsWrap, thoughtsWrap, thoughtsDet}=addMsg("assistant","",aTs);
  send.disabled=true;
  generatingIds.add(activeId); renderSidebar();
  activeJobConvId=activeId;

  // Enqueue a detached background generation. This also saves the user turn.
  // 200 = new job; 409 = a job is already active for this conversation (its
  // state is returned so we tail it). Retries are safe: a lost-then-retried
  // request just hits the already-active job and returns 409.
  let job, genErr;
  for(let attempt=0; attempt<=MAX_RETRIES; attempt++){
    try{
      const r=await fetch("/api/conversations/"+encodeURIComponent(activeId)+"/generate",{
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({model:selectedModel, messages, web_search:webSearchOn(), clarify:clarifyOn(), agent:agentOn(), local:isLocalModel(selectedModel), supportsTools:modelSupportsTools(selectedModel)===true})
      });
      if(r.ok || r.status===409){ job=await r.json(); break; }
      genErr=new Error("HTTP "+r.status);
      if(!(r.status>=500 && r.status<600)) break; // 4xx -> fail fast
    }catch(e){ genErr=e; }
    if(attempt<MAX_RETRIES) await sleep(Math.min(MAX_DELAY, BASE_DELAY*2**attempt)*(0.7+Math.random()*0.6));
  }
  if(!job){
    bubbleError(bubble, String((genErr&&genErr.message)||genErr||"generate failed"));
    generatingIds.delete(activeId); renderSidebar();
    activeJobConvId=null; renderSend(); input.focus();
    return;
  }
  if(job.status==="error"){
    bubbleError(bubble, job.error||"generation failed");
    generatingIds.delete(activeId); renderSidebar();
    activeJobConvId=null; renderSend(); input.focus();
    return;
  }

  // Tail the job. Generation keeps running on the NAS even if the user switches
  // chats; "done" reloads this conversation from the server (source of truth).
  tailJob(activeId, job.id, bubble, job.content||"", searchWrap, srcLinks, null, stepsWrap, null, thoughtsWrap, thoughtsDet, null);
  renderSend();
}

// A clarifying-question option was clicked: send its value as the next user
// turn (which re-enters /generate so the model asks again or answers). If the
// question is still finalizing (job active), defer until it's done. Disables
// the card's buttons immediately so the user can't double-send.
function sendClarifyAnswer(value, bubble){
  if(bubble) bubble.querySelectorAll(".clarify-row, .clarify-input, .clarify-send").forEach(el=>{ el.disabled=true; });
  if(activeJobConvId===activeId){
    pendingClarifyAnswer=value;
    return;
  }
  input.value=value;
  stream();
}

send.addEventListener("click",()=>{ if(send.classList.contains("stop")) stopActive(); else stream(); });
input.addEventListener("keydown",e=>{
  if(slashPopupOpen()){
    if(e.key==="ArrowDown"){ e.preventDefault(); if(slashItems.length){ slashSelected=Math.min(slashItems.length-1,slashSelected+1); markSlashSelected(); } return; }
    if(e.key=="ArrowUp"){ e.preventDefault(); if(slashItems.length){ slashSelected=Math.max(0,slashSelected-1); markSlashSelected(); } return; }
    if(e.key==="Tab"){ e.preventDefault(); if(slashItems.length) completeSlash(); return; }
    if(e.key==="Escape"){ e.preventDefault(); closeSlashPopup(); return; }
    if(e.key==="Enter"&&!e.shiftKey){
      if(slashItems.length){ e.preventDefault(); runSlashIndex(slashSelected); return; }
      closeSlashPopup(); // no matches — let this Enter send the text normally
    }
  }
  if(e.key==="Enter"&&!e.shiftKey){ e.preventDefault(); stream(); return; }
  if(e.key==="ArrowUp"||e.key==="ArrowDown"){
    const sel=input.selectionStart, v=input.value;
    if(e.key==="ArrowUp"){
      const firstNL=v.indexOf("\n");
      if((firstNL===-1||sel<=firstNL)&&histIndex>0){
        e.preventDefault();
        if(histIndex===inputHistory.length) draft=v;
        histIndex--; loadHistEntry();
      }
    } else {
      const lastNL=v.lastIndexOf("\n");
      if((lastNL===-1||sel>lastNL)&&histIndex<inputHistory.length){
        e.preventDefault();
        histIndex++; loadHistEntry();
      }
    }
  }
});
input.addEventListener("input", e=>{ autosize(); updateSlashPopup(); });

// --- Sidebar toggle (mobile) ------------------------------------------------
function openSidebar(){ sidebar.classList.add("open"); scrim.classList.remove("hidden"); document.body.classList.add("drawer-open"); }
function closeSidebar(){ sidebar.classList.remove("open"); scrim.classList.add("hidden"); document.body.classList.remove("drawer-open"); }
menuBtn.addEventListener("click", ()=>{ sidebar.classList.contains("open")?closeSidebar():openSidebar(); });
closeSide.addEventListener("click", closeSidebar);
scrim.addEventListener("click", closeSidebar);
document.addEventListener("keydown", e=>{ if(e.key==="Escape") closeSidebar(); });
$("newFolder").addEventListener("click", createFolder);

// --- Helpers ----------------------------------------------------------------
function titleFrom(t){ t=(t||"").trim().replace(/\s+/g," "); return t ? (t.slice(0,40)+(t.length>40?"…":"")) : "New chat"; }

// --- Input history (ArrowUp/Down step through sent questions) --------------
const HISTORY_CAP=100;
function loadInputHistory(){ try{ return JSON.parse(localStorage.getItem("nas-llm-history")||"[]")||[]; }catch{ return []; } }
function saveInputHistory(){ localStorage.setItem("nas-llm-history", JSON.stringify(inputHistory)); }
function recordHistory(text){ if(!text||inputHistory[inputHistory.length-1]===text) return; inputHistory.push(text); if(inputHistory.length>HISTORY_CAP) inputHistory.shift(); saveInputHistory(); }
function autosize(){ input.style.height="auto"; input.style.height=input.scrollHeight+"px"; }
function loadHistEntry(){ input.value = histIndex===inputHistory.length ? draft : inputHistory[histIndex]; input.selectionStart=input.selectionEnd=input.value.length; autosize(); }
function relTime(ms){
  if(!ms) return "";
  const s=(Date.now()-ms)/1000;
  if(s<60) return "just now";
  if(s<3600) return Math.floor(s/60)+"m ago";
  if(s<86400) return Math.floor(s/3600)+"h ago";
  if(s<604800) return Math.floor(s/86400)+"d ago";
  return new Date(ms).toLocaleDateString();
}
function absTime(ms){
  if(!ms) return "";
  const d=new Date(ms), now=new Date();
  if(d.toDateString()===now.toDateString()) return d.toLocaleTimeString([], {hour:"2-digit", minute:"2-digit"});
  if(d.getFullYear()===now.getFullYear()) return d.toLocaleDateString([], {month:"short", day:"numeric"});
  return d.toLocaleDateString([], {month:"short", day:"numeric", year:"numeric"});
}
function absTimeFull(ms){
  if(!ms) return "";
  return new Date(ms).toLocaleString([], {month:"short", day:"numeric", year:"numeric", hour:"2-digit", minute:"2-digit"});
}
function fmtTs(ms){
  if(!ms) return "";
  return new Date(ms).toLocaleString([], {month:"short", day:"numeric", hour:"2-digit", minute:"2-digit"});
}

// --- Models panel (download / remove / benchmark / fit guidance) --------------
let modelsTab = "installed";
let pullES = null;       // EventSource tail for the active pull
let pullEls = null;      // {fill, phase, bytes, cancel} refs into #pullStatus
let pullJobModel = null; // model name of the active pull (for UI)
let pullTarget = localStorage.getItem("nas-llm-pull-target") || "auto"; // auto|nas|mac|local
let pullMode = null;            // "server" | "local" | null — which pull path is active
let activePullAbort = null;     // AbortController for an in-flight LOCAL (browser-driven) pull
// A local (browser-driven) pull runs as a fetch to localhost:11434/api/pull, so its
// state lives only in memory — a page refresh aborts the fetch and loses the bar. We
// persist the in-flight model name so a reload can re-POST /api/pull (Ollama resumes
// from cached layers and re-streams progress) and re-drive the bar. Cleared on
// success/cancel/error.
function loadLocalPullName(){ return localStorage.getItem("nas-llm-local-pull") || ""; }
function saveLocalPullName(name){ if(name) localStorage.setItem("nas-llm-local-pull", name); else localStorage.removeItem("nas-llm-local-pull"); }

$("closeModels").addEventListener("click", closeModelsPanel);
$("tabInstalled").addEventListener("click", ()=>switchTab("installed"));
$("tabBrowse").addEventListener("click", ()=>switchTab("browse"));
$("modelsModal").addEventListener("click", e=>{ if(e.target===$("modelsModal")) closeModelsPanel(); });
document.addEventListener("keydown", e=>{ if(e.key==="Escape" && $("modelsModal").classList.contains("open")) closeModelsPanel(); });

// --- Drawer horizontal resize (Models + Agent panels) ----------------------
// The right-side slide-in drawers (.modal-card) default to 460px. This injects
// a left-edge grab handle into each, drives width via the --drawer-w CSS
// variable, and persists the chosen width so it survives reloads. The drawer
// is pinned to the right edge, so its width = viewport width - left-edge x.
// Shared by both .modal panels; no-op on mobile where the cards go full-width.
const DRAWER_MIN=360, DRAWER_KEY="nas-llm-drawer-w";
function drawerMaxW(){ return Math.floor(window.innerWidth*0.92); }
function applyDrawerW(card,w){ card.style.setProperty("--drawer-w", Math.max(DRAWER_MIN, Math.min(w, drawerMaxW()))+"px"); }
function initDrawerResize(){
  document.querySelectorAll(".modal-card").forEach(card=>{
    if(card.querySelector(".modal-resize")) return;
    const handle=document.createElement("div"); handle.className="modal-resize";
    handle.setAttribute("role","separator"); handle.setAttribute("aria-orientation","vertical"); handle.title="Drag to resize";
    card.prepend(handle);
    const saved=parseFloat(localStorage.getItem(DRAWER_KEY)); if(saved>0) applyDrawerW(card,saved);
    handle.addEventListener("pointerdown",e=>{
      e.preventDefault();
      document.body.classList.add("drawer-resizing");
      const move=ev=>applyDrawerW(card, window.innerWidth-ev.clientX);
      const up=()=>{
        document.removeEventListener("pointermove",move);
        document.removeEventListener("pointerup",up);
        document.removeEventListener("pointercancel",up);
        document.body.classList.remove("drawer-resizing");
        const w=parseFloat(getComputedStyle(card).getPropertyValue("--drawer-w"));
        if(w>0) localStorage.setItem(DRAWER_KEY,String(w));
      };
      document.addEventListener("pointermove",move);
      document.addEventListener("pointerup",up);
      document.addEventListener("pointercancel",up);
      move(e);
    });
  });
}
// Re-clamp on viewport changes so a shrunk window never overflows the handle.
window.addEventListener("resize",()=>{
  document.querySelectorAll(".modal-card").forEach(card=>{
    const w=parseFloat(getComputedStyle(card).getPropertyValue("--drawer-w"));
    if(w>0) applyDrawerW(card,w);
  });
});
initDrawerResize();

// --- Left sidebar horizontal resize -----------------------------------------
// #sidebar is a flex item (default 248px). A 6px grab gutter (.sidebar-resize)
// is injected as the next flex child in #app, between #sidebar and main. The
// sidebar sits on the left of the viewport, so its width = pointer x. Driven
// via --sidebar-w and persisted; hidden on mobile (CSS) where the sidebar is a
// slide-over. No-op if #sidebar isn't present.
const SIDEBAR_MIN=200, SIDEBAR_KEY="nas-llm-sidebar-w";
function sidebarMaxW(){ return Math.floor(window.innerWidth*0.5); }
function applySidebarW(w){ const s=$("sidebar"); if(s) s.style.setProperty("--sidebar-w", Math.max(SIDEBAR_MIN, Math.min(w, sidebarMaxW()))+"px"); }
function initSidebarResize(){
  const s=$("sidebar"); if(!s) return;
  const app=s.parentElement; if(!app) return;
  if(app.querySelector(".sidebar-resize")) return;
  const handle=document.createElement("div"); handle.className="sidebar-resize";
  handle.setAttribute("role","separator"); handle.setAttribute("aria-orientation","vertical"); handle.title="Drag to resize";
  app.insertBefore(handle, s.nextSibling);
  const saved=parseFloat(localStorage.getItem(SIDEBAR_KEY)); if(saved>0) applySidebarW(saved);
  handle.addEventListener("pointerdown",e=>{
    e.preventDefault();
    document.body.classList.add("sidebar-resizing");
    const move=ev=>applySidebarW(ev.clientX);
    const up=()=>{
      document.removeEventListener("pointermove",move);
      document.removeEventListener("pointerup",up);
      document.removeEventListener("pointercancel",up);
      document.body.classList.remove("sidebar-resizing");
      const s2=$("sidebar"); const w=parseFloat(getComputedStyle(s2).getPropertyValue("--sidebar-w"));
      if(w>0) localStorage.setItem(SIDEBAR_KEY,String(w));
    };
    document.addEventListener("pointermove",move);
    document.addEventListener("pointerup",up);
    document.addEventListener("pointercancel",up);
    move(e);
  });
}
window.addEventListener("resize",()=>{
  const s=$("sidebar"); if(!s) return;
  const w=parseFloat(getComputedStyle(s).getPropertyValue("--sidebar-w"));
  if(w>0) applySidebarW(w);
});
initSidebarResize();

function openModelsPanel(tab){ $("modelsModal").classList.add("open"); renderModelBanner(); switchTab(tab||"installed"); }
function closeModelsPanel(){
  $("modelsModal").classList.remove("open");
  if(pullES){ pullES.close(); pullES=null; } // pull keeps running on the NAS; reattach on reopen
  pullEls=null;
}
async function switchTab(tab){
  modelsTab=tab;
  $("tabInstalled").classList.toggle("active", tab==="installed");
  $("tabBrowse").classList.toggle("active", tab==="browse");
  if(tab==="installed") await renderInstalledTab(); else await renderBrowseTab();
}

async function renderInstalledTab(){
  const body=$("tabBody"); body.innerHTML="";
  let data;
  try{ const r=await fetchRetry("/api/models",{},{label:"Load models"}); data=await r.json(); }
  catch(e){ body.appendChild(mutedNote("Could not load models: "+errText(e))); await resumePullIfActive(); return; }
  const list=data.data||[];
  lastServerModels=list;
  modelEntries=buildModelEntries(list, localEntries());
  models=modelEntries.map(e=>e.name);
  syncSelectedFromEntries();
  renderModels();                                   // header button + banner in sync
  renderModelBanner();
  // Grouped selectable rows: NAS, Mac, then Local (this computer).
  const groups={};
  for(const m of list){ const h=m.host||"nas"; (groups[h]=groups[h]||[]).push(m); }
  const none=!((groups.nas&&groups.nas.length)||(groups.mac&&groups.mac.length)||localModelNames.length);
  if(none) body.appendChild(mutedNote("No models installed yet. Get more models to download one."));
  for(const h of ["nas","mac"]){
    const arr=groups[h]; if(!arr||!arr.length) continue;
    body.appendChild(makeGroupLabel({nas:"NAS",mac:"Mac"}[h]));
    arr.forEach(m=>body.appendChild(buildInstalledRow(m)));
  }
  body.appendChild(renderLocalBlock());
  // Prominent bottom CTA so "get more models" is obvious without changing tabs.
  const cta=document.createElement("button"); cta.type="button"; cta.className="get-more-cta";
  cta.innerHTML=icon("download",15)+'<span>Get more models</span>';
  cta.addEventListener("click",()=>switchTab("browse"));
  body.appendChild(cta);
  await resumePullIfActive();
}
function makeGroupLabel(text){ const gl=document.createElement("div"); gl.className="model-group-label"; gl.textContent=text; return gl; }
// Local (this computer) block: heading + Connect button, then either the
// visitor's discovered model rows, a hint (nothing connected yet), or the last
// discovery error (403/refused) per the relay contract. Rows are selectable.
function renderLocalBlock(){
  const sec=document.createElement("div"); sec.className="local-section";
  const head=document.createElement("div"); head.className="local-head";
  const label=document.createElement("div"); label.className="local-label"; label.textContent="Local (this computer)";
  const connect=document.createElement("button"); connect.type="button"; connect.className="local-connect";
  connect.innerHTML=icon("boxes",15)+'<span>Connect local models</span>';
  connect.addEventListener("click", onConnectLocal);
  head.appendChild(label); head.appendChild(connect); sec.appendChild(head);
  if(localDiscoverMsg){
    const err=document.createElement("div"); err.className="err-note local-err"; err.textContent=localDiscoverMsg;
    sec.appendChild(err);
  }
  const known=localModels.length?localModels:localModelNames.map(n=>({name:n}));
  if(known.length){
    known.forEach(m=>sec.appendChild(buildLocalRow(m)));
  } else if(!localDiscoverMsg){
    const hint=document.createElement("div"); hint.className="muted local-hint";
    hint.textContent="Connect to Ollama on this computer (localhost:11434) to use your own models here — full feature parity with server models.";
    sec.appendChild(hint);
  }
  return sec;
}
async function onConnectLocal(){
  localDiscoverMsg=null;
  const res=await discoverLocalModels();
  if(res.ok){ localModels=res.models; localModelNames=res.models.map(m=>m.name); saveLocalModelNames(); }
  else {
    localModels=[];
    if(res.kind==="origins") localDiscoverMsg="Your local Ollama rejected the request — start it with OLLAMA_ORIGINS=https://chat.selected.systems ollama serve (or OLLAMA_ORIGINS=*).";
    else if(res.kind==="refused") localDiscoverMsg=localFetchErrMsg(res.error);
    else localDiscoverMsg="Local Ollama returned HTTP "+(res.status||"?")+".";
  }
  modelEntries=buildModelEntries(lastServerModels, localEntries());
  models=modelEntries.map(e=>e.name);
  syncSelectedFromEntries();
  renderModels();
  enforceToolGating();
  await renderInstalledTab();
}


// Browse state: the catalog is fetched once per tab render and re-filtered
// client-side as the user types/selects categories (no re-fetch per filter).
let browseCatalog=null;       // last catalog response ({models, nas, hosts})
let browseQuery="";            // current search text (lowercased)
let browseCategory=null;       // current category filter (null = all)
// Browse has two modes: "recommended" (hand-curated catalog with fit verdicts)
// and "library" (live search of the full Ollama library via /api/models/library).
let browseMode = localStorage.getItem("nas-llm-browse-mode") || "recommended";
let libQuery="", libCap=null, libOrder="popular"; let libTimer=null;
const CATEGORY_LABELS={code:"Code",agentic:"Agentic",math:"Math",vision:"Vision","long-context":"Long context",fast:"Fast",chat:"Chat",embeddings:"Embeddings"};
function categoryLabel(c){ return CATEGORY_LABELS[c]||c; }
// Download target chooser: Auto (backend picks by catalog intent), NAS, Mac (only
// when a mac host is configured), or Local (this computer — browser-driven pull).
function buildPullTargetSelect(){
  const sel=document.createElement("select"); sel.className="pull-target"; sel.title="Where new models download to";
  sel.appendChild(new Option("Auto (recommended)","auto"));
  sel.appendChild(new Option("NAS","nas"));
  const hosts=(browseCatalog&&browseCatalog.hosts)||[];
  if(hosts.some(h=>h.name==="mac")) sel.appendChild(new Option("Mac","mac"));
  sel.appendChild(new Option("Local (this computer)","local"));
  sel.value=pullTarget;
  sel.addEventListener("change",()=>{
    pullTarget=sel.value; localStorage.setItem("nas-llm-pull-target", pullTarget);
    // Re-render the visible list so its preflight badges reflect the new target
    // (preflight is cached → badges reappear instantly). Recommended cards are
    // rebuilt; library cards are re-badged in place to avoid a library refetch.
    if(browseMode==="library") reattachLibraryPreflight(); else renderBrowseList();
  });
  return sel;
}
function collectCategories(models){ const set=new Set(); models.forEach(m=>(m.categories||[]).forEach(c=>set.add(c))); return [...set]; }
function makeCatChip(cat, label, active, onClick){
  const b=document.createElement("button"); b.type="button"; b.className="cat-chip"+(active?" active":"");
  b.textContent=label; b.addEventListener("click",onClick); return b;
}
// Re-render the filtered catalog into #browseList without re-fetching.
function renderBrowseList(){
  const list=$("browseList"); if(!list) return;
  list.innerHTML="";
  const models=(browseCatalog&&browseCatalog.models)||[];
  const q=browseQuery, cat=browseCategory;
  const filtered=models.filter(m=>{
    if(cat && !(m.categories||[]).includes(cat)) return false;
    if(q){ const hay=[m.name,m.family,m.blurb,m.recommendedFor,(m.categories||[]).join(" ")].join(" ").toLowerCase(); if(!hay.includes(q)) return false; }
    return true;
  });
  if(!filtered.length){ list.appendChild(mutedNote("No models match your search.")); return; }
  filtered.forEach(m=>list.appendChild(renderBrowseCard(m)));
  filtered.forEach(m=>attachPreflightBadge(list, m.name, pullTarget, false));
}
// The download targets offered on per-card Download menus and the top chooser.
function availablePullTargets(){
  const ts=[{value:"auto",label:"Auto (NAS/Mac by fit)"},{value:"nas",label:"NAS"}];
  const hosts=(browseCatalog&&browseCatalog.hosts)||[];
  if(hosts.some(h=>h.name==="mac")) ts.push({value:"mac",label:"Mac"});
  ts.push({value:"local",label:"Local (this computer)"});
  return ts;
}
// Position a floating menu under an anchor and arm the click-to-close listener.
function positionMenu(m, anchor){
  const r=anchor.getBoundingClientRect();
  m.style.left=Math.min(r.left, window.innerWidth-m.offsetWidth-8)+"px";
  m.style.top=(r.bottom+4)+"px";
  openMenu=m;
  setTimeout(()=>document.addEventListener("click",closeMenu),0);
}
// Build the NAS/Mac/Local target chooser inside m for a fully-qualified model
// (name or name:tag). Each target is enriched with the real download size +
// per-host fit once its preflight resolves. Clicking a target pulls.
function renderTargetChooser(m, model){
  m.className="menu dl-menu";
  m.replaceChildren();
  const title=document.createElement("div"); title.className="menu-msg"; title.textContent="Download "+model+" to:"; m.appendChild(title);
  availablePullTargets().forEach(t=>{
    const b=document.createElement("button"); b.className="dl-target";
    const label=document.createElement("span"); label.className="dl-label"; label.textContent=t.label;
    const sub=document.createElement("span"); sub.className="dl-sub muted"; sub.textContent="…";
    b.appendChild(label); b.appendChild(sub);
    b.addEventListener("click",e=>{ e.stopPropagation(); closeMenu(); startPull(model, t.value); });
    m.appendChild(b);
    // Enrich with the real download size + per-host fit once the preflight
    // resolves (cached, so a reopen is instant). Fails silently to a muted
    // "size unknown" when the registry endpoint is unreachable.
    preflightModel(model, t.value).then(pf=>{
      if(!pf || pf.downloadGB == null){ sub.textContent="size unknown"; sub.classList.add("dl-unknown"); return; }
      sub.replaceChildren(); sub.classList.remove("muted");
      const gb=document.createElement("span"); gb.className="dl-gb"; gb.textContent=pf.downloadGB.toFixed(1)+" GB"; sub.appendChild(gb);
      const fit=preflightFitLabel(pf);
      if(fit){
        const sep=document.createElement("span"); sep.className="dl-sep"; sep.textContent="·"; sub.appendChild(sep);
        const f=document.createElement("span"); f.className="dl-fit "+fit.cls; f.textContent=fit.label; sub.appendChild(f);
      }
    });
  });
}
// Per-card Download menu. An already-tagged name (curated catalog entry like
// "llama3.2:1b") goes straight to the target chooser. A bare library name has
// many tags/sizes, so we list them (scraped from ollama.com/library/<name>/tags)
// and morph into the target chooser once the user picks a tag. Falls back to
// the default-tag target chooser if the tags lookup fails.
async function openDownloadMenu(anchor, model){
  closeMenu();
  const m=document.createElement("div"); m.className="menu dl-menu";
  document.body.appendChild(m);
  if(model.includes(":")){ renderTargetChooser(m, model); positionMenu(m, anchor); return; }
  const title=document.createElement("div"); title.className="menu-msg"; title.textContent="Choose a size for "+model+":"; m.appendChild(title);
  const loading=document.createElement("div"); loading.className="menu-msg muted"; loading.textContent="Loading sizes…"; m.appendChild(loading);
  positionMenu(m, anchor);
  let tags=[];
  try{ const r=await fetchRetry("/api/models/library/tags?name="+encodeURIComponent(model),{},{label:"Load tags"}); if(r.ok){ const j=await r.json(); tags=j.tags||[]; } }catch{}
  if(!tags.length){ renderTargetChooser(m, model); positionMenu(m, anchor); return; }
  m.replaceChildren();
  const head=document.createElement("div"); head.className="menu-msg"; head.textContent="Choose a size for "+model+":"; m.appendChild(head);
  m.style.maxHeight="60vh"; m.style.overflowY="auto";
  tags.forEach(t=>{
    const b=document.createElement("button"); b.className="dl-target";
    const nm=document.createElement("span"); nm.className="dl-label"; nm.textContent=t.tag;
    const sz=document.createElement("span"); sz.className="dl-sub"; sz.textContent=(t.sizeLabel || (t.sizeGB? t.sizeGB.toFixed(1)+" GB":""));
    if(t.context) b.title=t.context+" context window";
    b.appendChild(nm); b.appendChild(sz);
    b.addEventListener("click",e=>{ e.stopPropagation(); m.style.maxHeight=""; m.style.overflowY=""; renderTargetChooser(m, model+":"+t.tag); positionMenu(m, anchor); });
    m.appendChild(b);
  });
  positionMenu(m, anchor);
}
async function renderBrowseTab(){
  const body=$("tabBody"); body.innerHTML="";
  let data;
  try{ const r=await fetchRetry("/api/models/catalog",{},{label:"Load catalog"}); data=await r.json(); }
  catch(e){ body.appendChild(mutedNote("Could not load catalog.")); await resumePullIfActive(); return; }
  browseCatalog=data;
  const nas=data.nas||{};
  // Primary: the mode toggle (Recommended | All models) sits on top so browsing
  // is the first thing the user reaches. Each mode owns its controls + list.
  const seg=document.createElement("div"); seg.className="browse-seg";
  const recB=document.createElement("button"); recB.type="button"; recB.className="seg-btn"+(browseMode!=="library"?" active":""); recB.textContent="Recommended";
  recB.addEventListener("click",()=>{ browseMode="recommended"; localStorage.setItem("nas-llm-browse-mode", browseMode); renderBrowseMode(); });
  const allB=document.createElement("button"); allB.type="button"; allB.className="seg-btn"+(browseMode==="library"?" active":""); allB.textContent="All models";
  allB.addEventListener("click",()=>{ browseMode="library"; localStorage.setItem("nas-llm-browse-mode", browseMode); renderBrowseMode(); });
  seg.appendChild(recB); seg.appendChild(allB); body.appendChild(seg);
  // Recommended section (curated catalog + client-side search/category filter).
  const rec=document.createElement("div"); rec.id="browseRec";
  const controls=document.createElement("div"); controls.className="browse-controls";
  const search=document.createElement("input"); search.type="search"; search.className="browse-search"; search.placeholder="Search recommended…";
  search.value=browseQuery;
  search.addEventListener("input",()=>{ browseQuery=search.value.trim().toLowerCase(); renderBrowseList(); });
  controls.appendChild(search);
  const chips=document.createElement("div"); chips.className="cat-chips";
  chips.appendChild(makeCatChip(null,"All",browseCategory===null,()=>{ browseCategory=null; renderBrowseList(); }));
  collectCategories(data.models||[]).forEach(c=>chips.appendChild(makeCatChip(c,categoryLabel(c),browseCategory===c,()=>{ browseCategory=c; renderBrowseList(); })));
  controls.appendChild(chips); rec.appendChild(controls);
  const rlist=document.createElement("div"); rlist.className="browse-list"; rlist.id="browseList"; rec.appendChild(rlist);
  body.appendChild(rec);
  // Library section (live full-library search).
  body.appendChild(buildLibrarySection());
  // Fit legend: a small muted footnote for the Recommended verdicts. Library
  // cards carry no fit verdict, so renderBrowseMode hides it in that mode.
  const note=document.createElement("div"); note.className="catalog-note muted"; note.id="browseFitNote";
  note.textContent=`Fit is estimated for ${nas.ramGB||8} GB RAM · ${(nas.contextLength||16384).toLocaleString()}-tok context (reserve ${(nas.reserveGB||1.5).toFixed(1)} GB). Benchmark after download for real tok/s.`;
  body.appendChild(note);
  // Secondary zone: manual pull + download settings, grouped below a divider
  // as alternatives to browsing (compact, not primary content).
  const secondary=document.createElement("div"); secondary.className="browse-secondary";
  const pbnLabel=document.createElement("div"); pbnLabel.className="browse-secondary-label"; pbnLabel.textContent="Pull a specific model";
  secondary.appendChild(pbnLabel);
  const pbn=document.createElement("div"); pbn.className="pullbyname";
  const hint=document.createElement("span"); hint.className="muted"; hint.textContent="Any model by name, e.g. mistral:7b, llama3.2:1b";
  const row=document.createElement("div"); row.className="row";
  const inp=document.createElement("input"); inp.placeholder="model:tag";
  const go=document.createElement("button"); go.textContent="Download";
  go.addEventListener("click",()=>{ const v=inp.value.trim(); if(v) startPull(v, pullTarget); });
  inp.addEventListener("keydown",e=>{ if(e.key==="Enter"){ e.preventDefault(); go.click(); } });
  row.appendChild(inp); row.appendChild(go);
  pbn.appendChild(hint); pbn.appendChild(row); secondary.appendChild(pbn);
  const dsLabel=document.createElement("div"); dsLabel.className="browse-secondary-label"; dsLabel.textContent="Download settings";
  secondary.appendChild(dsLabel);
  const targetRow=document.createElement("div"); targetRow.className="pull-target-row";
  const tl=document.createElement("span"); tl.className="muted"; tl.textContent="Download to:";
  targetRow.appendChild(tl); targetRow.appendChild(buildPullTargetSelect());
  // Local RAM budget: the backend can't know the visitor's RAM, so Local-target
  // fit is estimated in-browser against this number (persisted, default 16 GB).
  const ramWrap=document.createElement("span"); ramWrap.className="local-ram-wrap";
  const ramLabel=document.createElement("span"); ramLabel.className="muted"; ramLabel.textContent="Local RAM:";
  const ramInp=document.createElement("input"); ramInp.type="number"; ramInp.className="local-ram";
  ramInp.min=2; ramInp.max=128; ramInp.step=1; ramInp.value=localRamGB;
  ramInp.title="Your computer's RAM (GB) — used to estimate whether Local-target downloads fit";
  ramInp.addEventListener("change",()=>{
    const v=parseFloat(ramInp.value);
    if(!(v>0)){ ramInp.value=localRamGB; return; }
    localRamGB=v; saveLocalRamGB(); refreshLocalPreflightBadges();
  });
  ramWrap.appendChild(ramLabel); ramWrap.appendChild(ramInp);
  targetRow.appendChild(ramWrap);
  secondary.appendChild(targetRow);
  body.appendChild(secondary);
  renderBrowseMode();
  await resumePullIfActive();
}

// Toggle which Browse section is visible and render the active one.
function renderBrowseMode(){
  const rec=$("browseRec"), lib=$("browseLib"), note=$("browseFitNote");
  if(!rec||!lib) return;
  const libOn=browseMode==="library";
  rec.classList.toggle("hidden", libOn);
  lib.classList.toggle("hidden", !libOn);
  if(note) note.classList.toggle("hidden", libOn);
  document.querySelectorAll(".browse-seg .seg-btn").forEach((b,i)=>{ b.classList.toggle("active", (i===0 && !libOn) || (i===1 && libOn)); });
  if(libOn) renderLibraryList(); else renderBrowseList();
}

// Build the "All models" (live library) controls + empty results container.
function buildLibrarySection(){
  const sec=document.createElement("div"); sec.id="browseLib"; if(browseMode!=="library") sec.classList.add("hidden");
  const controls=document.createElement("div"); controls.className="browse-controls";
  const search=document.createElement("input"); search.type="search"; search.className="browse-search"; search.placeholder="Search all Ollama models…"; search.value=libQuery;
  search.addEventListener("input",()=>{
    libQuery=search.value.trim();
    if(libTimer) clearTimeout(libTimer);
    libTimer=setTimeout(()=>{ libTimer=null; renderLibraryList(); }, 350);
  });
  controls.appendChild(search);
  const chips=document.createElement("div"); chips.className="cat-chips";
  const caps=[["All",null],["Tools","tools"],["Vision","vision"],["Thinking","thinking"],["Embedding","embedding"]];
  caps.forEach(([label,val])=>chips.appendChild(makeCatChip(val,label,libCap===val,()=>{ libCap=val; renderLibraryList(); })));
  controls.appendChild(chips);
  const sortRow=document.createElement("div"); sortRow.className="lib-sort-row";
  const sortLabel=document.createElement("span"); sortLabel.className="muted"; sortLabel.textContent="Sort:";
  const sortSel=document.createElement("select"); sortSel.className="lib-sort";
  sortSel.appendChild(new Option("Popular","popular")); sortSel.appendChild(new Option("Newest","newest"));
  sortSel.value=libOrder;
  sortSel.addEventListener("change",()=>{ libOrder=sortSel.value; renderLibraryList(); });
  sortRow.appendChild(sortLabel); sortRow.appendChild(sortSel); controls.appendChild(sortRow);
  sec.appendChild(controls);
  const list=document.createElement("div"); list.className="browse-list"; list.id="browseLibList"; sec.appendChild(list);
  return sec;
}

// Fetch /api/models/library (live ollama.com search) and render the results.
async function renderLibraryList(){
  const list=$("browseLibList"); if(!list) return;
  list.innerHTML=""; list.appendChild(mutedNote("Searching the Ollama library…"));
  try{
    const params=new URLSearchParams();
    if(libQuery) params.set("q",libQuery);
    if(libCap) params.set("c",libCap);
    if(libOrder) params.set("o",libOrder);
    const r=await fetchRetry("/api/models/library?"+params.toString(),{},{label:"Library search"});
    if(r.status===502){ list.replaceChildren(mutedNote("Library search is unavailable right now (couldn't reach ollama.com). Try Recommended.")); return; }
    if(!r.ok){ list.replaceChildren(mutedNote("Library search failed (HTTP "+r.status+").")); return; }
    const j=await r.json(); const mods=j.models||[];
    list.replaceChildren();
    if(!mods.length){ list.appendChild(mutedNote("No models found. Try a different search or capability.")); return; }
    mods.forEach(m=>list.appendChild(renderLibraryCard(m)));
    mods.forEach(m=>attachPreflightBadge(list, m.name, pullTarget, true));
  }catch(e){ list.replaceChildren(mutedNote("Library search failed: "+errText(e))); }
}

// A library card: name + description + capability/size badges + pulls/tags/
// updated + a Download button (per-card target menu). No fit verdict (the
// backend can't estimate KV cache without known arch dims); capabilities +
// sizes help the user judge, and the pull auto-benchmarks once installed.
function renderLibraryCard(m){
  const card=document.createElement("div"); card.className="mcard lib-card"; card.dataset.preflight=m.name;
  const head=document.createElement("div"); head.className="mcard-head";
  const title=document.createElement("div"); title.className="mcard-title"; title.textContent=m.name;
  const sub=document.createElement("div"); sub.className="mcard-sub";
  const bits=[];
  if(m.pulls) bits.push(m.pulls+" pulls");
  if(m.tags) bits.push(m.tags+" tags");
  if(m.updated) bits.push("updated "+m.updated);
  sub.textContent=bits.join(" · ");
  head.appendChild(title); head.appendChild(sub); card.appendChild(head);
  if(m.description){ const d=document.createElement("div"); d.className="mcard-blurb muted"; d.textContent=m.description; card.appendChild(d); }
  const caps=document.createElement("div"); caps.className="badges";
  (m.capabilities||[]).forEach(c=>caps.appendChild(badge(capLabel(c),"cap")));
  (m.sizes||[]).forEach(s=>caps.appendChild(badge(s,"size")));
  if(caps.childNodes.length) card.appendChild(caps);
  const actions=document.createElement("div"); actions.className="mcard-actions";
  if(models.includes(m.name)){
    const tag=document.createElement("span"); tag.className="installed-tag"; tag.textContent="Installed";
    const use=document.createElement("button"); use.textContent="Use"; use.addEventListener("click",()=>useModel(m.name));
    actions.appendChild(tag); actions.appendChild(use);
  } else {
    const dl=document.createElement("button"); dl.innerHTML=icon("download",15)+" Download ▾";
    dl.addEventListener("click",(e)=>{ e.stopPropagation(); openDownloadMenu(dl, m.name); });
    actions.appendChild(dl);
  }
  card.appendChild(actions);
  return card;
}

function renderBrowseCard(m){
  const card=document.createElement("div"); card.className="mcard"; card.dataset.preflight=m.name;
  const v=m.verdict||{};
  const head=document.createElement("div"); head.className="mcard-head";
  const title=document.createElement("div"); title.className="mcard-title"; title.textContent=m.name;
  const sub=document.createElement("div"); sub.className="mcard-sub";
  const bits=[m.params, m.quant, m.family].filter(Boolean);
  if(m.sizeGB) bits.push("~"+m.sizeGB.toFixed(1)+" GB");
  sub.textContent=bits.join(" · ");
  head.appendChild(title); head.appendChild(sub); card.appendChild(head);
  if(m.blurb){ const b=document.createElement("div"); b.className="mcard-blurb muted"; b.textContent=m.blurb; card.appendChild(b); }
  const caps=document.createElement("div"); caps.className="badges";
  (m.capabilities||[]).forEach(c=>caps.appendChild(badge(capLabel(c), "cap")));
  if(m.recommendedFor) caps.appendChild(badge(m.recommendedFor, "rec"));
  if(caps.childNodes.length) card.appendChild(caps);
  if(m.categories && m.categories.length){
    const cats=document.createElement("div"); cats.className="badges cat-badges";
    m.categories.forEach(c=>cats.appendChild(badge(categoryLabel(c), "cat")));
    card.appendChild(cats);
  }
  const meta=document.createElement("div"); meta.className="mcard-meta";
  meta.appendChild(fitBadge(v)); meta.appendChild(speedBadge(m, v));
  card.appendChild(meta);
  const actions=document.createElement("div"); actions.className="mcard-actions";
  if(m.installed){
    const tag=document.createElement("span"); tag.className="installed-tag"; tag.textContent="Installed";
    const use=document.createElement("button"); use.textContent="Use"; use.addEventListener("click",()=>useModel(m.name));
    actions.appendChild(tag); actions.appendChild(use);
  } else {
    const dl=document.createElement("button"); dl.innerHTML=icon("download",15)+" Download ▾";
    if(v.fit==="no") dl.title="Likely won't fit in 8 GB RAM — expect swapping/very slow";
    // Click opens a per-card target menu (NAS / Mac / Local) so the user
    // chooses where this specific model downloads to.
    dl.addEventListener("click",(e)=>{ e.stopPropagation(); openDownloadMenu(dl, m.name); });
    actions.appendChild(dl);
  }
  card.appendChild(actions);
  return card;
}

// --- Pull flow (enqueue a background pull, tail progress over SSE) ----------
// startPull routes by target: "local" drives the visitor's own Ollama from the
// browser (the NAS backend can't reach localhost:11434); "nas"/"mac" hit the
// backend single-pull worker (sending host so the right backend gets it);
// "auto" sends no host and the backend picks by catalog intent (mac-tagged →
// Mac, else NAS). One progress bar serves both paths; cancel routes to the
// active one.
async function startPull(model, target){
  target = target || pullTarget || "auto";
  if(target === "local"){ startLocalPull(model); return; }
  pullMode = "server";
  try{
    const body = { model };
    if(target === "nas" || target === "mac") body.host = target;
    const r=await fetchRetry("/api/models/pull",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)},{label:"Start pull"});
    const j=await r.json().catch(()=>({}));
    if(r.status===409){ attachPull(j); return; }       // a pull is already running — tail it
    if(!r.ok){ flashError(j.error||"Could not start pull"); pullMode=null; return; }
    attachPull(j);
  }catch(e){ flashError(errText(e)); pullMode=null; }
}

// Browser-driven pull onto the visitor's own Ollama. POST localhost:11434/api/pull
// with stream:true and parse the NDJSON progress ({status,digest,total,completed}),
// aggregating per-layer bytes the same way the backend's ingestProgress does, and
// drive the shared renderPullStatus bar directly (no SSE). Cancel aborts the
// fetch. On success, re-probe /api/tags so the new model (with capabilities)
// appears in the selector.
async function startLocalPull(model){
  if(pullES){ pullES.close(); pullES=null; }     // a server SSE tail can't drive a local pull
  if(activePullAbort){ activePullAbort.abort(); }
  const ctrl=new AbortController(); activePullAbort=ctrl; pullMode="local"; pullJobModel=model;
  saveLocalPullName(model);   // remember so a reload can resume (Ollama caches layers)
  renderPullStatus({ model, percent:0, completed:0, total:0, phase:"pulling manifest", status:"pulling", jobId:"local" });
  let resp;
  // Content-Type is text/plain (not application/json) on purpose: a POST with a
  // CORS-safelisted content type is a "simple request" with no preflight, so it
  // isn't blocked by Chrome's Private Network Access (an HTTPS page POSTing to
  // http://localhost triggers a preflight that Ollama can't answer with
  // Access-Control-Allow-Private-Network: true). Ollama's JSON decoder ignores
  // the Content-Type and parses the body regardless, so the JSON still works.
  try{ resp=await fetch("http://localhost:11434/api/pull",{ method:"POST", headers:{"Content-Type":"text/plain"}, body:JSON.stringify({model, stream:true}), signal:ctrl.signal }); }
  catch(e){ if(ctrl.signal.aborted){ abortCleanup(); return; } saveLocalPullName(null); onPullError(localFetchErrMsg(String(e&&e.message||e))); abortCleanup(); return; }
  if(!resp.ok){ saveLocalPullName(null); onPullError(localStatusErrMsg(resp.status)); abortCleanup(); return; }
  const reader=resp.body.getReader(); const dec=new TextDecoder(); let buf=""; const layers=new Map(); let finished=false; let gotSuccess=false;
  try{
    while(!finished){
      const {done,value}=await reader.read();
      if(done) break;
      buf+=dec.decode(value,{stream:true});
      let idx;
      while((idx=buf.indexOf("\n"))>=0){
        const line=buf.slice(0,idx).trim(); buf=buf.slice(idx+1);
        if(!line) continue;
        let p; try{ p=JSON.parse(line); }catch{ continue; }
        const status=String(p.status||"");
        if(status==="success"){ gotSuccess=true; finished=true; break; }
        // Ollama reports byte progress on lines carrying digest+total, under
        // status "pulling <hash>" (current Ollama) or "downloading" (older).
        // Key the bar on digest+total, not the status string — the old
        // status.startsWith("downloading") check left the bar stuck at 0%
        // because the Mac app's Ollama never sends "downloading".
        if(p.digest && p.total){
          layers.set(p.digest, {completed:p.completed||0, total:p.total});
          let completed=0,total=0; for(const l of layers.values()){ completed+=l.completed; total+=l.total; }
          if(pullEls){ pullEls.fill.style.width=(total>0?(completed/total*100):0)+"%"; pullEls.bytes.textContent=fmtPullBytes(completed,total); pullEls.phase.textContent=prettyPhase("pulling"); }
        } else if(status && pullEls){ pullEls.phase.textContent=prettyPhase(status); }
      }
    }
  }catch(e){ if(ctrl.signal.aborted){ abortCleanup(); return; } }
  activePullAbort=null;
  if(gotSuccess){ await onLocalPullDone(); } else { pullMode=null; }
}
function abortCleanup(){ activePullAbort=null; pullMode=null; $("pullStatus").classList.add("hidden"); pullEls=null; }
async function onLocalPullDone(){
  saveLocalPullName(null);   // pull finished — don't resume on a later reload
  if(pullEls){ pullEls.fill.style.width="100%"; pullEls.phase.textContent="Installed ✓"; pullEls.cancel.disabled=true; }
  setTimeout(async ()=>{
    $("pullStatus").classList.add("hidden"); pullEls=null; pullMode=null;
    await reattachLocalModels();   // re-probe localhost → new model + caps appear in selector
    await loadModels();
    await switchTab(modelsTab);
  }, 1100);
}

function attachPull(job){
  pullJobModel=job.model||null;
  pullMode="server";
  renderPullStatus(job);
  tailPull(job.jobId);
}

async function resumePullIfActive(){
  try{
    const r=await fetch("/api/models/pulls/active");
    if(r.ok){
      const map=await r.json();
      const keys=Object.keys(map||{});
      if(keys.length){ attachPull(map[keys[0]]); return; }   // server pull survived a reload
    }
  }catch{}
  resumeLocalPull();   // no server pull — resume a browser-driven local pull if one was in progress
}
// Resume a browser-driven local pull after a reload: re-POST /api/pull for the
// persisted model (Ollama resumes from cached layers and re-streams progress).
// No-op if a pull is already active (server or local) or no pull was in flight.
function resumeLocalPull(){
  if(pullMode || activePullAbort) return;
  const model=loadLocalPullName();
  if(!model) return;
  startLocalPull(model);
}

function renderPullStatus(job){
  const ps=$("pullStatus"); ps.classList.remove("hidden"); ps.innerHTML="";
  const top=document.createElement("div"); top.className="pull-top";
  const label=document.createElement("div"); label.className="pull-label";
  label.innerHTML=icon("download",15)+`<span>Downloading <b>${escapeHtml(job.model||"")}</b></span>`;
  const cancel=document.createElement("button"); cancel.className="pull-cancel"; cancel.textContent="Cancel";
  cancel.addEventListener("click",()=>cancelPull(job.jobId));
  top.appendChild(label); top.appendChild(cancel);
  const wrap=document.createElement("div"); wrap.className="bar-wrap";
  const bar=document.createElement("div"); bar.className="bar";
  const fill=document.createElement("div"); fill.className="bar-fill"; fill.style.width=(job.percent||0)+"%";
  bar.appendChild(fill);
  const m=document.createElement("div"); m.className="bar-meta";
  const phase=document.createElement("span"); phase.className="pull-phase"; phase.textContent=prettyPhase(job.phase||job.status||"queued");
  const bytes=document.createElement("span"); bytes.className="pull-bytes"; bytes.textContent=fmtPullBytes(job.completed, job.total);
  m.appendChild(phase); m.appendChild(bytes);
  wrap.appendChild(bar); wrap.appendChild(m);
  ps.appendChild(top); ps.appendChild(wrap);
  pullEls={fill, phase, bytes, cancel};
}

function tailPull(jobId){
  if(pullES){ pullES.close(); pullES=null; }
  let closed=false;
  const es=new EventSource("/api/models/pull/"+encodeURIComponent(jobId)+"/events");
  pullES=es;
  es.addEventListener("reset", e=>{ let s={}; try{s=JSON.parse(e.data)}catch{}; if(pullEls){ pullEls.fill.style.width=(s.percent||0)+"%"; pullEls.phase.textContent=prettyPhase(s.phase||s.status||""); pullEls.bytes.textContent=fmtPullBytes(s.completed,s.total); } });
  es.addEventListener("phase", e=>{ if(pullEls) pullEls.phase.textContent=prettyPhase(e.data); });
  es.addEventListener("progress", e=>{ let p={}; try{p=JSON.parse(e.data)}catch{}; if(pullEls){ pullEls.fill.style.width=(p.percent||0)+"%"; pullEls.bytes.textContent=fmtPullBytes(p.completed,p.total); } });
  es.addEventListener("done", ()=>{ closed=true; es.close(); pullES=null; onPullDone(); });
  es.addEventListener("joberror", e=>{ closed=true; es.close(); pullES=null; let m=e.data; try{m=JSON.parse(e.data)}catch{}; onPullError(m); });
  es.onerror=()=>{ if(closed) return; }; // transport drop: EventSource auto-reconnects; reset re-anchors
}

async function onPullDone(){
  if(pullEls){ pullEls.fill.style.width="100%"; pullEls.phase.textContent="Installed ✓ — benchmarked"; pullEls.cancel.disabled=true; }
  pullMode=null;
  setTimeout(async ()=>{
    $("pullStatus").classList.add("hidden"); pullEls=null;
    await loadModels();                              // refresh the header selector (benchmark now persisted)
    await switchTab(modelsTab);                      // re-render current tab (marks installed + shows tok/s)
  }, 1100);
}

function onPullError(msg){
  pullMode=null;
  if(pullEls) pullEls.phase.textContent="Error";
  flashError(String(msg||"pull failed"));
}

async function cancelPull(jobId){
  // A local (browser-driven) pull has no backend job to cancel — abort the fetch.
  if(pullMode==="local" && activePullAbort){ saveLocalPullName(null); activePullAbort.abort(); return; }
  try{ await fetchRetry("/api/models/pull/"+encodeURIComponent(jobId)+"/cancel",{method:"POST"},{label:"Cancel pull"}); }catch{}
}
// --- Per-model actions ------------------------------------------------------
function useModel(name){
  selectedModel=name; localStorage.setItem("nas-llm-model", selectedModel);
  syncVision(); renderModels(); enforceToolGating();
  if(activeId) saveModelSelection();   // model-only PATCH; safe during generation
  // Land on the installed list with the new pick highlighted; keep the panel
  // open so the selection is visible (instead of closing the drawer).
  renderModelBanner();
  if(modelsTab!=="installed") switchTab("installed");
  else updateRowSelection();
}

// Transient inline error note at the top of the models panel (replaces alert).
function flashError(text){
  const body=$("tabBody");
  if(!body) return;
  const note=document.createElement("div"); note.className="err-note";
  note.textContent=String(text||"error");
  body.prepend(note);
  setTimeout(()=>note.remove(), 6000);
}

async function toggleDetails(name, card){
  let det=card.querySelector(".mcard-details");
  if(det){ det.remove(); return; }
  det=document.createElement("div"); det.className="mcard-details muted"; det.textContent="Loading…";
  card.appendChild(det);
  try{
    const r=await fetchRetry("/api/models/"+encodeURIComponent(name)+"/info",{},{label:"Model info"});
    const j=await r.json().catch(()=>({}));
    if(!r.ok){ det.textContent=j.error||"Could not load details"; return; }
    det.replaceChildren();
    const caps=document.createElement("div"); caps.className="badges";
    (j.capabilities||[]).forEach(c=>caps.appendChild(badge(capLabel(c),"cap")));
    if(caps.childNodes.length) det.appendChild(caps);
    const facts=document.createElement("div"); facts.className="details-facts";
    const rows=[["Context", `${(j.contextLength||0).toLocaleString()} tok`],["RAM fit", `${(j.ramUsedGB||0).toFixed(1)} / ${(j.availableGB||0).toFixed(1)} GB`],["KV cache", `${(j.kvCacheGB||0).toFixed(2)} GB`]];
    if(j.details&&j.details.parameter_size) rows.push(["Params", j.details.parameter_size]);
    if(j.details&&j.details.quantization_level) rows.push(["Quant", j.details.quantization_level]);
    rows.forEach(([k,v])=>{ const row=document.createElement("div"); const kk=document.createElement("span"); kk.textContent=k; const vv=document.createElement("span"); vv.textContent=String(v); row.appendChild(kk); row.appendChild(vv); facts.appendChild(row); });
    det.appendChild(facts);
    if(j.fit) det.appendChild(badge(j.fit==="fits"?"Fits this NAS":j.fit==="tight"?"Tight — shorten context":"Won't fit", j.fit==="fits"?"fit-good":j.fit==="tight"?"fit-tight":"fit-bad"));
  }catch(e){ det.textContent=errText(e); }
}

// --- Small panel helpers ----------------------------------------------------
function badge(label, cls){ const b=document.createElement("span"); b.className="badge "+(cls||""); b.textContent=label; return b; }
function mutedNote(text){ const d=document.createElement("div"); d.className="muted"; d.textContent=text; return d; }
function capLabel(c){ return {completion:"chat",tools:"tools",vision:"vision",thinking:"thinking",embedding:"embeddings"}[c]||c; }
// A .badges row of capability badges (tools/vision/thinking/embeddings) for a
// model card. "completion" is universal so it's skipped. Returns null when the
// model has no displayable caps (so callers can avoid an empty row).
function capBadges(caps){
  const d=document.createElement("div"); d.className="badges";
  (caps||[]).forEach(c=>{ if(c==="completion") return; const b=badge(capLabel(c),"cap"); d.appendChild(b); });
  return d.childNodes.length ? d : null;
}
function fmtPullBytes(completed, total){ if(!total) return ""; return `${(completed/1e9).toFixed(2)} / ${(total/1e9).toFixed(2)} GB`; }
function prettyPhase(p){ const m={queued:"Queued…","pulling manifest":"Pulling manifest…","verifying sha256 digest":"Verifying…","writing manifest":"Writing manifest…","removing any unused layers":"Cleaning up…",success:"Downloaded — benchmarking…",pulling:"Pulling…",benchmarking:"Benchmarking…"}; return m[p]||p; }
function fitBadge(v){
  const cls=v.fit==="fits"?"fit-good":v.fit==="tight"?"fit-tight":"fit-bad";
  const label=v.fit==="fits"?"Fits":v.fit==="tight"?"Tight":"Won't fit";
  return badge(`${label} · ~${(v.ramUsedGB||0).toFixed(1)}/${(v.availableGB||0).toFixed(1)} GB`, cls);
}
function speedBadge(m, v){
  const lo=(m.estTokPerSec&&m.estTokPerSec[0])||0, hi=(m.estTokPerSec&&m.estTokPerSec[1])||0;
  if(lo<=0 && hi<=0) return badge("est. speed n/a", "");
  const cls=v.speed==="fast"?"speed-fast":v.speed==="usable"?"speed-ok":"speed-slow";
  return badge(`≈ ${lo}–${hi} tok/s`, cls);
}

// --- Preflight (registry size + fit before download) -----------------------
// preflightModel fetches /api/models/preflight?model=&host= once per name|host
// and caches the parsed JSON so repeated card renders / menu opens don't
// refetch. Returns the response, or null on any failure (the UI fails silently
// — no badge, or a muted "size unknown"). A 404 (tag not in the registry) is
// cached as null so a re-render doesn't re-hammer the registry; transient
// 502/network errors are NOT cached so a later render can retry.
const preflightCache = new Map();
async function preflightModel(name, host){
  if(!name) return null;
  const key = name + "|" + (host || "auto");
  if(preflightCache.has(key)) return preflightCache.get(key);
  try{
    const url = "/api/models/preflight?model=" + encodeURIComponent(name) + "&host=" + encodeURIComponent(host || "auto");
    const r = await fetchRetry(url, {}, {label:"Preflight"});
    const j = await r.json();
    if(!j || j.error){ preflightCache.set(key, null); return null; }
    preflightCache.set(key, j);
    return j;
  }catch(e){
    if(e && e.status === 404) preflightCache.set(key, null);   // unknown tag — won't come back
    return null;
  }
}

// Visitor's local RAM budget (GB) for in-browser Local-target fit estimates.
// The backend can't know the visitor's RAM, so host=local returns a null fit and
// we compute a rough verdict client-side against this budget.
let localRamGB = loadLocalRamGB();
function loadLocalRamGB(){ const v = parseFloat(localStorage.getItem("nas-llm-local-ram-gb")); return v > 0 ? v : 16; }
function saveLocalRamGB(){ localStorage.setItem("nas-llm-local-ram-gb", String(localRamGB)); }

// Rough client-side local fit, mirroring the backend's reserve logic: weights
// must fit under the budget with a ~1.5 GB OS/context reserve. Returns
// "fits" | "tight" | "no", or null when no size is known.
function localFitFor(pf){
  if(!pf) return null;
  const w = pf.weightsGB != null ? pf.weightsGB : pf.downloadGB;
  if(w == null || w <= 0) return null;
  if(w <= localRamGB - 1.5) return "fits";
  if(w <= localRamGB) return "tight";
  return "no";
}

// Resolve a fit verdict {cls,label} for a preflight response. Uses the
// backend's fit for nas/mac; for host=local (or a null fit) falls back to the
// client-side local-budget verdict. Returns null when there's nothing to show.
function preflightFitLabel(pf){
  if(!pf) return null;
  const host = pf.host;
  if(host === "local" || pf.fit == null){
    const lf = localFitFor(pf);
    if(!lf) return null;
    return { cls: lf === "fits" ? "fit-good" : lf === "tight" ? "fit-tight" : "fit-bad",
             label: lf === "fits" ? "Fits local" : lf === "tight" ? "Tight local" : "Won't fit local" };
  }
  const cls = pf.fit === "fits" ? "fit-good" : pf.fit === "tight" ? "fit-tight" : "fit-bad";
  const hn = host === "nas" ? "NAS" : host === "mac" ? "Mac" : (hostLabel(host) || "NAS");
  const label = pf.fit === "fits" ? "Fits " + hn : pf.fit === "tight" ? "Tight — shorten context" : "Won't fit " + hn;
  return { cls, label };
}

// Build a compact preflight badge: download icon + real download GB, plus an
// optional colored fit verdict. showFit=false (cataloged browse cards) shows
// only the GB alongside the curated fitBadge; showFit=true (library cards and
// the download menu) appends the fit verdict. The response is retained on the
// element (_pf/_showFit) so a local-RAM-budget change can refresh just the fit.
function preflightBadgeEl(pf, showFit){
  if(!pf || pf.error || pf.downloadGB == null) return null;
  const b = document.createElement("span");
  b.className = "preflight-badge";
  b.innerHTML = icon("download", 12);
  const gb = document.createElement("span"); gb.className = "pf-gb";
  gb.textContent = pf.downloadGB.toFixed(1) + " GB";
  b.appendChild(gb);
  b._pf = pf; b._showFit = !!showFit;
  if(!showFit) return b;
  const fit = preflightFitLabel(pf);
  if(fit){ const f = document.createElement("span"); f.className = "pf-fit " + fit.cls; f.textContent = fit.label; b.appendChild(f); }
  return b;
}

// Lazy-append a preflight badge into a card already in the DOM. Mirrors the
// ensureCaps -> refreshRowBadges pattern: find the card by its stable
// data-preflight attribute (tolerating re-renders / filters), append into the
// .mcard-meta or .badges row, and skip if a badge is already present or the
// card was filtered away. Fails silently when the endpoint is absent.
function attachPreflightBadge(containerEl, name, host, showFit){
  preflightModel(name, host).then(pf=>{
    if(!pf) return;
    const card = containerEl && containerEl.querySelector('[data-preflight="' + name + '"]');
    if(!card || card.querySelector(".preflight-badge")) return;
    const meta = card.querySelector(".mcard-meta") || card.querySelector(".badges");
    if(!meta) return;
    const b = preflightBadgeEl(pf, showFit);
    if(b) meta.appendChild(b);
  });
}

// Re-attach preflight badges to the current library cards when the download
// target changes (avoids refetching the library search — preflight is cached).
function reattachLibraryPreflight(){
  const list = $("browseLibList"); if(!list) return;
  list.querySelectorAll(".preflight-badge").forEach(b=>b.remove());
  list.querySelectorAll("[data-preflight]").forEach(card=>{
    attachPreflightBadge(list, card.dataset.preflight, pullTarget, true);
  });
}

// Re-compute Local-budget fit badges when the visitor's RAM budget changes.
// Only badges that depend on the local budget (host=local or null fit) and were
// showing a fit are touched; cataloged browse badges (GB only) are unaffected.
function refreshLocalPreflightBadges(){
  document.querySelectorAll(".preflight-badge").forEach(b=>{
    const pf = b._pf; if(!pf || !b._showFit) return;
    if(pf.host !== "local" && pf.fit != null) return;
    const old = b.querySelector(".pf-fit"); if(old) old.remove();
    const fit = preflightFitLabel(pf); if(!fit) return;
    const f = document.createElement("span"); f.className = "pf-fit " + fit.cls; f.textContent = fit.label;
    b.appendChild(f);
  });
}

// --- Agent settings (global system prompt + tool allowlist) ----------------
const agentModal=$("agentModal"), agentSystem=$("agentSystem"), agentToolsBox=$("agentTools"), agentSaved=$("agentSaved"), agentAutoApproveBox=$("agentAutoApprove"), agentAutoApproveRow=$("agentAutoApproveRow");
let agentAvailable=[];      // [{name,label,description}] from the server
let agentSelectedTools=null; // null = not yet loaded; the checkbox set mirrors this
if (agentAutoApproveBox) agentAutoApproveBox.addEventListener("change",()=>{ if(agentAutoApproveRow) agentAutoApproveRow.classList.toggle("on", agentAutoApproveBox.checked); });
$("closeAgent").addEventListener("click", closeAgentPanel);
agentModal.addEventListener("click", e=>{ if(e.target===agentModal) closeAgentPanel(); });
document.addEventListener("keydown", e=>{ if(e.key==="Escape" && agentModal.classList.contains("open")) closeAgentPanel(); });
function openAgentPanel(){ agentModal.classList.add("open"); loadAgentConfig(); }
function closeAgentPanel(){ agentModal.classList.remove("open"); }
async function loadAgentConfig(){
  try{
    const r=await fetchRetry("/api/agent/config",{},{label:"Agent config"});
    const j=await r.json();
    agentAvailable=j.available||[];
    agentSystem.value=j.system||"";
    const selected=new Set(j.tools||[]);
    agentSelectedTools=selected;
    renderAgentTools();
    if(agentAutoApproveBox){ agentAutoApproveBox.checked=!!j.autoApprove; if(agentAutoApproveRow) agentAutoApproveRow.classList.toggle("on", !!j.autoApprove); }
  }catch(e){ /* leave panel empty */ }
}
function renderAgentTools(){
  agentToolsBox.innerHTML="";
  agentAvailable.forEach(t=>{
    const id="agt-"+t.name;
    const on=agentSelectedTools && agentSelectedTools.has(t.name);
    const lbl=document.createElement("label"); lbl.className="agent-tool"+(on?" on":"");
    lbl.htmlFor=id;
    const cb=document.createElement("input"); cb.type="checkbox"; cb.id=id; cb.checked=!!on;
    cb.addEventListener("change",()=>{
      if(!agentSelectedTools) agentSelectedTools=new Set();
      if(cb.checked) agentSelectedTools.add(t.name); else agentSelectedTools.delete(t.name);
      lbl.classList.toggle("on", cb.checked);
    });
    const txt=document.createElement("span"); txt.className="agent-tool-text";
    txt.innerHTML='<b>'+escapeHtml(t.label)+'</b><span class="muted">'+escapeHtml(t.description)+'</span>';
    lbl.appendChild(cb); lbl.appendChild(txt);
    agentToolsBox.appendChild(lbl);
  });
}
$("saveAgent").addEventListener("click", async ()=>{
  const system=agentSystem.value||"";
  const tools=agentSelectedTools?[...agentSelectedTools]:[];
  const body={system,tools};
  if(agentAutoApproveBox) body.autoApprove=!!agentAutoApproveBox.checked;
  try{
    await fetchRetry("/api/agent/config",{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)},{label:"Save agent config"});
    agentSaved.classList.remove("hidden");
    setTimeout(()=>agentSaved.classList.add("hidden"), 1500);
  }catch(e){ flashAgentErr(String(e.message||e)); }
});
function flashAgentErr(msg){
  const saved=agentSaved; saved.classList.remove("hidden"); saved.classList.add("err-note"); saved.textContent=String(msg||"save failed");
  setTimeout(()=>{ saved.classList.add("hidden"); saved.classList.remove("err-note"); saved.textContent="Saved."; }, 4000);
}

// --- Slash commands (input command palette) --------------------------------
// Typing "/" in the input opens a filtered list of commands; arrow keys / mouse
// navigate, Enter runs, Tab completes. Commands map to existing actions — no
// backend changes. A "/name ..." line sent via Enter also runs (so the popup
// isn't required); unknown /-prefixed text falls through and sends normally.
const PLAN_TEMPLATE = `Produce a concise, step-by-step plan for the following task. Break it into ordered phases, note assumptions, and call out risks or open questions.

Task: {task}

Plan:`;
const COMMANDS = [
  { name:"clear", aliases:["new"], desc:"Start a new chat", icon:"new-chat", args:false, run(){ newChat(); } },
  { name:"delete", desc:"Delete this conversation", icon:"trash", args:false, run(){ if(activeId) confirmSlash("Delete this conversation?", null, ()=>deleteConversation(activeId)); else slashNote("No active chat to delete."); } },
  { name:"rename", desc:"Rename this conversation", icon:"rename", args:true, run(a){ if(!activeId){ slashNote("No active chat to rename."); return; } const t=(a||"").trim(); if(!t){ slashNote("Usage: /rename <title>"); return; } renameActiveTo(t); } },
  { name:"stop", desc:"Stop the active generation", icon:"stop", args:false, run(){ stopActive(); } },
  { name:"web", desc:"Toggle Web search mode", icon:"globe", args:false, run(){ toggleExtra("web"); } },
  { name:"clarify", desc:"Toggle Clarify mode", icon:"help", args:false, run(){ toggleExtra("clarify"); } },
  { name:"agent", desc:"Toggle Agent mode", icon:"sparkles", args:false, run(){ toggleExtra("agent"); } },
  { name:"models", desc:"Open the model picker", icon:"boxes", args:false, run(){ openModelsPanel("installed"); } },
  { name:"model", desc:"Pick a model", icon:"chevron-down", args:false, run(){ openModelsPanel("installed"); } },
  { name:"agent-settings", desc:"Open Agent settings", icon:"wrench", args:false, run(){ openAgentPanel(); } },
  { name:"plan", desc:"Pre-fill a planning prompt", icon:"sparkles", args:true, run(a){ const task=(a||"").trim(); if(!task){ slashNote("Usage: /plan <task>"); return; } input.value=PLAN_TEMPLATE.replace("{task}", task); autosize(); closeSlashPopup(); input.focus(); } },
  { name:"logout", desc:"Sign out", icon:"logout", args:false, run(){ logout(); } },
  { name:"help", desc:"Show available commands", icon:"help", args:false, run(){ renderSlashItems(COMMANDS); } },
];
let slashItems=[], slashSelected=0;
function slashPopupOpen(){ return !slashPopup.classList.contains("hidden"); }
function closeSlashPopup(){ slashPopup.classList.add("hidden"); }
function findCommand(name){ return COMMANDS.find(c=>c.name===name||(c.aliases||[]).includes(name))||null; }
function argHint(name){ return {rename:"<title>", plan:"<task>"}[name]||"<args>"; }
// Parse a "/name args" line. Returns {name,args} or null when it isn't a slash
// line. args is everything after the first space (trimmed); a bare "/" yields
// null so it isn't treated as a command.
function parseSlash(text){
  const t=(text||"").trim();
  if(!t.startsWith("/")) return null;
  const body=t.slice(1);
  if(!body) return null;
  const sp=body.indexOf(" ");
  return { name:(sp===-1?body:body.slice(0,sp)).toLowerCase(), args: sp===-1?"":body.slice(sp+1).trim() };
}
function renderSlashItems(list){
  slashItems=list; slashSelected=0;
  slashPopup.replaceChildren();
  if(!list.length){
    const n=document.createElement("div"); n.className="slash-item"; n.style.cursor="default"; n.style.color="var(--muted)";
    n.textContent="No matching commands"; slashPopup.appendChild(n);
    slashPopup.classList.remove("hidden"); return;
  }
  list.forEach((c,i)=>{
    const b=document.createElement("button"); b.type="button"; b.className="slash-item"+(i===0?" selected":""); b.setAttribute("role","option");
    b.innerHTML=icon(c.icon,16);
    const txt=document.createElement("span"); txt.className="slash-item-text";
    const nm=document.createElement("span"); nm.className="slash-item-name"; nm.textContent="/"+c.name;
    const ds=document.createElement("span"); ds.className="slash-item-desc"; ds.textContent=c.desc;
    txt.appendChild(nm); txt.appendChild(ds); b.appendChild(txt);
    if(["web","clarify","agent"].includes(c.name)) b.classList.toggle("on", activeExtras.has(c.name));
    b.addEventListener("mouseenter",()=>{ slashSelected=i; markSlashSelected(); });
    b.addEventListener("click",e=>{ e.stopPropagation(); e.preventDefault(); runSlashIndex(i); });
    slashPopup.appendChild(b);
  });
  slashPopup.classList.remove("hidden");
}
function markSlashSelected(){
  const items=[...slashPopup.querySelectorAll(".slash-item")];
  items.forEach((el,i)=>el.classList.toggle("selected", i===slashSelected));
  const sel=items[slashSelected];
  if(sel && sel.scrollIntoView) sel.scrollIntoView({block:"nearest"});
}
// Surface the list only while the first line is a "/token" with no space yet
// (once args start, the command is determined and suggestions hide).
function updateSlashPopup(){
  const v=input.value;
  if(v.startsWith("/") && v.indexOf("\n")===-1 && v.indexOf(" ")===-1){
    const token=v.slice(1).toLowerCase();
    renderSlashItems(COMMANDS.filter(c=>c.name.includes(token)||(c.aliases||[]).some(a=>a.includes(token))));
  } else {
    closeSlashPopup();
  }
}
// Complete the selected command into the input (Tab). No-arg commands run at
// once; arg commands expand to "/name " so the user can type the argument.
function completeSlash(){
  const c=slashItems[slashSelected]; if(!c){ closeSlashPopup(); return; }
  if(c.args){ input.value="/"+c.name+" "; autosize(); closeSlashPopup(); input.focus(); }
  else { input.value="/"+c.name; runCommand(c,""); }
}
// Run the command at a popup index. For arg commands without args typed yet,
// expand to "/name " for the user to fill in instead of erroring.
function runSlashIndex(i){
  const c=slashItems[i]; if(!c){ closeSlashPopup(); return; }
  const v=input.value, sp=v.indexOf(" ");
  if(c.args && sp===-1){ input.value="/"+c.name+" "; autosize(); closeSlashPopup(); input.focus(); return; }
  runCommand(c, c.args ? v.slice(sp+1) : "");
}
// Execute a command: clear the input, close the popup, run, then refocus the
// composer unless a modal took over the view.
function runCommand(c, args){
  input.value=""; autosize(); closeSlashPopup();
  try{ c.run(args); }catch(err){ slashNote(String(err&&err.message||err)); }
  if($("modelsModal").classList.contains("open")||agentModal.classList.contains("open")) return;
  input.focus();
}
// Toggle a tool mode (web/clarify/agent) with the same gating + exclusivity as
// the + menu: blocked when the model lacks tool support, mutually exclusive.
function toggleExtra(id){
  const def=EXTRA_DEFS.find(d=>d.id===id); if(!def) return;
  if(def.needsTools && modelSupportsTools(selectedModel)!==true){
    slashNote(selectedModel+" has no tool support — use a tool-capable model for "+def.label+"."); return;
  }
  if(activeExtras.has(id)){ activeExtras.delete(id); slashNote(def.label+" off"); }
  else { activeExtras.add(id); (def.exclusive||[]).forEach(x=>activeExtras.delete(x)); slashNote(def.label+" on"); }
  saveExtras(); renderExtras();
}
async function renameActiveTo(title){
  if(!activeId) return;
  try{ await fetchRetry("/api/conversations/"+encodeURIComponent(activeId),{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({title})},{label:"Rename chat"}); await loadConversations(); slashNote("Renamed to \""+title+"\""); }
  catch(e){ slashNote("Rename failed: "+errText(e)); }
}
// Small floating confirm anchored above the input (replaces native confirm(),
// which the browser can block — same reason openConvMenu uses confirmInMenu).
function confirmSlash(message, sub, onConfirm){
  closeMenu();
  const m=document.createElement("div"); m.className="menu"; document.body.appendChild(m);
  const msg=document.createElement("div"); msg.className="menu-msg"; msg.textContent=message; m.appendChild(msg);
  if(sub){ const s=document.createElement("div"); s.className="menu-sub muted"; s.textContent=sub; m.appendChild(s); }
  const sep=document.createElement("div"); sep.className="sep"; m.appendChild(sep);
  const cancel=document.createElement("button"); cancel.textContent="Cancel";
  cancel.addEventListener("click",e=>{ e.stopPropagation(); closeMenu(); input.focus(); });
  const ok=document.createElement("button"); ok.className="danger"; ok.textContent="Delete";
  ok.addEventListener("click",e=>{ e.stopPropagation(); closeMenu(); onConfirm(); });
  m.appendChild(cancel); m.appendChild(ok);
  const r=input.getBoundingClientRect();
  m.style.left=Math.min(r.left, window.innerWidth-m.offsetWidth-8)+"px";
  m.style.top=Math.max(8, r.top-m.offsetHeight-4)+"px";
  openMenu=m;
  setTimeout(()=>document.addEventListener("click",closeMenu),0);
}
let slashNoteTimer=null;
function slashNote(text){
  let el=document.getElementById("slashNote");
  if(!el){ el=document.createElement("div"); el.id="slashNote"; el.className="slash-note"; document.body.appendChild(el); }
  el.textContent=String(text||"");
  el.classList.add("show");
  if(slashNoteTimer) clearTimeout(slashNoteTimer);
  slashNoteTimer=setTimeout(()=>el.classList.remove("show"), 2600);
}
document.addEventListener("click", e=>{ if(slashPopupOpen() && !slashPopup.contains(e.target) && e.target!==input) closeSlashPopup(); });
document.addEventListener("keydown", e=>{ if(e.key==="Escape" && slashPopupOpen()) closeSlashPopup(); });

boot();

