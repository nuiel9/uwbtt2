/* UWB live positioning + editable zone triggers.
 * Trigger AREAS (name, message, colour, box, beep, …) are edited IN THE PAGE and
 * saved in the browser (localStorage). zones.config.js only provides the default
 * set used on first run and by "Reset to defaults".
 * When the tag enters an area, its info pops up (toast), can beep, and is logged. */

const $ = id => document.getElementById(id);
const esc = s => String(s==null?"":s).replace(/[&<>"]/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;" }[c]));

// ---------------------------------------------------------------------------
// connection / option persistence
// ---------------------------------------------------------------------------
const LS = "uwbweb.cfg";
function loadCfg(){
  try{ const c = JSON.parse(localStorage.getItem(LS)||"{}");
    if(c.host) $("host").value=c.host;
    if(c.poll) $("poll").value=c.poll;
    if(c.ema!=null) $("ema").value=c.ema;
    if(c.autocal!=null) $("autocal").checked=c.autocal;
    if(c.below!=null) $("below").checked=c.below;
    ["a1x","a1y","a2x","a2y","a3x","a3y"].forEach(k=>{ if(c[k]!=null) $(k).value=c[k]; });
  }catch(e){}
}
function saveCfg(){
  const c={host:$("host").value.trim(),poll:+$("poll").value,ema:+$("ema").value,
    autocal:$("autocal").checked,below:$("below").checked};
  ["a1x","a1y","a2x","a2y","a3x","a3y"].forEach(k=>c[k]=+$(k).value);
  localStorage.setItem(LS,JSON.stringify(c));
}
loadCfg();
$("autocal").onchange=()=>{ $("manualBox").style.display=$("autocal").checked?"none":"block"; saveCfg(); };
$("manualBox").style.display=$("autocal").checked?"none":"block";
["host","poll","ema","below","a1x","a1y","a2x","a2y","a3x","a3y"].forEach(k=>$(k).oninput=saveCfg);

// ---------------------------------------------------------------------------
// ZONES — editable trigger areas, saved in the browser
// ---------------------------------------------------------------------------
const ZKEY = "uwbweb.triggers";
let zones = [], zSeq = 0;
const trigListEl = $("trigList");

// Default fields for a brand-new zone.
function blankZone(){
  return { id:++zSeq, name:"New area", title:"New area", message:"",
    color:"#58a6ff", icon:"📍", xmin:0, ymin:0, xmax:1, ymax:1,
    sound:true, once:true, cooldownMs:5000, holdMs:6000,
    image:"", linkLabel:"", linkUrl:"",
    occupied:false, wasInside:false, lastFired:0 };
}
// Normalise one entry from zones.config.js into our internal shape.
function fromConfig(z,i){
  const a=z.area||{};
  return { id:++zSeq, name:z.name||("Area "+(i+1)), title:z.title||z.name||"Zone",
    message:z.message||"", color:z.color||"#58a6ff", icon:z.icon||"",
    xmin:Math.min(+a.xmin,+a.xmax), xmax:Math.max(+a.xmin,+a.xmax),
    ymin:Math.min(+a.ymin,+a.ymax), ymax:Math.max(+a.ymin,+a.ymax),
    sound:!!z.sound, once:z.once!==false, cooldownMs:+z.cooldownMs||0, holdMs:+z.holdMs||6000,
    image:z.image||"", linkLabel:(z.link&&z.link.label)||"", linkUrl:(z.link&&z.link.url)||"",
    occupied:false, wasInside:false, lastFired:0 };
}
function defaultsFromConfig(){
  zSeq=0;
  const cfg = Array.isArray(window.ZONE_TRIGGERS)?window.ZONE_TRIGGERS:[];
  return cfg.map(fromConfig).filter(z=>[z.xmin,z.xmax,z.ymin,z.ymax].every(isFinite));
}
const EDIT_FIELDS = ["id","name","title","message","color","icon","xmin","ymin","xmax","ymax",
                     "sound","once","cooldownMs","holdMs","image","linkLabel","linkUrl"];
