/* viewer.js — READ-ONLY viewer website (SPA).
 * Screens: welcome → maps → live map → responses → about.
 * Reads Firebase /live, /calib, /display (published by the control site).
 * "Maps" are saved places (name + host) kept in this browser. No editing here. */

const $ = id => document.getElementById(id);
const esc = s => String(s==null?"":s).replace(/[&<>"]/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;" }[c]));
const cleanHost = h => String(h||"").trim().replace(/^https?:\/\//,"").replace(/\/+$/,"");

// ===========================================================================
// MAPS (saved places) — stored in this browser
// ===========================================================================
const MKEY="uwbview.maps", AKEY="uwbview.activeMap", EKEY="uwbview.events";
let maps=[], mSeq=0, activeId=null, editingId=null;

function seedHost(){
  const u=new URLSearchParams(location.search).get("host");
  if(u) return cleanHost(u);
  const s=localStorage.getItem("uwbview.host"); if(s) return cleanHost(s);
  try{ const c=JSON.parse(localStorage.getItem("uwbweb.cfg")||"{}"); if(c.host) return cleanHost(c.host); }catch(e){}
  return "";
}
function loadMaps(){
  try{ maps=JSON.parse(localStorage.getItem(MKEY)||"[]")||[]; }catch(e){ maps=[]; }
  maps.forEach(m=>{ if(m.id>mSeq) mSeq=m.id; });
  if(!maps.length){ const h=seedHost(); if(h){ maps=[{id:++mSeq,name:"My space",host:h,note:""}]; saveMaps(); } }
  activeId = +localStorage.getItem(AKEY) || (maps[0]?maps[0].id:null);
}
function saveMaps(){ localStorage.setItem(MKEY,JSON.stringify(maps)); }
function activeMap(){ return maps.find(m=>m.id==activeId)||null; }
function currentHost(){ const m=activeMap(); return m?m.host:""; }
function setActive(id){ activeId=id; localStorage.setItem(AKEY,String(id)); resetEngineState(); updateActiveName(); }
function updateActiveName(){ const m=activeMap(); $("activeMapName").textContent=m?("📍 "+m.name):""; }

function renderMaps(){
  const g=$("mapGrid");
  if(!maps.length){ g.innerHTML=`<div class="empty">No maps yet. Press “+ Add map”.</div>`; return; }
  g.innerHTML=maps.map(m=>`
    <div class="mapcard ${m.id==activeId?"active":""}" data-id="${m.id}">
      <div class="mt">🗺️ ${esc(m.name)} ${m.id==activeId?'<span class="pill ok">active</span>':''}</div>
      <div class="mh">${esc(m.host)}</div>
      ${m.note?`<div class="mn">${esc(m.note)}</div>`:""}
      <div class="acts">
        <button class="mopen" data-id="${m.id}">Open</button>
        <button class="sec medit" data-id="${m.id}">Edit</button>
        <button class="sec mdel" data-id="${m.id}">✕</button>
      </div>
    </div>`).join("");
  g.querySelectorAll(".mopen").forEach(b=>b.onclick=()=>{ setActive(+b.dataset.id); location.hash="#live"; });
  g.querySelectorAll(".medit").forEach(b=>b.onclick=()=>openMapDlg(+b.dataset.id));
  g.querySelectorAll(".mdel").forEach(b=>b.onclick=()=>{
    if(!confirm("Remove this map?")) return;
    maps=maps.filter(m=>m.id!=+b.dataset.id);
    if(activeId==+b.dataset.id){ activeId=maps[0]?maps[0].id:null; localStorage.setItem(AKEY,String(activeId||"")); updateActiveName(); }
    saveMaps(); renderMaps();
  });
}
function openMapDlg(id){
  editingId=id||null;
  const m=id?maps.find(x=>x.id==id):null;
  $("mapDlgTitle").textContent=id?"Edit map":"Add a map";
  $("mapName").value=m?m.name:""; $("mapHost").value=m?m.host:seedHost(); $("mapNote").value=m?m.note:"";
  $("mapWrap").classList.add("show"); $("mapName").focus();
}
function closeMapDlg(){ $("mapWrap").classList.remove("show"); editingId=null; }
$("addMapBtn").onclick=()=>openMapDlg(null);
$("mapCancel").onclick=closeMapDlg;
$("mapWrap").onclick=e=>{ if(e.target===$("mapWrap")) closeMapDlg(); };
$("mapSave").onclick=()=>{
  const name=$("mapName").value.trim()||"Unnamed", host=cleanHost($("mapHost").value), note=$("mapNote").value.trim();
  if(!host){ $("mapHost").focus(); return; }
  if(editingId){ const m=maps.find(x=>x.id==editingId); if(m){ m.name=name; m.host=host; m.note=note; } }
  else { maps.push({id:++mSeq,name,host,note}); }
  saveMaps(); closeMapDlg(); renderMaps(); updateActiveName();
};

// ===========================================================================
// ROUTING
// ===========================================================================
const SCREENS=["welcome","maps","live","responses","about"];
function showScreen(name){
  SCREENS.forEach(s=>$("screen-"+s).classList.toggle("active", s===name));
  document.querySelectorAll(".navlinks a").forEach(a=>a.classList.toggle("active", a.dataset.screen===name));
}
function route(){
  let name=(location.hash||"#welcome").slice(1);
  if(!SCREENS.includes(name)) name="welcome";
  if((name==="live"||name==="responses") && !activeMap()){ location.hash="#maps"; return; }
  showScreen(name);
  if(name==="live"){ $("liveTitle").textContent=(activeMap()?activeMap().name:"Live map"); ensureEngine(); requestAnimationFrame(()=>drawTop(gA,gP,gR)); }
  else if(name==="responses"){ ensureEngine(); renderResponses(); }
  else stopEngine();
}
window.addEventListener("hashchange",route);
$("welGo").onclick=()=>location.hash="#maps";
$("welLive").onclick=()=>location.hash = activeMap()?"#live":"#maps";

// ===========================================================================
// notifications + responses
// ===========================================================================
let audioCtx=null;
function beep(){
  try{
    audioCtx = audioCtx || new (window.AudioContext||window.webkitAudioContext)();
    const o=audioCtx.createOscillator(), g=audioCtx.createGain();
    o.type="sine"; o.frequency.value=880; g.gain.value=0.07;
    o.connect(g); g.connect(audioCtx.destination);
    o.start(); o.stop(audioCtx.currentTime+0.15);
  }catch(e){}
}
let events=[];
function loadEvents(){ try{ events=JSON.parse(localStorage.getItem(EKEY)||"[]")||[]; }catch(e){ events=[]; } }
function saveEvents(){ localStorage.setItem(EKEY, JSON.stringify(events.slice(0,200))); }
function nowHMS(){ const d=new Date(), p=n=>String(n).padStart(2,"0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; }
function logEvent(z,type){
  events.unshift({t:nowHMS(),name:z.name,color:z.color,type,map:(activeMap()?activeMap().name:"")});
  if(events.length>200) events.pop();
  saveEvents(); renderLiveLog();
  if($("screen-responses").classList.contains("active")) renderResponses();
}
function logRowHTML(r){
  return `<div class="logrow ${r.type==='enter'?'enter':'leave'}">
    <span class="t">${esc(r.t)}</span>
    <span class="swatch" style="background:${esc(r.color)}"></span>
    <span class="nm" style="flex:1">${esc(r.name)}</span>
    <span class="what">${r.type==='enter'?'entered':'left'}</span></div>`;
}
function renderLiveLog(){
  const box=$("liveLog");
  if(!events.length){ box.innerHTML=`<div class="small" style="color:var(--muted)">No zone events yet.</div>`; return; }
  box.innerHTML=events.slice(0,16).map(logRowHTML).join("");
}
function renderResponses(){
  const sel=$("respFilter"), f=sel.value;
  // refresh filter options from known zone names
  const names=[...new Set(events.map(e=>e.name))];
  sel.innerHTML=`<option value="">All zones</option>`+names.map(n=>`<option value="${esc(n)}" ${n===f?"selected":""}>${esc(n)}</option>`).join("");
  const rows=events.filter(e=>!f||e.name===f);
  $("respList").innerHTML = rows.length ? rows.map(logRowHTML).join("") : `<div class="empty">No responses yet.</div>`;
}
$("respClear").onclick=()=>{ if(confirm("Clear all responses?")){ events=[]; saveEvents(); renderResponses(); renderLiveLog(); } };
$("respFilter").onchange=renderResponses;

function showToast(z){
  const el=document.createElement("div");
  el.className="toast"; el.style.borderLeftColor=z.color;
  el.innerHTML=`
    <div class="top">
      ${z.icon?`<span class="icon">${esc(z.icon)}</span>`:""}
      <span class="ttl">${esc(z.title||z.name)}</span>
      <button class="x" aria-label="close">×</button>
    </div>
    ${z.message?`<div class="msg">${esc(z.message)}</div>`:""}
    ${z.image?`<img src="${encodeURI(z.image)}" alt="">`:""}
    ${z.linkUrl?`<div class="act"><a href="${encodeURI(z.linkUrl)}" target="_blank" rel="noopener">${esc(z.linkLabel||"Open")}</a></div>`:""}`;
  const close=()=>el.remove();
  el.querySelector(".x").onclick=close;
  $("toasts").appendChild(el);
  setTimeout(close, +z.holdMs||6000);
}
// Audio guide playback (visible player so visitors can pause/replay).
const guideEl = $("guide");
let audioReady=false;
function enableAudio(){
  audioReady=true;
  try{ audioCtx=audioCtx||new (window.AudioContext||window.webkitAudioContext)(); audioCtx.resume&&audioCtx.resume(); }catch(e){}
  try{ guideEl.muted=true; guideEl.play().then(()=>{ guideEl.pause(); guideEl.currentTime=0; guideEl.muted=false; }).catch(()=>{ guideEl.muted=false; }); }catch(e){}
  $("enableAudio").textContent="🔊 Audio on"; $("enableAudio").disabled=true;
}
$("enableAudio").onclick=enableAudio;
function playGuide(z){
  if(!z.audio){ return; }
  try{
    $("guideBar").style.display="flex";
    $("guideNow").textContent=(z.icon?z.icon+" ":"")+"Now playing: "+(z.title||z.name);
    guideEl.src=z.audio; guideEl.currentTime=0;
    guideEl.play().catch(()=>{ if(!audioReady) $("guideNow").textContent="Tap “Enable audio” to hear guides."; });
  }catch(e){}
}
function fireTrigger(z){ showToast(z); if(z.sound) beep(); playGuide(z); logEvent(z,"enter"); }
function inside(p,z){
  return !!(p && p.x>=Math.min(z.xmin,z.xmax) && p.x<=Math.max(z.xmin,z.xmax)
              && p.y>=Math.min(z.ymin,z.ymax) && p.y<=Math.max(z.ymin,z.ymax));
}
function updatePresence(p){
  const t=performance.now();
  zones.forEach(z=>{
    z.occupied=inside(p,z);
    if(z.occupied && !z.wasInside){
      if(!z.lastFired || !z.cooldownMs || (t-z.lastFired)>=z.cooldownMs){ fireTrigger(z); z.lastFired=t; }
    }else if(z.occupied && z.wasInside && !z.once){
      if(z.cooldownMs && (t-z.lastFired)>=z.cooldownMs){ fireTrigger(z); z.lastFired=t; }
    }else if(!z.occupied && z.wasInside){ logEvent(z,"leave"); }
    z.wasInside=z.occupied;
  });
  updateNowIn();
}
function updateNowIn(){
  const here=zones.filter(z=>z.occupied);
  $("nowin").innerHTML = here.length
    ? here.map(z=>`<span class="tag" style="background:${esc(z.color)}">${esc(z.name)}</span>`).join(" ")
    : "—";
}

// ===========================================================================
// math + drawing
// ===========================================================================
function anchorsFromCalib(d12,d13,d23){
  if(!(d12>0&&d13>0&&d23>0)) return null;
  const x3=(d13*d13 - d23*d23 + d12*d12)/(2*d12);
  const y2=d13*d13 - x3*x3, y3=y2>0?Math.sqrt(y2):0;
  return [{x:0,y:0},{x:d12,y:0},{x:x3,y:y3}];
}
function trilaterate(A,r,below){
  const [A1,A2,A3]=A, [r1,r2,r3]=r;
  const ex=A2.x-A1.x, ey=A2.y-A1.y, dx=A3.x-A1.x, dy=A3.y-A1.y;
  const dAB=Math.hypot(ex,ey); if(dAB<1e-6) return null;
  const ux=ex/dAB, uy=ey/dAB, i=ux*dx+uy*dy, vx=dx-i*ux, vy=dy-i*uy, j=Math.hypot(vx,vy);
  if(j<1e-6) return null;
  const x=(r1*r1 - r2*r2 + dAB*dAB)/(2*dAB);
  const y=(r1*r1 - r3*r3 + i*i + j*j - 2*i*x)/(2*j);
  let z2=r1*r1 - x*x - y*y; const z=z2>0?Math.sqrt(z2):0;
  return {x:A1.x + x*ux + y*(vx/j), y:A1.y + x*uy + y*(vy/j), z:below?-z:z};
}
function worldBounds(A,p){
  let xs=A.map(a=>a.x), ys=A.map(a=>a.y);
  if(p){ xs.push(p.x); ys.push(p.y); }
  zones.forEach(z=>{ xs.push(z.xmin,z.xmax); ys.push(z.ymin,z.ymax); });
  let minX=Math.min(...xs),maxX=Math.max(...xs),minY=Math.min(...ys),maxY=Math.max(...ys);
  const pad=Math.max(1,(maxX-minX),(maxY-minY))*0.2+0.5;
  return {minX:minX-pad,maxX:maxX+pad,minY:minY-pad,maxY:maxY+pad};
}
function mapper(b,W,H){
  const s=Math.min(W/(b.maxX-b.minX), H/(b.maxY-b.minY));
  const ox=(W-(b.maxX-b.minX)*s)/2, oy=(H-(b.maxY-b.minY)*s)/2;
  return {X:x=>ox+(x-b.minX)*s, Y:y=>H-(oy+(y-b.minY)*s), s};
}
function grid(ctx,W,H){ ctx.fillStyle="#0a0d12";ctx.fillRect(0,0,W,H);
  ctx.strokeStyle="#1b2330";ctx.lineWidth=1;
  for(let x=0;x<=W;x+=44){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,H);ctx.stroke();}
  for(let y=0;y<=H;y+=44){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(W,y);ctx.stroke();}
}
function drawZone(ctx,m,z){
  const xmin=Math.min(z.xmin,z.xmax),xmax=Math.max(z.xmin,z.xmax);
  const ymin=Math.min(z.ymin,z.ymax),ymax=Math.max(z.ymin,z.ymax);
  const x=m.X(xmin), y=m.Y(ymax), w=(xmax-xmin)*m.s, h=(ymax-ymin)*m.s;
  const col=z.color||"#58a6ff";
  ctx.fillStyle=col; ctx.globalAlpha=z.occupied?0.24:0.08; ctx.fillRect(x,y,w,h); ctx.globalAlpha=1;
  ctx.strokeStyle=col; ctx.lineWidth=z.occupied?2.5:1; ctx.strokeRect(x,y,w,h);
  ctx.fillStyle=z.occupied?col:"#8b949e"; ctx.font="14px system-ui";
  ctx.fillText((z.icon?z.icon+" ":"")+z.name+(z.occupied?" • here":""), x+5, y+17);
}
function drawTop(A,p,r){
  const c=$("top"); if(!c) return; const ctx=c.getContext("2d"),W=c.width,H=c.height; grid(ctx,W,H);
  if(!A){ ctx.fillStyle="#8b949e";ctx.font="16px system-ui";ctx.fillText("waiting for anchor geometry…",24,34); return; }
  const b=worldBounds(A,p),m=mapper(b,W,H);
  zones.forEach(z=>drawZone(ctx,m,z));
  if(p&&r) A.forEach((a,k)=>{ if(r[k]>0){ ctx.strokeStyle="rgba(88,166,255,.22)";ctx.beginPath();
    ctx.arc(m.X(a.x),m.Y(a.y),r[k]*m.s,0,7); ctx.stroke(); }});
  A.forEach((a,k)=>{ ctx.fillStyle="#d29922"; ctx.beginPath();ctx.arc(m.X(a.x),m.Y(a.y),7,0,7);ctx.fill();
    ctx.fillStyle="#e6edf3";ctx.font="13px system-ui";ctx.fillText("A"+(k+1),m.X(a.x)+10,m.Y(a.y)-10); });
  if(p){ ctx.fillStyle="#3fb950"; ctx.beginPath();ctx.arc(m.X(p.x),m.Y(p.y),10,0,7);ctx.fill();
    ctx.strokeStyle="#3fb950";ctx.beginPath();ctx.arc(m.X(p.x),m.Y(p.y),16,0,7);ctx.stroke();
    ctx.fillStyle="#e6edf3";ctx.font="14px system-ui";ctx.fillText("TAG",m.X(p.x)+15,m.Y(p.y)+5); }
}

// ===========================================================================
// engine (polling)
// ===========================================================================
let timer=null, lastSeq=null, lastSeqTime=0, rateHz=0, ema=null;
let zones=[], display={below:false, ema:0.3, autocal:true, anchors:null};
let gA=null, gP=null, gR=null;

function setDot(cls,msg){ const d=$("dot"); d.className="dot "+(cls==="ok"?"ok":cls==="stale"?"stale":""); $("age").textContent=msg||""; }
function resetEngineState(){ ema=null; lastSeq=null; rateHz=0; gA=gP=gR=null;
  zones.forEach(z=>{ z.occupied=false; z.wasInside=false; z.lastFired=0; }); updateNowIn(); }

function applyDisplay(d){
  if(!d) return;
  display.below=!!d.below; display.autocal=d.autocal!==false;
  display.ema=(d.ema!=null)?+d.ema:0.3; display.anchors=Array.isArray(d.anchors)?d.anchors:null;
  const incoming=Array.isArray(d.zones)?d.zones:[];
  const prev=new Map(zones.map(z=>[z.name+"|"+z.xmin+"|"+z.ymin, z]));
  zones=incoming.map(z=>{ const old=prev.get(z.name+"|"+z.xmin+"|"+z.ymin);
    return { ...z, occupied:old?old.occupied:false, wasInside:old?old.wasInside:false, lastFired:old?old.lastFired:0 }; });
}
async function tick(){
  const HOST=currentHost();
  if(!HOST){ setDot("bad","no map"); return; }
  try{
    const [liveR,calR,dispR]=await Promise.all([
      fetch(`https://${HOST}/live.json`,{cache:"no-store"}),
      fetch(`https://${HOST}/calib.json`,{cache:"no-store"}),
      fetch(`https://${HOST}/display.json`,{cache:"no-store"})
    ]);
    const live=await liveR.json();
    const cal =await calR.json().catch(()=>null);
    const disp=await dispR.json().catch(()=>null);
    applyDisplay(disp);
    if(!live){ setDot("stale","no live data"); return; }
    render(live,cal);
  }catch(e){ setDot("bad","offline"); }
}
function render(live,cal){
  const r=[live.d1,live.d2,live.d3].map(Number);
  if(live.seq!=null && live.seq!==lastSeq){
    const now=performance.now();
    if(lastSeqTime) rateHz=1000/Math.max(1,(now-lastSeqTime));
    lastSeqTime=now; lastSeq=live.seq;
  }
  $("rate").textContent=rateHz?`${rateHz.toFixed(1)} Hz`:"";
  setDot("ok","live");

  let A=(display.autocal && cal)
    ? anchorsFromCalib(Number(cal.d12),Number(cal.d13),Number(cal.d23))
    : (display.anchors||null);
  if(!A){ gA=gP=null;gR=r; updatePresence(null); drawTop(null,null,r); return; }
  if(r.some(v=>!(v>0))){ gA=A;gP=null;gR=r; updatePresence(null); drawTop(A,null,r); return; }
  let p=trilaterate(A,r,display.below);
  if(!p){ gA=A;gP=null;gR=r; updatePresence(null); drawTop(A,null,r); return; }
  const a=+display.ema;
  if(a>0 && ema){ p={x:a*ema.x+(1-a)*p.x, y:a*ema.y+(1-a)*p.y, z:a*ema.z+(1-a)*p.z}; }
  ema={x:p.x,y:p.y,z:p.z};
  gA=A;gP=p;gR=r; updatePresence(p); drawTop(A,p,r);
}
function ensureEngine(){ if(!timer && activeMap()){ try{ audioCtx=audioCtx||new (window.AudioContext||window.webkitAudioContext)(); audioCtx.resume&&audioCtx.resume(); }catch(e){} tick(); timer=setInterval(tick,300); } }
function stopEngine(){ clearInterval(timer); timer=null; }

// ===========================================================================
// boot
// ===========================================================================
loadMaps(); loadEvents();
renderMaps(); renderLiveLog(); renderResponses(); updateActiveName();
if(!location.hash) location.hash="#welcome";
route();
