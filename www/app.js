// nas-llm chat UI — app logic, split out of the old single-file index.html.
// Imports UI helpers (icons, markdown rendering) from lib.js. No build step.
import { icon, setIcon, renderMessage, escapeHtml, StreamRenderer, thinkingDots } from './lib.js';

const $ = id => document.getElementById(id);
const app=$("app"), loginView=$("login");
const chat=$("chat"), input=$("input"), send=$("send"), modelSel=$("model");
const convList=$("convList"), whoEmail=$("whoEmail");
const chatTitle=$("chatTitle"), chatMeta=$("chatMeta");
const loginEmail=$("loginEmail"), loginBtn=$("loginBtn"), loginInfo=$("loginInfo");
const sidebar=$("sidebar"), scrim=$("scrim"), menuBtn=$("menuBtn"), closeSide=$("closeSide");
const searchToggle=$("searchToggle");

// Static button icons (set once; the buttons live inside #app, which is hidden
// until auth, so there's no flash of unstyled content).
setIcon($("newChat"), "new-chat", 16); $("newChat").insertAdjacentHTML("beforeend", '<span>New chat</span>');
setIcon($("newFolder"), "folder-plus", 18);
setIcon($("closeSide"), "close", 18);
setIcon($("menuBtn"), "menu", 18);
setIcon($("searchToggle"), "globe", 18);
setIcon($("send"), "send", 16); $("send").setAttribute("aria-label", "Send");
setIcon($("logout"), "logout", 15); $("logout").insertAdjacentHTML("beforeend", '<span>Log out</span>');
setIcon($("manageModels"), "boxes", 16); $("manageModels").setAttribute("aria-label", "Manage models");
setIcon($("closeModels"), "close", 18);

let me = null;                 // {email} once logged in
let models = [];
let selectedModel = localStorage.getItem("nas-llm-model") || "";
let conversations = [];
let folders = [];
let collapsedFolders = JSON.parse(localStorage.getItem("nas-llm-collapsed")||"{}");
let activeId = null;           // null = new, unsaved chat
let messages = [];
let openMenu = null;           // currently shown row action menu element
let webSearch = localStorage.getItem("nas-llm-search") === "1";
let generatingIds = new Set(); // conversation IDs with an active background job
let activeES = null;           // the current EventSource tail (active conversation)
let activeJobConvId = null;    // conversation whose tail is currently open
let inputHistory = loadInputHistory(); // sent questions, oldest→newest
let histIndex = inputHistory.length;   // pointer; ==length means "current draft"
let draft = "";                        // in-progress text saved on first ArrowUp

function renderSearchToggle(){ searchToggle.classList.toggle("on", webSearch); searchToggle.setAttribute("aria-pressed", String(webSearch)); }
searchToggle.addEventListener("click", ()=>{ webSearch=!webSearch; localStorage.setItem("nas-llm-search", webSearch?"1":"0"); renderSearchToggle(); });
renderSearchToggle();

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
  showLogin();
}
$("logout").addEventListener("click", logout);
$("newChat").addEventListener("click", ()=>{ newChat(); closeSidebar(); });

