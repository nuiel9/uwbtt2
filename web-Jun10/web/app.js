// Tourist Room Guide web app
// - Replace firebaseConfig with your project's config to use real data
// - Expects Realtime Database structure: /tags/{tagId} -> { x: number, y: number, ts: number }

const FIREBASE_CONFIG = null; // paste your firebase config object here to enable live mode
const DB_PATH = '/tags'; // base path where ESP32 writes tag positions

// ── Live mode (real hardware) ───────────────────────────────────────────────
// The ESP32 firmware does NOT write x,y to /tags. It writes raw anchor distances
// to /live ({d1,d2,d3,...}) and anchor-to-anchor distances to /calib. This live
// mode reads those over plain REST, trilaterates to x,y here, and feeds the same
// attraction/audio logic the simulator uses. No Firebase SDK / API key needed.
const LIVE_FIREBASE_HOST = 'uwb-positioning-a2892-default-rtdb.asia-southeast1.firebasedatabase.app';
const LIVE_POLL_MS = 300;
let liveTimer = null, liveEma = null;

const ATTRACTIONS = [
  // Rectangular room (10 wide × 6 deep). Labels A→F flow in ascending order
  // across the room: top wall left→right, then bottom wall left→right.
  // Top wall:    A(0,0) — B(5,0)  — C(10,0)
  // Bottom wall: D(0,6) — E(5,6)  — F(10,6)
  { id: 'A', x: 0,  y: 0, title: 'Long Building', desc: 'Historic long building — a landmark of the campus.',           image: 'attractions/a1-Long-building.jpeg', audio: 'attractions/a1-Long-building.mp3' },
  { id: 'B', x: 5,  y: 0, title: 'Luang Pu',      desc: 'Statue and shrine of Luang Pu, a revered figure.',               image: 'attractions/a2-Luang-Pu.jpeg',      audio: 'attractions/a2-Luang-Pu.mp3' },
  { id: 'C', x: 10, y: 0, title: 'Planetarium',   desc: 'Planetarium dome — explore the stars and solar system.',      image: 'attractions/a3-Planetarium.jpeg',   audio: 'attractions/a3-Planetarium.mp3' },
  { id: 'D', x: 0,  y: 6, title: 'Edu Museum',    desc: 'Educational museum with rotating science and history exhibits.', image: 'attractions/a4-Edu-Museum.jpg',     audio: 'attractions/a4-Edu-Museum.mp3' },
  { id: 'E', x: 5,  y: 6, title: 'King Rama V',   desc: 'Monument honoring King Rama V (Chulalongkorn the Great).',       image: 'attractions/a5-KingRamaV.jpg',      audio: 'attractions/a5-KingRamaV.mp3' },
  { id: 'F', x: 10, y: 6, title: 'Horror',        desc: 'Horror attraction — not for the faint-hearted.',               image: 'attractions/a6-Horror.jpeg',        audio: 'attractions/a6-Horror.mp3' }
];

const ROOM_SIZE = { w: 10, h: 6 }; // default coordinate bounds (overridden live)
const TRIGGER_RADIUS = 1.2; // default proximity radius (per-attraction radius wins)

// Live mode can replace these from the control site's /display (so both front
// ends share the same attractions). Until then they're the defaults above.
let attractions = ATTRACTIONS.map(a => ({ ...a }));
let bounds = { minX: 0, minY: 0, maxX: ROOM_SIZE.w, maxY: ROOM_SIZE.h };

let selectedTag = '1';
let audioUnlocked = false;

const state = { tags: {} };

// DOM refs
const mapEl = document.getElementById('map');
const infoTitle = document.getElementById('point-title');
const infoDesc = document.getElementById('point-desc');
const infoImg = document.getElementById('point-img');
const infoAudio = document.getElementById('point-audio');
const statusText = document.getElementById('status-text');
const simTagLabel = document.getElementById('sim-tag');

// audio element used to unlock iOS audio playback
const audioPlayer = new Audio();