function saveZones(){
  const out = zones.map(z=>{ const o={}; EDIT_FIELDS.forEach(k=>o[k]=z[k]); return o; });
  localStorage.setItem(ZKEY, JSON.stringify(out));
}
function loadZones(){
  let saved=null;
  try{ saved=JSON.parse(localStorage.getItem(ZKEY)||"null"); }catch(e){}
  if(Array.isArray(saved)){
    zones = saved.map(z=>({ ...z, occupied:false, wasInside:false, lastFired:0 }));
    zones.forEach(z=>{ if(z.id>zSeq) zSeq=z.id; });
  }else{
    zones = defaultsFromConfig();           // first run: seed from the config file
    saveZones();
  }
}

// ---- editor rendering ----
function zoneCardHTML(z){
  const num=(f,lbl,step)=>`<div><label>${lbl}</label><input class="zf" data-f="${f}" type="number" step="${step||'0.1'}" value="${z[f]}"></div>`;
  return `<details class="zcard" data-id="${z.id}">
    <summary>
      <span class="swatch" data-role="sw" style="background:${esc(z.color)}"></span>
      <span class="nm" data-role="nm">${esc(z.name)}</span>
      <span class="pill" data-role="st">—</span>
    </summary>
    <div class="zedit">
      <label>Room / area name</label>
      <input class="zf" data-f="name" type="text" value="${esc(z.name)}">
      <label>Pop-up title</label>
      <input class="zf" data-f="title" type="text" value="${esc(z.title)}">
      <label>Message (the information shown)</label>
      <textarea class="zf" data-f="message" rows="2">${esc(z.message)}</textarea>
      <div class="row">
        <div><label>Colour</label><input class="zf" data-f="color" type="color" value="${esc(z.color)}"></div>
        <div><label>Icon (emoji)</label><input class="zf" data-f="icon" type="text" maxlength="4" value="${esc(z.icon)}"></div>
      </div>
      <label>Area — metres in the positioning frame</label>
      <div class="row">${num("xmin","x min")}${num("ymin","y min")}</div>
      <div class="row">${num("xmax","x max")}${num("ymax","y max")}</div>
      <button class="sec zdraw" data-id="${z.id}" style="margin-top:8px">Set area by dragging on map</button>
      <hr>
      <label class="check"><input class="zf" data-f="sound" type="checkbox" ${z.sound?"checked":""}> Beep on entry</label>
      <label class="check"><input class="zf" data-f="once" type="checkbox" ${z.once?"checked":""}> Fire once per visit (off = repeat while inside)</label>
      <div class="row">
        <div><label>Re-fire cooldown (ms)</label><input class="zf" data-f="cooldownMs" type="number" step="500" value="${z.cooldownMs}"></div>
        <div><label>Pop-up hold (ms)</label><input class="zf" data-f="holdMs" type="number" step="500" value="${z.holdMs}"></div>
      </div>
      <label>Image URL (optional)</label>
      <input class="zf" data-f="image" type="text" value="${esc(z.image)}">
      <div class="row">
        <div><label>Link label</label><input class="zf" data-f="linkLabel" type="text" value="${esc(z.linkLabel)}"></div>
        <div><label>Link URL</label><input class="zf" data-f="linkUrl" type="text" value="${esc(z.linkUrl)}"></div>
      </div>
      <hr>
      <div class="row">
        <button class="sec ztest" data-id="${z.id}">Test pop-up</button>
        <button class="sec zdel" data-id="${z.id}">Delete area</button>
      </div>
    </div>
  </details>`;
}
function renderZones(){
  if(!zones.length){ trigListEl.innerHTML=`<div class="small" style="color:var(--muted)">No areas yet — press “+ Add area”.</div>`; return; }
  trigListEl.innerHTML = zones.map(zoneCardHTML).join("");
  updateZoneStatus();
}
function cardOf(id){ return trigListEl.querySelector(`.zcard[data-id="${id}"]`); }
function zoneById(id){ return zones.find(z=>z.id==id); }

function updateZoneStatus(){
  zones.forEach(z=>{ const c=cardOf(z.id); if(!c) return;
    const st=c.querySelector("[data-role=st]");
    if(st){ st.textContent=z.occupied?"here":"empty"; st.className="pill "+(z.occupied?"ok":""); }
  });
}