// --- Models -----------------------------------------------------------------
async function loadModels(){
  try{
    const r=await fetchRetry("/api/models",{},{label:"Load models"});
    const j=await r.json();
    models=(j.data||[]).map(m=>m.id);
    if(models.length && !models.includes(selectedModel)) selectedModel=models[0];
    renderModels();
  }catch(e){ renderModels(); modelSel.title=String(e.message||e); }
}
function renderModels(){
  modelSel.innerHTML="";
  models.forEach(m=>{ const o=document.createElement("option"); o.value=o.textContent=m; modelSel.appendChild(o); });
  if(models.length) modelSel.value=selectedModel;
}
modelSel.addEventListener("change", ()=>{
  selectedModel=modelSel.value;
  localStorage.setItem("nas-llm-model", selectedModel);
  // Don't overwrite messages while a background job is mid-generation for this
  // conversation — the job finalizes by appending to the stored messages, and a
  // PUT here (which lacks the in-flight assistant reply) would clobber it.
  if(activeId && !generatingIds.has(activeId)) saveConversation();
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
  folders.forEach(f=>{ if(byFolder[f.id]){ convList.appendChild(renderFolder(f, byFolder[f.id])); delete byFolder[f.id]; } });
  if(byFolder[""]) convList.appendChild(renderFolder(null, byFolder[""]));
}
function renderFolder(f, convs){
  const wrap=document.createElement("div"); wrap.className="folder"+(f&&collapsedFolders[f.id]?" collapsed":"");
  const head=document.createElement("div"); head.className="folder-head";
  const chev=document.createElement("span"); chev.className="folder-chev";
  chev.innerHTML = f ? icon(collapsedFolders[f.id]?"chevron-right":"chevron-down", 14) : "";
  const name=document.createElement("div"); name.className="folder-name";
  if(f){
    name.textContent=f.name;
    head.appendChild(chev); head.appendChild(name);
    const more=document.createElement("button"); more.className="folder-act"; more.title="More";
    more.innerHTML = icon("more", 16);
    more.addEventListener("click",e=>{ e.stopPropagation(); openFolderMenu(f, more, name); });
    head.appendChild(more);
    head.addEventListener("click",()=>{ collapsedFolders[f.id]=!collapsedFolders[f.id]; saveCollapsed(); renderSidebar(); });
  } else {
    chev.style.visibility="hidden";
    name.textContent="Unsorted";
    head.appendChild(chev); head.appendChild(name);
  }
  wrap.appendChild(head);
  const body=document.createElement("div"); body.className="folder-body";
  convs.forEach(c=>body.appendChild(renderConv(c)));
  wrap.appendChild(body);
  return wrap;
}
function renderConv(c){
  const row=document.createElement("div"); row.className="conv"+(c.id===activeId?" active":"")+(generatingIds.has(c.id)?" generating":"");
  const main=document.createElement("div"); main.className="conv-main";
  const t=document.createElement("div"); t.className="conv-title"; t.id="ct-"+c.id; t.textContent=c.title||"New chat";
  const tm=document.createElement("div"); tm.className="conv-time"; tm.textContent=absTime(c.updatedAt); tm.title=relTime(c.updatedAt);
  main.appendChild(t); main.appendChild(tm);
  row.appendChild(main);
  const more=document.createElement("button"); more.className="conv-act"; more.title="More";
  more.innerHTML = icon("more", 16);
  more.addEventListener("click",e=>{ e.stopPropagation(); openConvMenu(c, more); });
  row.appendChild(more);
  row.addEventListener("click",()=>{ openConversation(c.id); closeSidebar(); });
  return row;
}
// --- Row action menu (rename / move / delete) ---
function closeMenu(){ if(openMenu){ openMenu.remove(); openMenu=null; document.removeEventListener("click",closeMenu); } }
function menuButton(iconName, label){
  const b=document.createElement("button");
  b.innerHTML = icon(iconName, 15) + '<span>'+escapeHtml(label)+'</span>';
  return b;
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
  del.addEventListener("click",e=>{ e.stopPropagation(); closeMenu(); deleteConversation(c.id); });
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
  del.addEventListener("click",async e=>{ e.stopPropagation(); closeMenu(); await deleteFolder(f.id, f.name); });
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
  cell.innerHTML="";
  const inp=document.createElement("input"); inp.value=c.title||""; inp.maxLength=80;
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
  const name=prompt("Folder name:"); if(!name) return;
  try{ await fetchRetry("/api/folders",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:name.trim()})},{label:"Create folder"}); }catch{}
  await loadConversations();
}
async function deleteFolder(id, name){
  if(!confirm('Delete folder "'+name+'"? Its chats move to Unsorted (not deleted).')) return;
  try{ await fetchRetry("/api/folders/"+encodeURIComponent(id),{method:"DELETE"},{label:"Delete folder"}); }catch{}
  await loadConversations();
}
function startFolderRename(f, cell){
  cell.innerHTML="";
  const inp=document.createElement("input"); inp.value=f.name; inp.maxLength=80;
  cell.appendChild(inp); inp.focus(); inp.select();
  let done=false;
  const commit=async ()=>{ if(done) return; done=true;
    const v=inp.value.trim(); if(!v||v===f.name){ renderSidebar(); return; }
    try{ await fetchRetry("/api/folders/"+encodeURIComponent(f.id),{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:v})},{label:"Rename folder"}); }catch{}
    await loadConversations();
  };
  const cancel=()=>{ done=true; renderSidebar(); };
  inp.addEventListener("keydown",e=>{ if(e.key==="Enter"){ e.preventDefault(); commit(); } else if(e.key==="Escape"){ e.preventDefault(); cancel(); } });
  inp.addEventListener("blur",commit);
}
async function openConversation(id){
  // Closing the old tail does NOT stop generation — it runs detached on the
  // NAS. We just stop listening; if this conversation has an active job we
  // reopen the tail below and resume live.
  closeTail();
  activeJobConvId=null; send.disabled=false;
  try{
    const r=await fetch("/api/conversations/" + encodeURIComponent(id));
    if(!r.ok) return;
    const c=await r.json();
    activeId=c.id; messages=c.messages||[];
    histIndex=inputHistory.length; draft="";
    if(models.includes(c.model)) selectedModel=c.model;
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
  activeJobConvId=id; send.disabled=true;
  const bubble=addMsg("assistant","",job.createdAt||Date.now());
  const cursor=document.createElement("span"); cursor.className="cursor"; cursor.textContent="▍";
  tailJob(id, bubble, cursor, job.content||"");
}

// tailJob opens an EventSource to /events and renders into bubble via a
// StreamRenderer (one markdown re-parse per animation frame). On reconnect the
// server sends a "reset" with the full prefix, which re-anchors acc so
// reconnects never double-count. "done" reloads the conversation from the
// server (source of truth — the assistant reply is persisted there).
function tailJob(convId, bubble, cursor, initialAcc){
  closeTail();
  const renderer = new StreamRenderer(bubble, cursor);
  renderer.set(initialAcc);
  let esClosed=false;
  activeJobConvId=convId;
  const es=new EventSource("/api/conversations/"+encodeURIComponent(convId)+"/events");
  activeES=es;
  es.addEventListener("reset", e=>{ let acc=""; try{ acc=JSON.parse(e.data); }catch{} renderer.set(acc); });
  es.addEventListener("phase", e=>{ renderer.setPhase(e.data); });
  es.addEventListener("chunk", e=>{ let d=""; try{ d=JSON.parse(e.data); }catch{} renderer.append(d); });
  es.addEventListener("done", ()=>{ esClosed=true; es.close(); activeES=null; onGenerationDone(convId); });
  es.addEventListener("joberror", e=>{
    esClosed=true; es.close(); activeES=null;
    let msg=e.data; try{ msg=JSON.parse(e.data); }catch{}
    const acc = renderer.acc;
    if(acc) renderer.finalize(acc);
    else bubbleError(bubble, msg, cursor);
    generatingIds.delete(convId); renderSidebar();
    activeJobConvId=null; send.disabled=false; input.focus();
  });
  es.onerror=()=>{ if(esClosed) return; /* transport drop: EventSource auto-reconnects; reset re-anchors acc */ };
}

async function onGenerationDone(convId){
  generatingIds.delete(convId); activeJobConvId=null;
  if(convId===activeId){
    send.disabled=false;
    // Reload from the server: the assistant reply is persisted there now.
    try{
      const r=await fetch("/api/conversations/"+encodeURIComponent(convId));
      if(r.ok){ const c=await r.json(); messages=c.messages||[]; rerenderChat(); updateHeader(); }
    }catch{}
  }
  await loadConversations();
  input.focus();
}
function newChat(){
  closeTail(); activeJobConvId=null; send.disabled=false;
  activeId=null; messages=[]; chat.innerHTML=""; histIndex=inputHistory.length; draft=""; renderSidebar(); updateHeader(); input.focus();
}
async function deleteConversation(id){
  if(!confirm("Delete this conversation?")) return;
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
// Render an error line (icon + message) into an assistant bubble, dropping the
// streaming cursor. Used when generation fails before any content lands.
function bubbleError(bubble, msg, cursor){
  if(cursor) cursor.remove();
  bubble.replaceChildren();
  const s=document.createElement("span"); s.className="status";
  const ic=document.createElement("span"); ic.className="status-ic"; ic.innerHTML=icon("error",15);
  const t=document.createElement("span"); t.textContent = String(msg||"generation failed");
  s.appendChild(ic); s.appendChild(t);
  bubble.appendChild(s);
}

function addMsg(role, text, ts){
  const d=document.createElement("div"); d.className="msg "+role;
  const r=document.createElement("div"); r.className="role";
  const ic=document.createElement("span"); ic.className="role-ic";
  ic.innerHTML = icon(role==="user"?"user":"sparkles", 15);
  const lab=document.createElement("span"); lab.className="role-label";
  lab.textContent = role==="user"?"You":"Assistant";
  r.appendChild(ic); r.appendChild(lab);
  if(ts){ const t=document.createElement("span"); t.className="ts"; t.textContent=fmtTs(ts); r.appendChild(t); }
  const b=document.createElement("div"); b.className="bubble";
  if(role==="user"){
    b.textContent = text;                 // plain text, escaped, pre-wrapped
  } else {
    b.classList.add("prose");
    if(text){ renderMessage(b, text); addCopyMsg(r, text); }
  }
  d.appendChild(r); d.appendChild(b); chat.appendChild(d);
  chat.scrollTop=chat.scrollHeight;
  return b;
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
  messages.forEach(m=>addMsg(m.role, m.content, m.ts));
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
  if(!text || send.disabled) return;
  recordHistory(text);
  histIndex=inputHistory.length; draft="";
  input.value=""; autosize();
  const uTs=Date.now();
  messages.push({role:"user",content:text,ts:uTs});
  addMsg("user",text,uTs);

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
  const bubble=addMsg("assistant","",aTs);
  const cursor=document.createElement("span"); cursor.className="cursor"; cursor.textContent="▍";
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
        body:JSON.stringify({model:selectedModel, messages, web_search:webSearch})
      });
      if(r.ok || r.status===409){ job=await r.json(); break; }
      genErr=new Error("HTTP "+r.status);
      if(!(r.status>=500 && r.status<600)) break; // 4xx -> fail fast
    }catch(e){ genErr=e; }
    if(attempt<MAX_RETRIES) await sleep(Math.min(MAX_DELAY, BASE_DELAY*2**attempt)*(0.7+Math.random()*0.6));
  }
  if(!job){
    bubbleError(bubble, String((genErr&&genErr.message)||genErr||"generate failed"), cursor);
    generatingIds.delete(activeId); renderSidebar();
    activeJobConvId=null; send.disabled=false; input.focus();
    return;
  }
  if(job.status==="error"){
    bubbleError(bubble, job.error||"generation failed", cursor);
    generatingIds.delete(activeId); renderSidebar();
    activeJobConvId=null; send.disabled=false; input.focus();
    return;
  }

  // Tail the job. Generation keeps running on the NAS even if the user switches
  // chats; "done" reloads this conversation from the server (source of truth).
  tailJob(activeId, bubble, cursor, job.content||"");
}