function init() {
  // render attractions
  recomputeBounds();
  renderAttractions();

  // tag buttons
  document.querySelectorAll('.tag-btn').forEach(b => {
    b.addEventListener('click', () => selectTag(b.dataset.tag));
  });
  selectTag('1');

  document.getElementById('unlock-audio').addEventListener('click', () => {
    // play a short silent sound to unlock audio on iOS
    audioPlayer.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=';
    audioPlayer.play().catch(()=>{}).then(()=>{ audioUnlocked = true; statusText.textContent = 'Audio enabled'; });
  });

  // simulator controls
  const simX = document.getElementById('sim-x');
  const simY = document.getElementById('sim-y');
  const simSend = document.getElementById('sim-send');
  const simTag = document.getElementById('sim-tag');
  simX.addEventListener('input', ()=> document.getElementById('simx').textContent = simX.value);
  simY.addEventListener('input', ()=> document.getElementById('simy').textContent = simY.value);
  simSend.addEventListener('click', ()=> {
    simTag.textContent = selectedTag;
    const payload = { x: parseFloat(simX.value), y: parseFloat(simY.value), ts: Date.now() };
    onTagUpdate(selectedTag, payload);
  });

  // draw initial tag marker
  drawTagMarker(selectedTag, { x: -1, y: -1 });

  // auto-walk buttons
  document.getElementById('walk-start').addEventListener('click', startAutoWalk);
  document.getElementById('walk-stop').addEventListener('click', stopAutoWalk);

  // live (real hardware) controls
  const liveHost = document.getElementById('live-host');
  if (liveHost && !liveHost.value) liveHost.value = LIVE_FIREBASE_HOST;
  const lc = document.getElementById('live-connect');
  if (lc) lc.addEventListener('click', connectLive);
  const ld = document.getElementById('live-disconnect');
  if (ld) ld.addEventListener('click', () => { disconnectLive(); statusText.textContent = 'Live disconnected.'; });

  // attempt Firebase connect if config present
  if (FIREBASE_CONFIG) connectFirebase();
  else statusText.textContent = 'No Firebase config — running in simulator mode.';
}

function pctX(x){ return ((x - bounds.minX) / (bounds.maxX - bounds.minX)) * 100; }
function pctY(y){ return ((y - bounds.minY) / (bounds.maxY - bounds.minY)) * 100; }

// Fit the map to the current attractions (plus a margin). Keeps markers on-screen
// whatever coordinate frame the real anchors produce.
function recomputeBounds(){
  if (!attractions.length){ bounds = { minX:0, minY:0, maxX:ROOM_SIZE.w, maxY:ROOM_SIZE.h }; }
  else {
    const xs = attractions.map(a=>a.x), ys = attractions.map(a=>a.y);
    let minX=Math.min(...xs), maxX=Math.max(...xs), minY=Math.min(...ys), maxY=Math.max(...ys);
    const padX = Math.max(1, maxX-minX)*0.18 + 0.8, padY = Math.max(1, maxY-minY)*0.18 + 0.8;
    bounds = { minX:minX-padX, maxX:maxX+padX, minY:minY-padY, maxY:maxY+padY };
  }
  // match the map element's aspect ratio to the coordinate frame
  mapEl.style.aspectRatio = (bounds.maxX-bounds.minX) + ' / ' + (bounds.maxY-bounds.minY);
}

// (Re)draw the attraction markers + range rings from `attractions`.
function renderAttractions(){
  mapEl.querySelectorAll('.marker.attraction, .range-ring').forEach(el => el.remove());
  const spanX = bounds.maxX - bounds.minX, spanY = bounds.maxY - bounds.minY;
  attractions.forEach(pt => {
    const el = document.createElement('div');
    el.className = 'marker attraction';
    el.textContent = pt.id;
    el.style.left = pctX(pt.x) + '%';
    el.style.top = pctY(pt.y) + '%';
    el.title = pt.title;
    mapEl.appendChild(el);

    const ring = document.createElement('div');
    ring.className = 'range-ring';
    const radius = pt.radius || TRIGGER_RADIUS;
    ring.style.width  = ((2*radius / spanX) * 100) + '%';
    ring.style.height = ((2*radius / spanY) * 100) + '%';
    ring.style.left = pctX(pt.x) + '%';
    ring.style.top = pctY(pt.y) + '%';
    mapEl.appendChild(ring);
  });
}

function selectTag(tag){
  selectedTag = String(tag);
  document.querySelectorAll('.tag-btn').forEach(b=>b.classList.toggle('active', b.dataset.tag===selectedTag));
  document.getElementById('sim-tag').textContent = selectedTag;
}