// ---- live field editing (no full re-render, so focus is never lost) ----
function onZoneInput(e){
  const inp=e.target.closest(".zf"); if(!inp) return;
  const card=inp.closest(".zcard"); if(!card) return;
  const z=zoneById(card.dataset.id); if(!z) return;
  const f=inp.dataset.f;
  if(inp.type==="checkbox") z[f]=inp.checked;
  else if(inp.type==="number"){ const v=parseFloat(inp.value); z[f]=isFinite(v)?v:0; }
  else z[f]=inp.value;
  saveZones();
  if(f==="name") card.querySelector("[data-role=nm]").textContent=z.name||"(unnamed)";
  if(f==="color") card.querySelector("[data-role=sw]").style.background=z.color;
  if(["color","xmin","ymin","xmax","ymax","name"].includes(f)) redrawTop();
}
trigListEl.addEventListener("input", onZoneInput);
trigListEl.addEventListener("change", onZoneInput);   // checkboxes/colour commit on change
trigListEl.addEventListener("click", e=>{
  const t=e.target;
  if(t.classList.contains("zdel")){
    const id=t.dataset.id; zones=zones.filter(z=>z.id!=id); saveZones(); renderZones(); redrawTop();
  }else if(t.classList.contains("ztest")){
    const z=zoneById(t.dataset.id); if(z) fireTrigger(z);
  }else if(t.classList.contains("zdraw")){
    startAreaDraw(t.dataset.id);
  }
});

$("addZone").onclick=()=>{
  const z=blankZone();
  // place a sensible default box in the middle of the current view, if we have one
  if(lastTop){ const b=lastTop.b, cx=(b.minX+b.maxX)/2, cy=(b.minY+b.maxY)/2;
    z.xmin=+(cx-0.5).toFixed(2); z.xmax=+(cx+0.5).toFixed(2);
    z.ymin=+(cy-0.5).toFixed(2); z.ymax=+(cy+0.5).toFixed(2); }
  zones.push(z); saveZones(); renderZones(); redrawTop();
  const c=cardOf(z.id); if(c){ c.open=true; c.scrollIntoView({block:"nearest"}); }
};
$("resetZones").onclick=()=>{
  if(!confirm("Replace all areas with the defaults from zones.config.js? Your edits will be lost.")) return;
  zones=defaultsFromConfig(); saveZones(); renderZones(); redrawTop();
};

loadZones(); renderZones();