send.addEventListener("click",stream);
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
document.addEventListener("keydown", e=>{ if(e.key==="Escape" && !$("modelsModal").classList.contains("hidden")) closeModelsPanel(); });

function openModelsPanel(){ $("modelsModal").classList.remove("hidden"); switchTab(modelsTab, true); }
function closeModelsPanel(){
  $("modelsModal").classList.add("hidden");
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
  models=list.map(m=>m.id); renderModels();           // keep the header selector in sync
  if(!list.length){ body.appendChild(mutedNote("No models installed yet. Go to Browse to download one.")); }
  else list.forEach(m=>body.appendChild(renderInstalledCard(m)));
  await resumePullIfActive();
}

function renderInstalledCard(m){
  const card=document.createElement("div"); card.className="mcard";
  const d=m.details||{};
  const head=document.createElement("div"); head.className="mcard-head";
  const title=document.createElement("div"); title.className="mcard-title"; title.textContent=m.name;
  const sub=document.createElement("div"); sub.className="mcard-sub";
  const bits=[d.parameter_size, d.quantization_level, d.family].filter(Boolean);
  if(m.sizeGB) bits.push(m.sizeGB.toFixed(1)+" GB");
  sub.textContent=bits.join(" · ");
  head.appendChild(title); head.appendChild(sub); card.appendChild(head);

  const meta=document.createElement("div"); meta.className="mcard-meta";
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
  rm.addEventListener("click",()=>deleteModel(m.name, card));
  if(activeId && generatingIds.has(activeId) && selectedModel===m.name) rm.disabled=true;
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
    if(!r.ok){ alert(j.error||"Could not start pull"); return; }
    attachPull(j);
  }catch(e){ alert(errText(e)); }
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
  alert(String(msg||"pull failed"));
}