function drawTagMarker(tagId, pos){
  let el = document.querySelector('.marker.tag[data-tag="'+tagId+'"]');
  if (!el){
    el = document.createElement('div');
    el.className = 'marker tag';
    el.dataset.tag = tagId;
    el.textContent = tagId;
    mapEl.appendChild(el);
  }
  if (pos.x == null) { el.style.display='none'; return; }
  el.style.display='block';
  el.style.left = pctX(pos.x) + '%';
  el.style.top = pctY(pos.y) + '%';
}

function onTagUpdate(tagId, payload){
  state.tags[tagId] = payload;
  if (tagId === selectedTag) {
    drawTagMarker(tagId, payload);
    const near = findNearestAttraction(payload);
    const radius = near && near.attraction ? (near.attraction.radius || TRIGGER_RADIUS) : TRIGGER_RADIUS;
    if (near && near.dist <= radius){
      showAttraction(near.attraction);
      playGuide(near.attraction);
    } else {
      clearAttraction();
    }
  }
}

function findNearestAttraction(pos){
  if (!pos || typeof pos.x !== 'number') return null;
  let best = null;
  for(const a of attractions){
    const dx = pos.x - a.x;
    const dy = pos.y - a.y;
    const d = Math.sqrt(dx*dx + dy*dy);
    if (!best || d < best.dist) best = { attraction: a, dist: d };
  }
  return best;
}

let currentShown = null;
function showAttraction(a){
  if (currentShown && currentShown.id === a.id) return;
  currentShown = a;
  infoTitle.textContent = a.title;
  infoDesc.textContent = a.desc;
  if (infoImg){
    if (a.image){
      infoImg.src = a.image;
      infoImg.alt = a.title;
      infoImg.style.display = 'block';
    } else {
      infoImg.removeAttribute('src');
      infoImg.style.display = 'none';
    }
  }
  if (infoAudio){
    if (a.audio){
      infoAudio.src = a.audio;
      infoAudio.style.display = 'block';
    } else {
      infoAudio.removeAttribute('src');
      infoAudio.style.display = 'none';
    }
  }
}

function clearAttraction(){
  currentShown = null;
  infoTitle.textContent = 'No attraction nearby';
  infoDesc.textContent = 'Move near an attraction point to see details and hear the audio guide.';
  if (infoImg){ infoImg.removeAttribute('src'); infoImg.style.display = 'none'; }
  if (infoAudio){
    try { infoAudio.pause(); } catch(e) {}
    infoAudio.removeAttribute('src');
    infoAudio.style.display = 'none';
  }
}

function playGuide(a){
  // Play the recorded audio file for this attraction.
  if (!a.audio || !infoAudio) return;
  infoAudio.src = a.audio;
  infoAudio.play()
    .then(()  => statusText.textContent = 'Playing audio: ' + a.title)
    .catch(err => {
      if (!audioUnlocked) statusText.textContent = 'Tap Enable Audio, then move near an attraction.';
      else statusText.textContent = 'Audio play failed: ' + err.message;
    });
}

// ─── Auto Walk Simulator ────────────────────────────────────────────────────
// All tags start from the middle of the left wall, then visit every attraction
// once per loop on a shifted schedule (no two tags share the same attraction
// at the same step). For each visit the tag walks for WALK_TRAVEL_MS and then
// dwells at the attraction for WALK_DWELL_MS before moving to the next one.
const WALK_TRAVEL_MS = 3 * 1000;   // 3 s walking between attractions
const WALK_DWELL_DEFAULT_MS = 90 * 1000; // default 90 s stop at each attraction
let   walkDwellMs = WALK_DWELL_DEFAULT_MS; // updated from the dwell radio at Start
const WALK_UPDATE_MS = 200;        // position update cadence while walking

// Starting position for every tag: middle of the left-side wall.
const WALK_START = { x: 0, y: ROOM_SIZE.h / 2 };

// Schedules map: tagIndex → attraction index order. Each tag visits all six
// attractions exactly once per loop, starting with a different one so no two
// tags ever target the same attraction during the same step.
const WALK_SCHEDULES = [
  [0, 1, 2, 3, 4, 5], // Tag 1 → A, B, C, D, E, F
  [1, 2, 3, 4, 5, 0], // Tag 2 → B, C, D, E, F, A
  [2, 3, 4, 5, 0, 1], // Tag 3 → C, D, E, F, A, B
];
const WALK_LEN = WALK_SCHEDULES[0].length;
const WALK_TAGS = ['1', '2', '3'];

