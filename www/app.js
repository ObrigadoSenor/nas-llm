// nas-llm chat UI — app logic, split out of the old single-file index.html.
// Imports UI helpers (icons, markdown rendering) from lib.js. No build step.
import { icon, setIcon, renderMessage, escapeHtml, StreamRenderer, thinkingDots, renderSearchBlock, appendSearchEntry, showSearchPending, clearSearchPending, renderSourceLinks, appendSourceLinks, renderClarifyCard, renderAgentSteps, appendAgentStep, buildThoughtsWrap, renderThoughts, appendThought, setThoughtsSummary } from './lib.js?v=27';

const $ = id => document.getElementById(id);
const app=$("app"), loginView=$("login");
const chat=$("chat"), input=$("input"), send=$("send"), modelBtn=$("modelBtn"), modelPopup=$("modelPopup");
const convList=$("convList"), whoEmail=$("whoEmail");
const chatTitle=$("chatTitle"), chatMeta=$("chatMeta");
const loginEmail=$("loginEmail"), loginBtn=$("loginBtn"), loginInfo=$("loginInfo");
const sidebar=$("sidebar"), scrim=$("scrim"), menuBtn=$("menuBtn"), closeSide=$("closeSide");
const plusBtn=$("plusBtn"), plusPopup=$("plusPopup"), pills=$("pills");
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
setIcon($("manageModels"), "boxes", 16); $("manageModels").setAttribute("aria-label", "Manage models");
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
  { id:"web", label:"Web search", icon:"globe", exclusive:["clarify","agent"] },
  { id:"clarify", label:"Clarify", icon:"help", exclusive:["web","agent"] },
  { id:"agent", label:"Agent", icon:"sparkles", exclusive:["web","clarify"] },
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
let activeLocalAbort = null;           // AbortController for the in-flight localhost inference
let localDiscoverMsg = null;           // last discovery error string (shown in the Local section)
function loadLocalModelNames(){ try{ return JSON.parse(localStorage.getItem("nas-llm-local-models")||"[]")||[]; }catch{ return []; } }
function saveLocalModelNames(){ localStorage.setItem("nas-llm-local-models", JSON.stringify(localModelNames)); }
function isLocalModel(name){ return localModelNames.includes(name); }
function hostLabel(h){ return {nas:"NAS",mac:"Mac"}[h]||h; }
// Merge server models (from /api/models, carrying host/hostOnline) with the
// local set. Dedupe by name: if a name is both local and on a server host,
// keep the Local entry and drop the server duplicate. Ordered NAS, Mac, Local.
function buildModelEntries(serverData, localNames){
  const localSet=new Set(localNames);
  const entries=[]; const seen=new Set();
  for(const m of serverData){
    const name=m.name||m.id; if(!name) continue;
    if(localSet.has(name)) continue;        // local wins -> drop server duplicate
    if(seen.has(name)) continue; seen.add(name);
    const b=m.benchmark;                     // measured tok/s from the last benchmark run
    const tps = b && typeof b.tokPerSec==="number" ? b.tokPerSec : null;
    entries.push({name, host:m.host||"nas", hostOnline:m.hostOnline!==false, local:false, tokPerSec:tps});
  }
  for(const n of localNames){ if(seen.has(n)) continue; seen.add(n); entries.push({name:n, host:"local", hostOnline:true, local:true, tokPerSec:null}); }
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
  EXTRA_DEFS.forEach(def=>{
    const on=activeExtras.has(def.id);
    const b=document.createElement("button"); b.type="button"; b.className="plus-item"+(on?" on":"");
    b.setAttribute("role","menuitemcheckbox"); b.setAttribute("aria-checked",String(on));
    b.innerHTML=icon(def.icon,16)+'<span>'+escapeHtml(def.label)+'</span>'+(on?icon("check",14):'');
    b.addEventListener("click",e=>{ e.stopPropagation(); if(activeExtras.has(def.id)){ activeExtras.delete(def.id); } else { activeExtras.add(def.id); (def.exclusive||[]).forEach(x=>activeExtras.delete(x)); } saveExtras(); renderExtras(); });
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
  try{
    const r=await fetchRetry("/api/models/"+encodeURIComponent(name)+"/info",{},{label:"Model info"});
    if(!r.ok) return;
    const j=await r.json();
    modelCaps.set(name, j.capabilities||[]);
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
  send.disabled=true;
  // For a local-model job, abort the in-flight localhost inference immediately
  // so Stop is responsive — don't wait for the SSE "done" round-trip. The
  // backend /cancel still finalizes the connection-bound job.
  if(activeLocalAbort){ activeLocalAbort.abort(); activeLocalAbort=null; }
  try{ await fetch("/api/conversations/"+encodeURIComponent(activeId)+"/cancel",{method:"POST"}); }catch{}
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
  await loadConversations();
  await loadActiveJobs();
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
    modelEntries=buildModelEntries(lastServerModels, localModelNames);
    models=modelEntries.map(e=>e.name);
    syncSelectedFromEntries();
    renderModels();
    syncVision();
    prefetchCaps();
  }catch(e){ renderModels(); modelBtn.title=String(e.message||e); }
}
// Re-probe localhost on boot/showApp so a reload reattaches the visitor's
// local Ollama models without making them click Connect again. Silent on
// failure: the persisted name list still seeds the selector, and no error is
// surfaced (the user didn't ask to connect this session).
async function reattachLocalModels(){
  const res=await discoverLocalModels();
  if(res.ok){ localModels=res.models; localModelNames=res.models.map(m=>m.name); saveLocalModelNames(); }
  modelEntries=buildModelEntries(lastServerModels, localModelNames);
  models=modelEntries.map(e=>e.name);
  syncSelectedFromEntries();
  renderModels();
  prefetchCaps();
  if($("modelsModal").classList.contains("open") && modelsTab==="installed") renderInstalledTab();
}
// Discover the visitor's local Ollama (localhost:11434). An HTTPS page makes
// the fetch trigger Chrome's Local Network Access prompt (the "accept" UX).
// 403 = Ollama is running but rejected the cross-origin request (needs
// OLLAMA_ORIGINS); a throw = nothing is listening on 11434.
async function discoverLocalModels(){
  let r;
  try{ r=await fetch("http://localhost:11434/api/tags"); }
  catch{ return {ok:false, kind:"refused"}; }
  if(r.status===403) return {ok:false, kind:"origins"};
  if(!r.ok) return {ok:false, kind:"http", status:r.status};
  let j; try{ j=await r.json(); }catch{ return {ok:false, kind:"http", status:r.status}; }
  const mods=(j.models||[]).map(m=>({name:m.name, sizeGB:m.size?m.size/1e9:0, details:m.details||{}}));
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
function buildModelRow(e){
  const row=document.createElement("button");
  row.type="button"; row.className="model-row"; row.setAttribute("role","option");
  row.dataset.name=e.name;
  row.setAttribute("aria-selected", String(e.name===selectedModel));
  if(e.name===selectedModel) row.classList.add("selected");
  if(!e.hostOnline){ row.classList.add("offline"); row.disabled=true; }
  const name=document.createElement("span"); name.className="model-row-name"; name.textContent=e.name;
  row.appendChild(name);
  const badges=document.createElement("span"); badges.className="model-row-badges";
  badges.appendChild(hostBadge(e.host));
  const sp=speedBadgeFor(e.tokPerSec); if(sp) badges.appendChild(sp);
  for(const c of modelCapsFor(e.name)){ const cb=capBadge(c); if(cb) badges.appendChild(cb); }
  row.appendChild(badges);
  if(e.hostOnline) row.addEventListener("click",()=>chooseModel(e.name));
  return row;
}
// Refresh one row's badges after its capabilities finish loading (keeps the
// popup's scroll/selection intact instead of a full re-render).
function refreshRowBadges(name){
  const row=modelPopup.querySelector('.model-row[data-name="'+name+'"]');
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
  // Popup: grouped sections (NAS / Mac / Local).
  modelPopup.replaceChildren();
  const groups={};
  for(const e of modelEntries){ (groups[e.host]=groups[e.host]||[]).push(e); }
  const labels={nas:"NAS", mac:"Mac", local:"Local (this computer)"};
  for(const h of ["nas","mac","local"]){
    const arr=groups[h]; if(!arr||!arr.length) continue;
    const g=document.createElement("div"); g.className="model-group";
    const gl=document.createElement("div"); gl.className="model-group-label"; gl.textContent=labels[h]||h;
    g.appendChild(gl);
    for(const e of arr) g.appendChild(buildModelRow(e));
    modelPopup.appendChild(g);
  }
}
function setModelPopup(open){
  modelPopup.classList.toggle("hidden", !open);
  modelBtn.classList.toggle("open", open);
  modelBtn.setAttribute("aria-expanded", String(open));
  if(open){
    const focusEl=modelPopup.querySelector(".model-row.selected:not(.offline)") || modelPopup.querySelector(".model-row:not(.offline)");
    if(focusEl) focusEl.focus();
  }
}
function chooseModel(name){
  selectedModel=name; localStorage.setItem("nas-llm-model", selectedModel);
  syncVision(); renderModels();
  // Don't overwrite messages while a background job is mid-generation for this
  // conversation — the job finalizes by appending to the stored messages, and a
  // PUT here (which lacks the in-flight assistant reply) would clobber it.
  if(activeId && !generatingIds.has(activeId)) saveConversation();
  setModelPopup(false); modelBtn.focus();
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
modelBtn.addEventListener("click", e=>{ e.stopPropagation(); setModelPopup(modelPopup.classList.contains("hidden")); });
document.addEventListener("click", e=>{ if(modelPopup.classList.contains("hidden")) return; if(!modelPopup.contains(e.target) && !modelBtn.contains(e.target)) setModelPopup(false); });
document.addEventListener("keydown", e=>{
  if(modelPopup.classList.contains("hidden")) return;
  if(e.key==="Escape"){ setModelPopup(false); modelBtn.focus(); return; }
  const rows=[...modelPopup.querySelectorAll(".model-row:not(.offline)")];
  if(!rows.length) return;
  const cur=modelPopup.querySelector(".model-row:focus");
  let idx=cur?rows.indexOf(cur):0;
  if(e.key==="ArrowDown"){ e.preventDefault(); idx=Math.min(rows.length-1, idx+1); rows[idx].focus(); }
  else if(e.key==="ArrowUp"){ e.preventDefault(); idx=Math.max(0, idx-1); rows[idx].focus(); }
  else if(e.key==="Enter"||e.key===" "){ e.preventDefault(); const r=cur||rows[0]; if(r) chooseModel(r.dataset.name); }
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
  const byFolder={};
  conversations.forEach(c=>{ const key=c.folderId||""; (byFolder[key]=byFolder[key]||[]).push(c); });
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
  const row=document.createElement("div"); row.className="conv"+(c.id===activeId?" active":"")+(generatingIds.has(c.id)?" generating":""); row.draggable=true;
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

function closeTail(){ if(activeLocalAbort){ activeLocalAbort.abort(); activeLocalAbort=null; } if(activeES){ activeES.close(); activeES=null; } }

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
  tailJob(id, bubble, hasQ ? "" : (job.content||""), searchWrap, srcLinks, job.questions||null, stepsWrap, job.steps||null, thoughtsWrap, thoughtsDet, job.thoughts||null);
}

// --- Local-model relay (browser -> visitor's Ollama, results back to NAS) ---
// On a `modelCall` SSE event the backend hands the browser the OpenAI
// chat-completions payload it would have sent to a server Ollama. The browser
// streams it to the visitor's localhost Ollama, paints content into the answer
// bubble via the same StreamRenderer as server-model chunks, then POSTs the
// assembled {content, tool_calls} back so the backend can continue the tool
// loop (web_search/clarify/agent) or finalize. `tools` is null for plain chat.
function localFetchErrMsg(){
  return "No Ollama found on this computer — install/start Ollama.";
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
async function relayLocalModelCall(convId, call, renderer, bubble, signal){
  const body={ model:call.model, messages:call.messages, stream:true };
  if(call.tools && call.tools.length) body.tools=call.tools;
  let resp;
  try{ resp=await fetch("http://localhost:11434/v1/chat/completions",{ method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body), signal }); }
  catch(e){ if(signal.aborted) return null; const msg=localFetchErrMsg(); bubbleError(bubble, msg); postModelResponse(convId, call.jobId, null, null, msg); return null; }
  if(!resp.ok){ const msg=localStatusErrMsg(resp.status); bubbleError(bubble, msg); postModelResponse(convId, call.jobId, null, null, msg); return null; }
  let content=""; const toolsByIndex=new Map();
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
        if(delta.content){ content+=delta.content; renderer.append(delta.content); }
        if(delta.tool_calls){
          for(const tc of delta.tool_calls){
            const i=tc.index??0;
            let cur=toolsByIndex.get(i);
            if(!cur){ cur={id:tc.id||null, type:tc.type||"function", function:{name:"", arguments:""}}; toolsByIndex.set(i,cur); }
            if(tc.id) cur.id=tc.id;
            if(tc.type) cur.type=tc.type;
            if(tc.function){ if(tc.function.name) cur.function.name+=tc.function.name; if(tc.function.arguments) cur.function.arguments+=tc.function.arguments; }
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
  const toolCalls=toolsByIndex.size?[...toolsByIndex.entries()].sort((a,b)=>a[0]-b[0]).map(([,v])=>v):null;
  return { content, toolCalls };
}

// tailJob opens an EventSource to /events and renders into bubble via a
// StreamRenderer (one markdown re-parse per animation frame). On reconnect the
// server sends a "reset" with the full prefix, which re-anchors acc so
// reconnects never double-count. A "questions" event (agent loop) swaps the
// bubble to a clickable option card and suspends the renderer so a queued
// flush can't wipe it. "done" reloads the conversation from the server
// (source of truth — the assistant reply is persisted there).
function tailJob(convId, bubble, initialAcc, searchWrap, srcLinks, initialClarify, stepsWrap, initialSteps, thoughtsWrap, thoughtsDet, initialThoughts){
  closeTail();
  const renderer = new StreamRenderer(bubble);
  const onAnswer=(value)=>sendClarifyAnswer(value, bubble);
  if(initialClarify){
    // Reattaching to a job that already reached a clarifying question: paint
    // the card now and freeze the renderer so a queued flush can't wipe it.
    renderer.suspend();
    renderClarifyCard(bubble, initialClarify, false, onAnswer);
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
  es.addEventListener("questions", e=>{ let q=null; try{ q=JSON.parse(e.data); }catch{} renderer.suspend(); renderClarifyCard(bubble, q, false, onAnswer); });
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
    const ctrl=new AbortController(); activeLocalAbort=ctrl;
    try{
      const res=await relayLocalModelCall(convId, d, renderer, bubble, ctrl.signal);
      if(res===null) return;                  // fetch failed or aborted: error shown / nothing to post
      await postModelResponse(convId, d.jobId, res.content, res.toolCalls);
    }catch(err){
      // Unexpected throw relayLocalModelCall didn't handle: finalize as an
      // error so the backend's connection-bound job doesn't hang.
      if(ctrl.signal.aborted) return;
      bubbleError(bubble, localFetchErrMsg());
      postModelResponse(convId, d.jobId, null, null, localFetchErrMsg());
    }finally{
      if(activeLocalAbort===ctrl) activeLocalAbort=null;
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
  es.addEventListener("done", ()=>{ esClosed=true; if(activeLocalAbort){ activeLocalAbort.abort(); activeLocalAbort=null; } es.close(); activeES=null; if(thoughtsDet){ if(thoughtStart){ const secs=((Date.now()-thoughtStart)/1000).toFixed(1); setThoughtsSummary(thoughtsDet,"Thought for "+secs+"s",{streaming:false}); } else setThoughtsSummary(thoughtsDet,"Thinking",{streaming:false}); thoughtsDet.open=false; } onGenerationDone(convId); });
  es.addEventListener("joberror", e=>{
    esClosed=true; if(activeLocalAbort){ activeLocalAbort.abort(); activeLocalAbort=null; } es.close(); activeES=null;
    let msg=e.data; try{ msg=JSON.parse(e.data); }catch{}
    const acc = renderer.acc;
    if(acc) renderer.finalize(acc);
    else bubbleError(bubble, msg);
    if(thoughtsDet){ setThoughtsSummary(thoughtsDet,"Thinking",{streaming:false}); thoughtsDet.open=false; } // collapse thinking on terminal
    generatingIds.delete(convId); renderSidebar();
    activeJobConvId=null; renderSend(); input.focus();
  });
  es.onerror=()=>{ if(esClosed) return; /* transport drop: EventSource auto-reconnects; reset re-anchors acc */ };
}

async function onGenerationDone(convId){
  generatingIds.delete(convId); activeJobConvId=null;
  if(convId===activeId){
    renderSend();
    // Reload from the server: the assistant reply is persisted there now.
    try{
      const r=await fetch("/api/conversations/"+encodeURIComponent(convId));
      if(r.ok){ const c=await r.json(); messages=c.messages||[]; rerenderChat(); updateHeader(); }
    }catch{}
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
async function saveConversation(){
  if(!activeId) return;
  const firstUser=messages.find(m=>m.role==="user");
  const title=firstUser ? titleFrom(firstUser.content) : "New chat";
  try{
    await fetch("/api/conversations/"+encodeURIComponent(activeId),{
      method:"PUT",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({title, model:selectedModel, messages})
    });
    await loadConversations();
  }catch{}
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

function addMsg(role, text, ts, searches, images, clarify, answered, steps, thoughts){
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
  // chips + copy icon) below. Left-aligned. The thinking/steps/search wraps
  // live outside the StreamRenderer's container so streaming re-parses never
  // wipe them; srcLinks is filled from searches or during stream.
  const { wrap: thoughtsWrap, det: thoughtsDet } = buildThoughtsWrap();
  if(thoughts && thoughts.length){
    // Persisted/reloaded reasoning: render collapsed with a static "Thinking"
    // label (no live timer). A live resume (resumeIfGenerating -> tailJob) flips
    // it open with the streaming summary; fresh live turns have no thoughts yet.
    renderThoughts(thoughtsWrap, thoughts);
    setThoughtsSummary(thoughtsDet,"Thinking",{streaming:false});
    if(thoughtsDet) thoughtsDet.open=false;
  } else thoughtsWrap.classList.add("hidden");
  d.appendChild(thoughtsWrap);
  let stepsWrap=document.createElement("div"); stepsWrap.className="msg-steps";
  if(steps && steps.length) renderAgentSteps(stepsWrap, steps);
  else stepsWrap.classList.add("hidden");
  d.appendChild(stepsWrap);
  let searchWrap=document.createElement("div"); searchWrap.className="msg-search";
  if(searches && searches.length) renderSearchBlock(searchWrap, searches);
  else searchWrap.classList.add("hidden");
  d.appendChild(searchWrap);
  const b=document.createElement("div"); b.className="bubble prose";
  const hasClarify = !!(clarify && clarify.questions && clarify.questions.length);
  if(hasClarify){
    // A clarifying turn renders the question/options card instead of markdown
    // prose. The question text is also persisted as Content for the model's own
    // context next round, but we don't show it twice.
    b.classList.remove("prose");
    renderClarifyCard(b, clarify, !!answered, (value)=>sendClarifyAnswer(value, b));
  } else if(text){
    renderMessage(b, text);
  }
  d.appendChild(b);
  const meta=document.createElement("div"); meta.className="msg-meta";
  if(ts){ const t=document.createElement("span"); t.className="ts"; t.textContent=fmtTs(ts); meta.appendChild(t); }
  const srcLinks=document.createElement("span"); srcLinks.className="src-links";
  if(searches && searches.length) renderSourceLinks(srcLinks, searches);
  meta.appendChild(srcLinks);
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
function rerenderChat(){
  chat.innerHTML="";
  messages.forEach((m,i)=>{
    // A clarifying question is "answered" once a user turn follows it, so on a
    // reload we render its option buttons disabled.
    const answered = m.role==="assistant" && !!m.clarify && i<messages.length-1 && messages[i+1] && messages[i+1].role==="user";
    addMsg(m.role, m.content, m.ts, m.search ? m.search.searches : null, m.images||null, m.clarify||null, answered, m.steps||null, m.thoughts||null);
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
        body:JSON.stringify({model:selectedModel, messages, web_search:webSearchOn(), clarify:clarifyOn(), agent:agentOn(), local:isLocalModel(selectedModel)})
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
  tailJob(activeId, bubble, job.content||"", searchWrap, srcLinks, null, stepsWrap, null, thoughtsWrap, thoughtsDet, null);
  renderSend();
}

// A clarifying-question option was clicked: send its value as the next user
// turn (which re-enters /generate so the model asks again or answers). If the
// question is still finalizing (job active), defer until it's done. Disables
// the card's buttons immediately so the user can't double-send.
function sendClarifyAnswer(value, bubble){
  if(bubble) bubble.querySelectorAll(".clarify-option").forEach(btn=>{ btn.disabled=true; });
  if(activeJobConvId===activeId){
    pendingClarifyAnswer=value;
    return;
  }
  input.value=value;
  stream();
}

send.addEventListener("click",()=>{ if(send.classList.contains("stop")) stopActive(); else stream(); });
input.addEventListener("keydown",e=>{
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
input.addEventListener("input", autosize);

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

$("manageModels").addEventListener("click", openModelsPanel);
$("closeModels").addEventListener("click", closeModelsPanel);
$("tabInstalled").addEventListener("click", ()=>switchTab("installed"));
$("tabBrowse").addEventListener("click", ()=>switchTab("browse"));
$("modelsModal").addEventListener("click", e=>{ if(e.target===$("modelsModal")) closeModelsPanel(); });
document.addEventListener("keydown", e=>{ if(e.key==="Escape" && $("modelsModal").classList.contains("open")) closeModelsPanel(); });

function openModelsPanel(){ $("modelsModal").classList.add("open"); switchTab(modelsTab, true); }
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
  // Local (this computer) section sits above the server card list. It shows
  // the visitor's own Ollama models, distinct from NAS/Mac server models.
  body.appendChild(renderLocalSection());
  modelEntries=buildModelEntries(list, localModelNames);
  models=modelEntries.map(e=>e.name);
  syncSelectedFromEntries();
  renderModels();                                   // keep the header selector in sync
  if(!list.length){
    if(!localModelNames.length) body.appendChild(mutedNote("No models installed yet. Go to Browse to download one."));
  } else list.forEach(m=>body.appendChild(renderInstalledCard(m)));
  await resumePullIfActive();
}
// The Local section: a heading + "Connect local models" button, then either
// the discovered model cards, a hint (nothing connected yet), or the last
// discovery error (403/refused) rendered verbatim per the relay contract.
function renderLocalSection(){
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
    known.forEach(m=>sec.appendChild(renderLocalCard(m)));
  } else if(!localDiscoverMsg){
    const hint=document.createElement("div"); hint.className="muted local-hint";
    hint.textContent="Connect to Ollama on this computer (localhost:11434) to use your own models here — full feature parity with server models.";
    sec.appendChild(hint);
  }
  return sec;
}
// A local model card: name + size/details (if known) + a Use button. We can't
// remove or benchmark the visitor's models, so no Remove/Benchmark actions.
function renderLocalCard(m){
  const card=document.createElement("div"); card.className="mcard local-card";
  const head=document.createElement("div"); head.className="mcard-head";
  const title=document.createElement("div"); title.className="mcard-title"; title.textContent=m.name;
  const sub=document.createElement("div"); sub.className="mcard-sub";
  const d=m.details||{}; const bits=[d.parameter_size, d.quantization_level, d.family].filter(Boolean);
  if(m.sizeGB) bits.push(m.sizeGB.toFixed(1)+" GB");
  sub.textContent=bits.join(" · ");
  head.appendChild(title); head.appendChild(sub); card.appendChild(head);
  const actions=document.createElement("div"); actions.className="mcard-actions";
  const use=document.createElement("button"); use.textContent="Use"; use.addEventListener("click",()=>useModel(m.name));
  actions.appendChild(use); card.appendChild(actions);
  return card;
}
async function onConnectLocal(){
  localDiscoverMsg=null;
  const res=await discoverLocalModels();
  if(res.ok){ localModels=res.models; localModelNames=res.models.map(m=>m.name); saveLocalModelNames(); }
  else {
    localModels=[];
    if(res.kind==="origins") localDiscoverMsg="Your local Ollama rejected the request — start it with OLLAMA_ORIGINS=https://chat.selected.systems ollama serve (or OLLAMA_ORIGINS=*).";
    else if(res.kind==="refused") localDiscoverMsg="No Ollama found on this computer — install/start Ollama.";
    else localDiscoverMsg="Local Ollama returned HTTP "+(res.status||"?")+".";
  }
  modelEntries=buildModelEntries(lastServerModels, localModelNames);
  models=modelEntries.map(e=>e.name);
  syncSelectedFromEntries();
  renderModels();
  await renderInstalledTab();
}

function renderInstalledCard(m){
  const card=document.createElement("div"); card.className="mcard";
  if(m.hostOnline===false) card.classList.add("offline");
  const d=m.details||{};
  const head=document.createElement("div"); head.className="mcard-head";
  const title=document.createElement("div"); title.className="mcard-title"; title.textContent=m.name;
  const sub=document.createElement("div"); sub.className="mcard-sub";
  const bits=[d.parameter_size, d.quantization_level, d.family].filter(Boolean);
  if(m.sizeGB) bits.push(m.sizeGB.toFixed(1)+" GB");
  sub.textContent=bits.join(" · ");
  head.appendChild(title); head.appendChild(sub); card.appendChild(head);

  const meta=document.createElement("div"); meta.className="mcard-meta";
  if(m.host) meta.appendChild(badge(hostLabel(m.host), "host"));
  if(m.hostOnline===false) meta.appendChild(badge("offline", "fit-bad"));
  if(m.benchmark && m.benchmark.tokPerSec>0){
    meta.appendChild(badge(`${m.benchmark.tokPerSec.toFixed(1)} tok/s (measured)`, "speed-fast"));
    const s=document.createElement("span"); s.className="muted bench-sub";
    s.textContent=`load ${m.benchmark.loadMs||0}ms · prompt ${(m.benchmark.promptTokPerSec||0).toFixed(1)} tok/s`;
    meta.appendChild(s);
  } else {
    meta.appendChild(badge("not benchmarked", ""));
  }
  card.appendChild(meta);

  const actions=document.createElement("div"); actions.className="mcard-actions";
  const use=document.createElement("button"); use.textContent="Use"; use.addEventListener("click",()=>useModel(m.name));
  const bench=document.createElement("button"); bench.textContent="Benchmark"; bench.addEventListener("click",()=>benchmarkModel(m.name, meta));
  const det=document.createElement("button"); det.textContent="Details"; det.addEventListener("click",()=>toggleDetails(m.name, card));
  const rm=document.createElement("button"); rm.textContent="Remove"; rm.className="danger";
  rm.addEventListener("click",()=>confirmRemoveModel(m.name, card));
  if(activeId && generatingIds.has(activeId) && selectedModel===m.name) rm.disabled=true;
  if(m.hostOnline===false){ use.disabled=true; bench.disabled=true; }  // can't run on an offline host
  actions.appendChild(use); actions.appendChild(bench); actions.appendChild(det); actions.appendChild(rm);
  card.appendChild(actions);
  return card;
}

async function renderBrowseTab(){
  const body=$("tabBody"); body.innerHTML="";
  const pbn=document.createElement("div"); pbn.className="pullbyname";
  const hint=document.createElement("span"); hint.className="muted"; hint.textContent="Pull any model by name (e.g. mistral:7b, llama3.2:1b):";
  const row=document.createElement("div"); row.className="row";
  const inp=document.createElement("input"); inp.placeholder="model:tag";
  const go=document.createElement("button"); go.textContent="Download";
  go.addEventListener("click",()=>{ const v=inp.value.trim(); if(v) startPull(v); });
  inp.addEventListener("keydown",e=>{ if(e.key==="Enter"){ e.preventDefault(); go.click(); } });
  row.appendChild(inp); row.appendChild(go); pbn.appendChild(hint); pbn.appendChild(row); body.appendChild(pbn);

  let data;
  try{ const r=await fetchRetry("/api/models/catalog",{},{label:"Load catalog"}); data=await r.json(); }
  catch(e){ body.appendChild(mutedNote("Could not load catalog.")); await resumePullIfActive(); return; }
  const nas=data.nas||{};
  const note=document.createElement("div"); note.className="catalog-note muted";
  note.textContent=`Fit is estimated for ${nas.ramGB||8} GB RAM · ${(nas.contextLength||16384).toLocaleString()}-tok context (reserve ${(nas.reserveGB||1.5).toFixed(1)} GB). Benchmark after download for real tok/s.`;
  body.appendChild(note);
  (data.models||[]).forEach(m=>body.appendChild(renderBrowseCard(m)));
  await resumePullIfActive();
}

function renderBrowseCard(m){
  const card=document.createElement("div"); card.className="mcard";
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
  const meta=document.createElement("div"); meta.className="mcard-meta";
  meta.appendChild(fitBadge(v)); meta.appendChild(speedBadge(m, v));
  card.appendChild(meta);
  const actions=document.createElement("div"); actions.className="mcard-actions";
  if(m.installed){
    const tag=document.createElement("span"); tag.className="installed-tag"; tag.textContent="Installed";
    const use=document.createElement("button"); use.textContent="Use"; use.addEventListener("click",()=>useModel(m.name));
    actions.appendChild(tag); actions.appendChild(use);
  } else {
    const dl=document.createElement("button"); dl.innerHTML=icon("download",15)+" Download";
    if(v.fit==="no") dl.title="Likely won't fit in 8 GB RAM — expect swapping/very slow";
    dl.addEventListener("click",()=>startPull(m.name));
    actions.appendChild(dl);
  }
  card.appendChild(actions);
  return card;
}

// --- Pull flow (enqueue a background pull, tail progress over SSE) ----------
async function startPull(model){
  try{
    const r=await fetchRetry("/api/models/pull",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({model})},{label:"Start pull"});
    const j=await r.json().catch(()=>({}));
    if(r.status===409){ attachPull(j); return; }       // a pull is already running — tail it
    if(!r.ok){ flashError(j.error||"Could not start pull"); return; }
    attachPull(j);
  }catch(e){ flashError(errText(e)); }
}

function attachPull(job){
  pullJobModel=job.model||null;
  renderPullStatus(job);
  tailPull(job.jobId);
}

async function resumePullIfActive(){
  try{
    const r=await fetch("/api/models/pulls/active");
    if(!r.ok) return;
    const map=await r.json();
    const keys=Object.keys(map||{});
    if(!keys.length) return;
    attachPull(map[keys[0]]);                       // pull survived a modal reopen/reload
  }catch{}
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
  setTimeout(async ()=>{
    $("pullStatus").classList.add("hidden"); pullEls=null;
    await loadModels();                              // refresh the header selector (benchmark now persisted)
    await switchTab(modelsTab);                      // re-render current tab (marks installed + shows tok/s)
  }, 1100);
}

function onPullError(msg){
  if(pullEls) pullEls.phase.textContent="Error";
  flashError(String(msg||"pull failed"));
}

async function cancelPull(jobId){
  try{ await fetchRetry("/api/models/pull/"+encodeURIComponent(jobId)+"/cancel",{method:"POST"},{label:"Cancel pull"}); }catch{} }

// --- Per-model actions ------------------------------------------------------
function useModel(name){
  selectedModel=name; localStorage.setItem("nas-llm-model", selectedModel);
  syncVision();
  renderModels();
  if(activeId && !generatingIds.has(activeId)) saveConversation();
  closeModelsPanel();
}

async function benchmarkModel(name, metaEl){
  metaEl.replaceChildren(thinkingDots());
  const t=document.createElement("span"); t.className="muted"; t.textContent=" benchmarking…"; metaEl.appendChild(t);
  try{
    const r=await fetchRetry("/api/models/"+encodeURIComponent(name)+"/benchmark",{method:"POST"},{label:"Benchmark"});
    const j=await r.json().catch(()=>({}));
    if(!r.ok){ metaEl.replaceChildren(badge("not benchmarked","")); const e=document.createElement("span"); e.className="err-note bench-sub"; e.textContent=j.error||"Benchmark failed"; metaEl.appendChild(e); return; }
    metaEl.replaceChildren();
    metaEl.appendChild(badge(`${(j.tokPerSec||0).toFixed(1)} tok/s (measured)`, "speed-fast"));
    const s=document.createElement("span"); s.className="muted bench-sub";
    s.textContent=`load ${j.loadMs||0}ms · prompt ${(j.promptTokPerSec||0).toFixed(1)} tok/s`;
    metaEl.appendChild(s);
  }catch(e){ metaEl.replaceChildren(badge("not benchmarked","")); const er=document.createElement("span"); er.className="err-note bench-sub"; er.textContent=errText(e); metaEl.appendChild(er); }
}

async function deleteModel(name, card){
  try{
    const r=await fetchRetry("/api/models/"+encodeURIComponent(name),{method:"DELETE"},{label:"Remove model"});
    if(r.status===404){ confirmRemoveModel(name, card, "Model not found."); return; }
    if(!r.ok && r.status!==204){ let j={}; try{j=await r.json()}catch{}; confirmRemoveModel(name, card, j.error||"Could not remove model"); return; }
    card.remove();
    await loadModels(); renderModels();
    if(modelsTab==="browse") await renderBrowseTab();
  }catch(e){ confirmRemoveModel(name, card, errText(e)); }
}
// Inline confirm inside a model card's action row (replaces native confirm).
function confirmRemoveModel(name, card, err){
  const actions=card.querySelector(".mcard-actions");
  if(!actions) return;
  actions.replaceChildren();
  const msg=document.createElement("span");
  msg.className = err ? "rm-msg err-note" : "rm-msg muted";
  msg.textContent = err ? err : `Remove "${name}" from the NAS? This frees disk space.`;
  const cancel=document.createElement("button"); cancel.textContent="Cancel";
  cancel.addEventListener("click", async ()=>{ if(modelsTab==="installed") await renderInstalledTab(); else await renderBrowseTab(); });
  const ok=document.createElement("button"); ok.className="danger"; ok.textContent="Remove";
  ok.addEventListener("click",()=>deleteModel(name, card));
  actions.appendChild(msg); actions.appendChild(cancel); actions.appendChild(ok);
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

// --- Agent settings (global system prompt + tool allowlist) ----------------
const agentModal=$("agentModal"), agentSystem=$("agentSystem"), agentToolsBox=$("agentTools"), agentSaved=$("agentSaved");
let agentAvailable=[];      // [{name,label,description}] from the server
let agentSelectedTools=null; // null = not yet loaded; the checkbox set mirrors this
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
  try{
    await fetchRetry("/api/agent/config",{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({system,tools})},{label:"Save agent config"});
    agentSaved.classList.remove("hidden");
    setTimeout(()=>agentSaved.classList.add("hidden"), 1500);
  }catch(e){ flashAgentErr(String(e.message||e)); }
});
function flashAgentErr(msg){
  const saved=agentSaved; saved.classList.remove("hidden"); saved.classList.add("err-note"); saved.textContent=String(msg||"save failed");
  setTimeout(()=>{ saved.classList.add("hidden"); saved.classList.remove("err-note"); saved.textContent="Saved."; }, 4000);
}

boot();