async function cancelPull(jobId){
  try{ await fetchRetry("/api/models/pull/"+encodeURIComponent(jobId)+"/cancel",{method:"POST"},{label:"Cancel pull"}); }catch{} }

// --- Per-model actions ------------------------------------------------------
function useModel(name){
  selectedModel=name; localStorage.setItem("nas-llm-model", selectedModel);
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
    if(!r.ok){ metaEl.replaceChildren(badge("not benchmarked","")); alert(j.error||"Benchmark failed"); return; }
    metaEl.replaceChildren();
    metaEl.appendChild(badge(`${(j.tokPerSec||0).toFixed(1)} tok/s (measured)`, "speed-fast"));
    const s=document.createElement("span"); s.className="muted bench-sub";
    s.textContent=`load ${j.loadMs||0}ms · prompt ${(j.promptTokPerSec||0).toFixed(1)} tok/s`;
    metaEl.appendChild(s);
  }catch(e){ metaEl.replaceChildren(badge("not benchmarked","")); alert(errText(e)); }
}

async function deleteModel(name, card){
  if(!confirm(`Remove "${name}" from the NAS? This frees disk space.`)) return;
  try{
    const r=await fetchRetry("/api/models/"+encodeURIComponent(name),{method:"DELETE"},{label:"Remove model"});
    if(r.status===404){ alert("Model not found."); }
    else if(!r.ok && r.status!==204){ let j={}; try{j=await r.json()}catch{}; alert(j.error||"Could not remove model"); return; }
    card.remove();
    await loadModels(); renderModels();
    if(modelsTab==="browse") await renderBrowseTab();
  }catch(e){ alert(errText(e)); }
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

boot();