// Current position of each tag (updated as they walk). Initialised on start.
const walkPos = {
  '1': { ...WALK_START },
  '2': { ...WALK_START },
  '3': { ...WALK_START },
};

let walkStep    = 0;
let walkRunning = false;
let walkTimers  = [];

// Pluggable write function: set by connectFirebase when available, else local
let fbWrite = null; // (tagId, payload) => void

function lerp(a, b, t){ return a + (b - a) * t; }

function walkLog(msg){
  const el = document.getElementById('walk-log');
  if (!el) return;
  const li = document.createElement('li');
  li.textContent = new Date().toLocaleTimeString() + ' — ' + msg;
  el.prepend(li);
  // keep last 30 lines
  while (el.children.length > 30) el.removeChild(el.lastChild);
}

function walkSetStatus(msg){
  const el = document.getElementById('walk-status');
  if (el) el.textContent = msg;
}

function sendTagPos(tagId, pos){
  const payload = { x: pos.x, y: pos.y, ts: Date.now() };
  if (fbWrite) {
    fbWrite(tagId, payload);
  } else {
    // no Firebase — update local app state so the map still shows movement
    onTagUpdate(tagId, payload);
  }
}

// Animate every tag from its current position to its per-tag destination over
// `durationMs`. Returns a Promise that resolves when the move (or cancellation)
// is done. `getDest(tagId)` returns the target {x,y} for each tag.
function animateTags(getDest, durationMs){
  return new Promise(resolve => {
    const from = {};
    WALK_TAGS.forEach(t => { from[t] = { ...walkPos[t] }; });
    const start = Date.now();

    const animId = setInterval(() => {
      if (!walkRunning){ clearInterval(animId); resolve(); return; }
      const t = Math.min((Date.now() - start) / durationMs, 1);
      WALK_TAGS.forEach(tagId => {
        const dest = getDest(tagId);
        const cx = parseFloat(lerp(from[tagId].x, dest.x, t).toFixed(2));
        const cy = parseFloat(lerp(from[tagId].y, dest.y, t).toFixed(2));
        walkPos[tagId] = { x: cx, y: cy };
        sendTagPos(tagId, { x: cx, y: cy });
      });
      if (t >= 1){
        clearInterval(animId);
        // snap exactly to destination
        WALK_TAGS.forEach(tagId => {
          const dest = getDest(tagId);
          walkPos[tagId] = { x: dest.x, y: dest.y };
          sendTagPos(tagId, { x: dest.x, y: dest.y });
        });
        resolve();
      }
    }, WALK_UPDATE_MS);
    walkTimers.push(animId);
  });
}

function waitMs(ms){
  return new Promise(resolve => {
    const id = setTimeout(() => { resolve(); }, ms);
    walkTimers.push(id);
  });
}

async function runWalkStep(){
  while (walkRunning){
    const destinations = WALK_TAGS.map((tagId, ti) => ({
      tagId,
      attr: ATTRACTIONS[ WALK_SCHEDULES[ti][walkStep % WALK_LEN] ]
    }));
    const destMap = Object.fromEntries(destinations.map(d => [d.tagId, d.attr]));

    const stepLabel = `Loop ${Math.floor(walkStep / WALK_LEN) + 1}, step ${(walkStep % WALK_LEN) + 1}/${WALK_LEN}`;
    walkLog(stepLabel + ': ' + destinations.map(d => `Tag${d.tagId}→${d.attr.id}(${d.attr.x},${d.attr.y})`).join(' | '));
    walkSetStatus(`${stepLabel} — walking (3 s) …`);

    await animateTags(tagId => destMap[tagId], WALK_TRAVEL_MS);
    if (!walkRunning) return;

    const dwellSec = Math.round(walkDwellMs / 1000);
    walkSetStatus(`${stepLabel} — stopped at attraction (${dwellSec} s) …`);
    await waitMs(walkDwellMs);
    if (!walkRunning) return;

    walkStep++;
  }
}