// ---------------------------------------------------------------------------
// TRIGGER ENGINE
// ---------------------------------------------------------------------------
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
const logRows=[];
function nowHMS(){ const d=new Date(), p=n=>String(n).padStart(2,"0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; }
function logEvent(z,type){
  logRows.unshift({t:nowHMS(),name:z.name,color:z.color,type});
  if(logRows.length>100) logRows.pop();
  renderLog();
}
function renderLog(){
  const box=$("log");
  if(!logRows.length){ box.innerHTML=`<div class="small" style="color:var(--muted)">No zone events yet.</div>`; return; }
  box.innerHTML=logRows.map(r=>`
    <div class="logrow ${r.type==='enter'?'enter':'leave'}">
      <span class="t">${r.t}</span>
      <span class="swatch" style="background:${esc(r.color)}"></span>
      <span class="nm" style="flex:1">${esc(r.name)}</span>
      <span class="what">${r.type==='enter'?'entered':'left'}</span>
    </div>`).join("");
}
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
function fireTrigger(z){ showToast(z); if(z.sound) beep(); logEvent(z,"enter"); }

function inside(p,z){
  return !!(p && p.x>=Math.min(z.xmin,z.xmax) && p.x<=Math.max(z.xmin,z.xmax)
              && p.y>=Math.min(z.ymin,z.ymax) && p.y<=Math.max(z.ymin,z.ymax));
}
function updatePresence(p){
  const t=performance.now();
  zones.forEach(z=>{
    z.occupied=inside(p,z);
    if(z.occupied && !z.wasInside){                       // ENTRY edge
      if(!z.lastFired || !z.cooldownMs || (t-z.lastFired)>=z.cooldownMs){ fireTrigger(z); z.lastFired=t; }
    }else if(z.occupied && z.wasInside && !z.once){        // lingering + repeats allowed
      if(z.cooldownMs && (t-z.lastFired)>=z.cooldownMs){ fireTrigger(z); z.lastFired=t; }
    }else if(!z.occupied && z.wasInside){                  // EXIT edge
      logEvent(z,"leave");
    }
    z.wasInside=z.occupied;
  });
  updateZoneStatus();
  updateNowIn();
}
function updateNowIn(){
  const here=zones.filter(z=>z.occupied);
  $("nowin").innerHTML = here.length
    ? here.map(z=>`<span class="tag" style="background:${esc(z.color)}">${esc(z.name)}</span>`).join(" ")
    : "—";
}

// ---------------------------------------------------------------------------
// math — anchor geometry + trilateration
// ---------------------------------------------------------------------------
function anchorsFromCalib(d12,d13,d23){
  if(!(d12>0&&d13>0&&d23>0)) return null;
  const x3=(d13*d13 - d23*d23 + d12*d12)/(2*d12);
  const y2=d13*d13 - x3*x3;
  const y3=y2>0?Math.sqrt(y2):0;
  return [{x:0,y:0},{x:d12,y:0},{x:x3,y:y3}];
}
function trilaterate(A,r,below){
  const [A1,A2,A3]=A, [r1,r2,r3]=r;
  const ex=A2.x-A1.x, ey=A2.y-A1.y;
  const dx=A3.x-A1.x, dy=A3.y-A1.y;
  const dAB=Math.hypot(ex,ey);
  if(dAB<1e-6) return null;
  const ux=ex/dAB, uy=ey/dAB;
  const i = ux*dx + uy*dy;
  const vx=dx-i*ux, vy=dy-i*uy;
  const j = Math.hypot(vx,vy);
  if(j<1e-6) return null;
  const x=(r1*r1 - r2*r2 + dAB*dAB)/(2*dAB);
  const y=(r1*r1 - r3*r3 + i*i + j*j - 2*i*x)/(2*j);
  let z2=r1*r1 - x*x - y*y;
  const z=z2>0?Math.sqrt(z2):0;
  const wx=A1.x + x*ux + y*(vx/j);
  const wy=A1.y + x*uy + y*(vy/j);
  const wz = below? -z : z;
  const fit=Math.sqrt(A.reduce((s,a,k)=>{
    const e=Math.hypot(wx-a.x,wy-a.y,wz-0)-r[k]; return s+e*e;},0)/3);
  return {x:wx,y:wy,z:wz,residual:fit};
}

// ---------------------------------------------------------------------------
// live polling + render
// ---------------------------------------------------------------------------
let timer=null, lastSeq=null, lastSeqTime=0, rateHz=0, ema=null;
let calPending=false, calTsBefore=null, calReqAt=0;
let lastTop=null, drawing=false, draft=null, drawTarget=null, gA=null, gP=null, gR=null;

async function tick(){
  const host=$("host").value.trim();
  if(!host){ setDot("bad","no host set"); return; }
  try{
    const [liveR,calR]=await Promise.all([
      fetch(`https://${host}/live.json`,{cache:"no-store"}),
      fetch(`https://${host}/calib.json`,{cache:"no-store"})
    ]);
    const live=await liveR.json();
    const cal =await calR.json().catch(()=>null);
    if(!live){ setDot("stale","no /live data"); return; }
    render(live,cal);
  }catch(e){ setDot("bad","fetch error"); }
}
function setDot(cls,msg){ const d=$("dot"); d.className="dot "+(cls==="ok"?"ok":cls==="stale"?"stale":""); $("age").textContent=msg||""; }
function fmt(v,d=2){ return (v==null||isNaN(v))?"–":v.toFixed(d); }

function render(live,cal){
  const r=[live.d1,live.d2,live.d3].map(Number);
  $("r1").textContent=fmt(r[0])+" m"; $("r2").textContent=fmt(r[1])+" m"; $("r3").textContent=fmt(r[2])+" m";
  $("seq").textContent=live.seq??"–";

  if(live.seq!=null && live.seq!==lastSeq){
    const now=performance.now();
    if(lastSeqTime) rateHz=1000/Math.max(1,(now-lastSeqTime));
    lastSeqTime=now; lastSeq=live.seq;
  }
  $("rate").textContent=rateHz?`${rateHz.toFixed(1)} Hz`:"";
  setDot("ok","live");

  if(calPending && cal){
    if(cal.ts!=null && cal.ts!==calTsBefore){
      calPending=false;
      $("calReq").innerHTML=`<span class="pill ok">done</span> anchors reported new distances`;
    }else if(performance.now()-calReqAt>25000){
      calPending=false;
      $("calReq").innerHTML=`<span class="pill bad">no response</span> are all 3 anchors powered + online?`;
    }
  }

  let A;
  if($("autocal").checked && cal){
    $("d12").textContent=fmt(cal.d12)+" m"; $("d13").textContent=fmt(cal.d13)+" m"; $("d23").textContent=fmt(cal.d23)+" m";
    A=anchorsFromCalib(Number(cal.d12),Number(cal.d13),Number(cal.d23));
    $("calStatus").innerHTML = A
      ? `<span class="pill ok">calibrated</span> auto anchor layout`
      : `<span class="pill bad">waiting</span> anchors haven’t reported all 3 distances yet`;
  }else{
    $("d12").textContent=$("d13").textContent=$("d23").textContent="(manual)";
    A=[{x:+$("a1x").value,y:+$("a1y").value},{x:+$("a2x").value,y:+$("a2y").value},{x:+$("a3x").value,y:+$("a3y").value}];
    $("calStatus").innerHTML=`<span class="pill">manual</span> using entered coordinates`;
  }
  if(!A){ gA=null;gP=null;gR=r; updatePresence(null); drawTop(null,null,r); drawSide(null,null); return; }

  if(r.some(v=>!(v>0))){ $("X").textContent=$("Y").textContent=$("Z").textContent="–"; gA=A;gP=null;gR=r; updatePresence(null); drawTop(A,null,r); drawSide(A,null); return; }
  let p=trilaterate(A,r,$("below").checked);
  if(!p){ $("calStatus").innerHTML+=` <span class="pill bad">colinear anchors</span>`; gA=A;gP=null;gR=r; updatePresence(null); return; }

  const a=+$("ema").value;
  if(a>0 && ema){ p={x:a*ema.x+(1-a)*p.x, y:a*ema.y+(1-a)*p.y, z:a*ema.z+(1-a)*p.z, residual:p.residual}; }
  ema={x:p.x,y:p.y,z:p.z};

  $("X").textContent=fmt(p.x); $("Y").textContent=fmt(p.y); $("Z").textContent=fmt(p.z);
  $("res").textContent=fmt(p.residual,3)+" m";
  gA=A;gP=p;gR=r; updatePresence(p);
  drawTop(A,p,r); drawSide(A,p);
}

// ---------------------------------------------------------------------------
// drawing
// ---------------------------------------------------------------------------
function worldBounds(A,p){
  let xs=A.map(a=>a.x), ys=A.map(a=>a.y);
  if(p){ xs.push(p.x); ys.push(p.y); }
  zones.forEach(z=>{ xs.push(z.xmin,z.xmax); ys.push(z.ymin,z.ymax); });
  let minX=Math.min(...xs),maxX=Math.max(...xs),minY=Math.min(...ys),maxY=Math.max(...ys);
  const pad=Math.max(1,(maxX-minX),(maxY-minY))*0.25+0.5;
  return {minX:minX-pad,maxX:maxX+pad,minY:minY-pad,maxY:maxY+pad};
}
function mapper(b,W,H){
  const sx=W/(b.maxX-b.minX), sy=H/(b.maxY-b.minY), s=Math.min(sx,sy);
  const ox=(W-(b.maxX-b.minX)*s)/2, oy=(H-(b.maxY-b.minY)*s)/2;
  return {X:x=>ox+(x-b.minX)*s, Y:y=>H-(oy+(y-b.minY)*s), s,
          invX:px=>b.minX+(px-ox)/s, invY:py=>b.minY+(H-py-oy)/s};
}
function grid(ctx,W,H){ ctx.fillStyle="#0a0d12";ctx.fillRect(0,0,W,H);
  ctx.strokeStyle="#1b2330";ctx.lineWidth=1;
  for(let x=0;x<=W;x+=40){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,H);ctx.stroke();}
  for(let y=0;y<=H;y+=40){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(W,y);ctx.stroke();}
}
function drawZone(ctx,m,z){
  const xmin=Math.min(z.xmin,z.xmax), xmax=Math.max(z.xmin,z.xmax);
  const ymin=Math.min(z.ymin,z.ymax), ymax=Math.max(z.ymin,z.ymax);
  const x=m.X(xmin), y=m.Y(ymax), w=(xmax-xmin)*m.s, h=(ymax-ymin)*m.s;  // Y flipped → ymax is top
  const col = z.draft ? "#d29922" : (z.color || "#58a6ff");
  ctx.fillStyle=col; ctx.globalAlpha=z.occupied?0.22:0.08; ctx.fillRect(x,y,w,h); ctx.globalAlpha=1;
  ctx.strokeStyle=col; ctx.lineWidth=z.occupied?2:1;
  if(z.draft) ctx.setLineDash([5,4]);
  ctx.strokeRect(x,y,w,h); ctx.setLineDash([]);
  if(z.name){ ctx.fillStyle=z.occupied?col:"#8b949e";
    ctx.fillText(z.name+(z.occupied?" • here":""), x+4, y+14); }
}
function drawTop(A,p,r){
  const c=$("top"),ctx=c.getContext("2d"),W=c.width,H=c.height; grid(ctx,W,H);
  if(!A){ lastTop=null; ctx.fillStyle="#8b949e";ctx.fillText("waiting for anchor geometry…",20,30); return; }
  const b=worldBounds(A,p),m=mapper(b,W,H);
  lastTop={m,W,H,b};
  zones.forEach(z=>drawZone(ctx,m,z));
  if(draft) drawZone(ctx,m,{...draft,name:"",occupied:false,draft:true});
  if(p&&r) A.forEach((a,k)=>{ if(r[k]>0){ ctx.strokeStyle="rgba(88,166,255,.25)";ctx.beginPath();
    ctx.arc(m.X(a.x),m.Y(a.y),r[k]*m.s,0,7); ctx.stroke(); }});
  A.forEach((a,k)=>{ ctx.fillStyle="#d29922"; ctx.beginPath();ctx.arc(m.X(a.x),m.Y(a.y),6,0,7);ctx.fill();
    ctx.fillStyle="#e6edf3";ctx.fillText("A"+(k+1),m.X(a.x)+9,m.Y(a.y)-9); });
  if(p){ ctx.fillStyle="#3fb950"; ctx.beginPath();ctx.arc(m.X(p.x),m.Y(p.y),8,0,7);ctx.fill();
    ctx.strokeStyle="#3fb950";ctx.beginPath();ctx.arc(m.X(p.x),m.Y(p.y),13,0,7);ctx.stroke();
    ctx.fillStyle="#e6edf3";ctx.fillText("TAG",m.X(p.x)+12,m.Y(p.y)+4); }
}
function drawSide(A,p){
  const c=$("side"),ctx=c.getContext("2d"),W=c.width,H=c.height; grid(ctx,W,H);
  if(!A){ ctx.fillStyle="#8b949e";ctx.fillText("waiting…",20,30); return; }
  const xs=A.map(a=>a.x).concat(p?[p.x]:[]);
  const zs=[0].concat(p?[p.z]:[]);
  const b={minX:Math.min(...xs)-1,maxX:Math.max(...xs)+1,minY:Math.min(...zs)-1,maxY:Math.max(...zs)+1};
  const m=mapper(b,W,H);
  ctx.strokeStyle="#d29922";ctx.setLineDash([5,4]);ctx.beginPath();
  ctx.moveTo(0,m.Y(0));ctx.lineTo(W,m.Y(0));ctx.stroke();ctx.setLineDash([]);
  ctx.fillStyle="#8b949e";ctx.fillText("anchor plane (z=0)",10,m.Y(0)-6);
  A.forEach((a,k)=>{ ctx.fillStyle="#d29922";ctx.beginPath();ctx.arc(m.X(a.x),m.Y(0),5,0,7);ctx.fill(); });
  if(p){ ctx.fillStyle="#3fb950";ctx.beginPath();ctx.arc(m.X(p.x),m.Y(p.z),8,0,7);ctx.fill();
    ctx.strokeStyle="#30363d";ctx.beginPath();ctx.moveTo(m.X(p.x),m.Y(0));ctx.lineTo(m.X(p.x),m.Y(p.z));ctx.stroke();
    ctx.fillStyle="#e6edf3";ctx.fillText("z="+p.z.toFixed(2)+"m",m.X(p.x)+10,m.Y(p.z)); }
}

// ---------------------------------------------------------------------------
// start / stop
// ---------------------------------------------------------------------------
$("start").onclick=()=>{ saveCfg(); clearInterval(timer); ema=null;
  try{ audioCtx = audioCtx || new (window.AudioContext||window.webkitAudioContext)(); audioCtx.resume&&audioCtx.resume(); }catch(e){}
  const ms=Math.max(100,+$("poll").value||250); tick(); timer=setInterval(tick,ms); };
$("stop").onclick=()=>{ clearInterval(timer); timer=null; setDot("bad","stopped"); };

// ---------------------------------------------------------------------------
// trigger anchor calibration
// ---------------------------------------------------------------------------
$("calBtn").onclick=async()=>{
  const host=$("host").value.trim();
  if(!host){ $("calReq").innerHTML=`<span class="pill bad">no host</span> set the Firebase host first`; return; }
  const token=Date.now();
  $("calReq").innerHTML=`<span class="pill">requesting…</span>`;
  try{
    const c=await fetch(`https://${host}/calib.json`,{cache:"no-store"}).then(r=>r.json()).catch(()=>null);
    calTsBefore=c&&c.ts!=null?c.ts:null;
    const r=await fetch(`https://${host}/control/calibrate.json`,{method:"PUT",body:JSON.stringify(token)});
    if(!r.ok) throw new Error(r.status);
    calPending=true; calReqAt=performance.now();
    $("calReq").innerHTML=`<span class="pill ok">requested</span> anchors will measure on next poll (~3 s)…`;
  }catch(e){
    calPending=false;
    $("calReq").innerHTML=`<span class="pill bad">failed</span> could not reach Firebase`;
  }
};

// ---------------------------------------------------------------------------
// set a zone's area by dragging on the Top view
// ---------------------------------------------------------------------------
const topC=$("top");
function redrawTop(){ if(gA) drawTop(gA,gP,gR); else drawTop(null,null,null); }
function evToWorld(e){
  if(!lastTop) return null;
  const r=topC.getBoundingClientRect();
  const px=(e.clientX-r.left)*(topC.width/r.width);
  const py=(e.clientY-r.top)*(topC.height/r.height);
  return {x:lastTop.m.invX(px), y:lastTop.m.invY(py)};
}
function startAreaDraw(id){
  if(!lastTop){ $("zoneHint").textContent="Press Start first — the map needs the anchor geometry before you can draw."; return; }
  drawing=true; drawTarget=id; draft=null;
  const z=zoneById(id);
  $("zoneHint").textContent=`Drag a box on the Top view to set “${z?z.name:"area"}”.`;
}
topC.addEventListener("pointerdown",e=>{
  if(!drawing) return; const w=evToWorld(e); if(!w) return;
  draft={xmin:w.x,ymin:w.y,xmax:w.x,ymax:w.y}; topC.setPointerCapture(e.pointerId);
});
topC.addEventListener("pointermove",e=>{
  if(!drawing||!draft) return; const w=evToWorld(e); if(!w) return;
  draft.xmax=w.x; draft.ymax=w.y; redrawTop();
});
topC.addEventListener("pointerup",e=>{
  if(!drawing||!draft) return; const w=evToWorld(e); if(w){ draft.xmax=w.x; draft.ymax=w.y; }
  const xmin=Math.min(draft.xmin,draft.xmax), xmax=Math.max(draft.xmin,draft.xmax);
  const ymin=Math.min(draft.ymin,draft.ymax), ymax=Math.max(draft.ymin,draft.ymax);
  const z=zoneById(drawTarget);
  drawing=false; draft=null;
  $("zoneHint").textContent="Tap an area to edit it. Every field saves automatically in your browser.";
  if(z && (xmax-xmin)>0.05 && (ymax-ymin)>0.05){
    z.xmin=+xmin.toFixed(2); z.xmax=+xmax.toFixed(2); z.ymin=+ymin.toFixed(2); z.ymax=+ymax.toFixed(2);
    saveZones();
    const c=cardOf(z.id);            // reflect new numbers in the open editor, if present
    if(c){ ["xmin","ymin","xmax","ymax"].forEach(f=>{ const el=c.querySelector(`.zf[data-f="${f}"]`); if(el) el.value=z[f]; }); }
  }
  drawTarget=null;
  redrawTop();
});

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------
renderLog();
if($("host").value.trim()) $("start").onclick();
if(!timer){ drawTop(null,null,null); drawSide(null,null); }