function startAutoWalk(){
  if (walkRunning) return;
  // read the dwell-time choice from the radio group
  const chosen = document.querySelector('input[name="walk-dwell"]:checked');
  const secs = chosen ? parseInt(chosen.value, 10) : 90;
  walkDwellMs = (Number.isFinite(secs) && secs > 0 ? secs : 90) * 1000;
  walkRunning = true;
  walkStep    = 0;
  // place every tag at the starting point and broadcast that position
  WALK_TAGS.forEach(tagId => {
    walkPos[tagId] = { ...WALK_START };
    sendTagPos(tagId, { ...WALK_START });
  });
  // lock the dwell radios while running
  document.querySelectorAll('input[name="walk-dwell"]').forEach(r => r.disabled = true);
  document.getElementById('walk-start').disabled = true;
  document.getElementById('walk-stop').disabled  = false;
  walkLog(`Auto walk started — dwell ${Math.round(walkDwellMs/1000)} s; tags at left-wall midpoint (${WALK_START.x}, ${WALK_START.y}).`);
  runWalkStep();
}

async function stopAutoWalk(){
  if (!walkRunning) return;
  // signal the loop to exit and cancel any pending timers
  walkRunning = false;
  walkTimers.forEach(id => { clearTimeout(id); clearInterval(id); });
  walkTimers = [];
  document.getElementById('walk-stop').disabled = true;
  walkSetStatus('Stopping — returning tags to start …');
  walkLog('Auto walk stopped — returning to left-wall midpoint.');

  // Animate all tags back to the start over WALK_TRAVEL_MS.
  // Re-enable the walk loop flag briefly so animateTags actually runs.
  walkRunning = true;
  await animateTags(() => WALK_START, WALK_TRAVEL_MS);
  walkRunning = false;
  walkTimers.forEach(id => { clearTimeout(id); clearInterval(id); });
  walkTimers = [];

  walkSetStatus('Stopped — tags parked at start.');
  document.getElementById('walk-start').disabled = false;
  document.querySelectorAll('input[name="walk-dwell"]').forEach(r => r.disabled = false);
}

// ─── Firebase connect (optional) ────────────────────────────────────────────
// uses dynamic import to avoid requiring firebase when not used
async function connectFirebase(){
  statusText.textContent = 'Connecting to Firebase...';
  try{
    const mod = await import('https://www.gstatic.com/firebasejs/9.23.0/firebase-app.js');
    const dbmod = await import('https://www.gstatic.com/firebasejs/9.23.0/firebase-database.js');
    const app = firebaseInitializeApp(FIREBASE_CONFIG, mod);
    const database = dbmod.getDatabase(app);
    const baseRef = dbmod.ref(database, DB_PATH);
    statusText.textContent = 'Connected to Firebase — listening for tag updates.';

    // expose a write function so the auto-walk simulator can push to Firebase
    fbWrite = (tagId, payload) => {
      const tagRef = dbmod.ref(database, DB_PATH + '/' + tagId);
      dbmod.set(tagRef, payload).catch(err => console.error('fbWrite error:', err));
    };

    // listen for child_changed / added
    dbmod.onChildChanged(baseRef, snap => handleFirebaseChild(snap));
    dbmod.onChildAdded(baseRef, snap => handleFirebaseChild(snap));
    // initial read
    dbmod.get(baseRef).then(snapshot=>{
      snapshot.forEach(s => handleFirebaseChild(s));
    });
  }catch(err){
    statusText.textContent = 'Firebase init error: '+err.message;
  }
}

function firebaseInitializeApp(cfg, mod){
  // firebase v9 has initializeApp in the module passed
  return mod.initializeApp(cfg);
}

function handleFirebaseChild(snap){
  try{
    const id = snap.key;
    const val = snap.val();
    // expect { x: number, y: number, ts: number }
    if (val && typeof val.x === 'number'){
      onTagUpdate(id, val);
    }
  }catch(e){ console.error(e); }
}

// ─── Live mode: trilaterate the real tag from /live + /calib ─────────────────
function anchorsFromCalib(d12, d13, d23){
  if (!(d12 > 0 && d13 > 0 && d23 > 0)) return null;
  const x3 = (d13*d13 - d23*d23 + d12*d12) / (2*d12);
  const y2 = d13*d13 - x3*x3, y3 = y2 > 0 ? Math.sqrt(y2) : 0;
  return [{x:0,y:0}, {x:d12,y:0}, {x:x3,y:y3}];
}
function trilaterate(A, r){
  const [A1,A2,A3] = A, [r1,r2,r3] = r;
  const ex = A2.x-A1.x, ey = A2.y-A1.y, dx = A3.x-A1.x, dy = A3.y-A1.y;
  const dAB = Math.hypot(ex,ey); if (dAB < 1e-6) return null;
  const ux = ex/dAB, uy = ey/dAB, i = ux*dx + uy*dy, vx = dx-i*ux, vy = dy-i*uy, j = Math.hypot(vx,vy);
  if (j < 1e-6) return null;
  const x = (r1*r1 - r2*r2 + dAB*dAB) / (2*dAB);
  const y = (r1*r1 - r3*r3 + i*i + j*j - 2*i*x) / (2*j);
  return { x: A1.x + x*ux + y*(vx/j), y: A1.y + x*uy + y*(vy/j) };
}
function setLiveStatus(msg){ const el = document.getElementById('live-status'); if (el) el.textContent = msg; }

// Build the attraction list from the control site's /display zones, so both
// front ends show the same places (correct coordinates + image + audio).
let liveAttrSig = '';
function applyDisplayAttractions(disp){
  if (!disp || !Array.isArray(disp.zones)) return;
  const sig = JSON.stringify(disp.zones.map(z => [z.name, z.xmin, z.ymin, z.xmax, z.ymax]));
  if (sig === liveAttrSig) return;           // unchanged — don't rebuild markers
  liveAttrSig = sig;
  attractions = disp.zones.map((z, i) => ({
    id: (z.icon || (z.name||'?').slice(0,2)),
    x: (Number(z.xmin) + Number(z.xmax)) / 2,
    y: (Number(z.ymin) + Number(z.ymax)) / 2,
    radius: Math.max(Math.abs(z.xmax - z.xmin), Math.abs(z.ymax - z.ymin)) / 2 || TRIGGER_RADIUS,
    title: z.title || z.name || ('Area ' + (i+1)),
    desc: z.message || '',
    image: z.image || '',
    audio: z.audio || ''
  }));
  recomputeBounds();
  renderAttractions();
}

async function livePoll(host){
  try{
    const [lr, cr, dr] = await Promise.all([
      fetch(`https://${host}/live.json`,    { cache:'no-store' }),
      fetch(`https://${host}/calib.json`,   { cache:'no-store' }),
      fetch(`https://${host}/display.json`, { cache:'no-store' })
    ]);
    const live = await lr.json();
    const cal  = await cr.json().catch(() => null);
    const disp = await dr.json().catch(() => null);
    applyDisplayAttractions(disp);
    if (!live){ setLiveStatus('Connected — waiting for /live data (is the tag on?).'); return; }
    if (!cal || !(cal.d12 > 0 && cal.d13 > 0 && cal.d23 > 0)){
      setLiveStatus('Connected — no calibration yet. Press “Calibrate anchors” on the control site.'); return;
    }
    const A = anchorsFromCalib(Number(cal.d12), Number(cal.d13), Number(cal.d23));
    const r = [live.d1, live.d2, live.d3].map(Number);
    if (r.some(v => !(v > 0))){ setLiveStatus('Connected — waiting for all 3 tag ranges…'); return; }
    let p = trilaterate(A, r);
    if (!p){ setLiveStatus('Connected — anchors look colinear; check calibration.'); return; }
    if (liveEma){ p = { x: 0.3*liveEma.x + 0.7*p.x, y: 0.3*liveEma.y + 0.7*p.y }; }
    liveEma = p;
    setLiveStatus(`Live — tag at (${p.x.toFixed(2)}, ${p.y.toFixed(2)}) m`);
    onTagUpdate(selectedTag, { x: p.x, y: p.y, ts: live.ts || Date.now() });
  }catch(e){
    setLiveStatus('Fetch error — check the host and your internet connection.');
  }
}
function connectLive(){
  const raw = (document.getElementById('live-host').value || '').trim();
  const host = raw.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  if (!host){ setLiveStatus('Enter a Firebase host first.'); return; }
  disconnectLive();
  liveEma = null;
  livePoll(host);
  liveTimer = setInterval(() => livePoll(host), LIVE_POLL_MS);
  document.getElementById('live-connect').disabled = true;
  document.getElementById('live-disconnect').disabled = false;
  statusText.textContent = 'Live mode — reading /live from ' + host;
}
function disconnectLive(){
  if (liveTimer){ clearInterval(liveTimer); liveTimer = null; }
  const c = document.getElementById('live-connect'), d = document.getElementById('live-disconnect');
  if (c) c.disabled = false;
  if (d) d.disabled = true;
}

window.addEventListener('load', init);
