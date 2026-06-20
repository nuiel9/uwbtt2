# uwbtt2 — UWB Indoor Positioning (3 anchors + tag)

Real-time indoor positioning with Qorvo **DW3000** UWB radios on **ESP32-S3**.
A mobile **tag** ranges to 3 fixed **anchors**, the distances go to **Firebase**,
and a **web app** trilaterates them into live **X / Y / Z** coordinates.

Anchor geometry is found by **web-triggered calibration**: you press
**“Calibrate anchors”** in the web app, the anchors range each other over UWB
once and publish the anchor-to-anchor distances, and the app derives the anchor
layout itself — you never measure or type in anchor positions. The anchors do
**not** calibrate on their own anymore; they only do it when asked.

You can also draw **presence zones** on the live map to detect whether the tag
is currently inside a given area of the room.

```
   TAG  ──poll/response (SS-TWR)──►  ANCHOR 1 / 2 / 3
    │                                     │  (range each other on request = calib)
    │ WiFi: PUT /live  {d1,d2,d3}         │ WiFi: PATCH /calib {d12,d13,d23}
    ▼                                     ▲  GET /control/calibrate  (poll for request)
            Firebase Realtime Database ───┘
              │  control site: GET /live,/calib · PUT /control/calibrate, /display
              │  viewer site:  GET /live,/calib,/display   (read-only)
              ▼
   index.html (control: setup + zone editor)   viewer.html (map + notifications)
```

## Repository layout

| Path | What it is |
|------|------------|
| `uwb-tag/`     | Tag firmware (initiator). Ranges all 3 anchors, uploads to `/live`. |
| `UWB-ANCHOR/`  | Anchor firmware (responder **+ web-triggered calibration**). One build, set `ANCHOR_ID` per board. |
| `web/` | Web app (no build step) — trilateration, live visualisation, and **zone triggers**. See files below. |

The `web/` folder is a static site (just open `web/index.html`):

| File | What it is |
|------|------------|
| `index.html` / `app.js` | **Control site** — all setup: host, calibration, geometry, telemetry, and the zone editor. |
| `viewer.html` / `viewer.js` | **Viewer site** — read-only website: welcome → pick a map → live map + notifications → responses history. |
| `styles.css`      | Shared styling. |
| `zones.config.js` | Default trigger areas (seed for the control site's editor). |

The **control site** is where you configure everything; it publishes its zones +
render options to Firebase `/display`. The **viewer site** reads `/display` (plus
`/live` and `/calib`) and just shows the map and pops notifications — handy for a
wall display or phone with no controls. Open it from the control site's
**“Open viewer”** button, or directly as `viewer.html?host=YOUR-DB`.

---

## 1. Firmware setup

Both projects build with PlatformIO for `esp32-s3-devkitc-1`.

### Anchors (`UWB-ANCHOR/src/main.cpp`)
Flash the **same** firmware to all three boards, changing two things per board:

1. `#define ANCHOR_ID 1` → set to **1, 2, 3** (unique per board).
2. Fill in `WIFI_SSID`, `WIFI_PASSWORD`, `FIREBASE_HOST` so anchors can upload
   their calibration. *(Leave blank to disable WiFi — calibration distances
   still print to the serial monitor.)*

How web-triggered calibration works: pressing **“Calibrate anchors”** in the web
app writes a fresh token to `/control/calibrate`. Each anchor polls that key
(every `CALIB_POLL_MS`, 3 s) and, when it sees a new token, ranges its peers
**once** and `PATCH`es `/calib`. The **lower-ID** anchor of each pair initiates,
so Anchor 1 measures `d12`/`d13`, Anchor 2 measures `d23`, Anchor 3 only
responds. Because all anchors get the token at once, each one staggers its start
by `(ANCHOR_ID-1) × CALIB_STAGGER_MS` (1.2 s) so the lower-ID anchor can range a
peer while that peer is still listening — this is what lets `d12` land. At boot
an anchor adopts whatever token is already present **without** calibrating, so it
never calibrates on power-up. Calibration values persist in Firebase, so you only
need to press the button again if the anchors physically move. The rest of the
time the anchors are normal responders for the tag.

### Tag (`uwb-tag/src/main.cpp`)
Fill in `WIFI_SSID`, `WIFI_PASSWORD`, `FIREBASE_HOST`. It ranges anchors 1→2→3
each loop and `PUT`s the distances to `/live` (~3 Hz).

---

## 2. Firebase

Create a **Realtime Database**. For prototyping set the rules open
(read+write `true`) — the firmware uploads without auth, matching the existing
`setInsecure()` approach. `FIREBASE_HOST` is the DB URL **without** `https://`
and **without** a trailing slash, e.g. `my-uwb-default-rtdb.firebaseio.com`.

Data written:

```jsonc
// /live                (tag, ~3 Hz, PUT replaces the node)
{ "d1": 1.83, "d2": 2.41, "d3": 3.05, "seq": 412, "ts": 90213 }

// /calib               (anchors, PATCH merges keys)
{ "d12": 4.02, "d13": 3.55, "d23": 2.98, "ts": 88110 }

// /control/calibrate   (control site, PUT — a token the anchors watch)
1718900000000           // a fresh number each time you press "Calibrate anchors"

// /display             (control site, PUT — config for the read-only viewer)
{ "ts": …, "below": false, "ema": 0.3, "autocal": true,
  "anchors": [ … ], "zones": [ { "name": "Front door", "xmin": 0, … } ] }
```

All distances are in **metres**. A brief ranging dropout **holds the last good
distance** (up to `RANGE_HOLD_MAX` ≈ 9 s) so the tag stays steady; only a
prolonged loss is reported as `-1` ("no data"). Presence zones live only in the
browser (`localStorage`), not in Firebase.

---

## 3. Web app

Open `web/index.html` directly in a browser (double-click), or host it on
Firebase Hosting / any static host. Then:

1. Enter your **Firebase host** (same value as `FIREBASE_HOST`) and press **Start**.
   It's saved in the browser, so next time it auto-starts.
2. With all three anchors powered, press **“Calibrate anchors”** once (under
   *Anchor calibration*). The button shows **requested → done** when the anchors
   report new distances. Do this whenever the anchors move; otherwise the last
   values persist. *(Or turn off “Auto anchor geometry” and type anchor positions
   by hand.)*
3. Leave **“Auto anchor geometry”** on to use the live `/calib` data. The app
   places `A1=(0,0)`, `A2=(d12,0)` and solves `A3` from `d13`/`d23`, then
   trilaterates the tag.

What you get:
- Big **X / Y / Z** readouts (metres) and a **fit residual** (lower = better geometry/ranging).
- **Top view** (X–Y map with anchors, tag, and range circles) and **side view** (X–Z height).
- Live range/calibration telemetry, update rate, and an EMA **smoothing** control to tame jitter.

### Zone triggers — pop up info when the tag enters an area
You set up trigger **areas** entirely **in the page** — no file editing. Under
**Trigger areas**:

- **+ Add area** creates one; tap it to expand the editor.
- Edit **name, pop-up title, message, colour, icon, the area box (metres),
  beep on/off, once-vs-repeat, cooldown, pop-up hold time, an image URL, an
  audio-guide URL, and a link**. Every change **saves automatically in your
  browser** (localStorage).
- **Audio guides:** set an *Audio guide URL* on a zone and that clip plays
  automatically when the tag enters (great for a museum / tour). The viewer shows
  a player so visitors can pause or replay. The starter set in `zones.config.js`
  is the SK TechChange tour — 6 attractions with images + MP3s under
  `web/attractions/`. (Browsers need one tap to allow audio: **Start** on the
  control site, **🔊 Enable audio** on the viewer.)
- **Set area by dragging on map** lets you draw the box on the Top view instead
  of typing coordinates.
- **Test pop-up** previews it; **Delete area** removes it.
- **Reset to defaults** reloads the starting set from `web/zones.config.js`.

When the tag walks into an area, the app shows a **pop-up card** with that info,
optionally **beeps**, sets the header **“In zone”** badge, draws the box in its
colour on the Top view, and adds an **entered / left** line to the **Activity
log**. Firing is on entry, debounced by the cooldown; with *once* off it repeats
while you stay inside.

`web/zones.config.js` only holds the **default** areas (used on first run and by
*Reset to defaults*). Edits made in the page live in that browser; clearing site
data or using another browser starts again from the defaults.

### Viewer site (full read-only website)
`web/viewer.html` is a separate, **read-only** website for a wall display,
tablet, or anyone who shouldn't see the controls. It's a small single-page app
with several screens (navigation bar at the top):

- **Home** — a welcome screen.
- **Maps** — pick which place to watch. A “map” is a saved name + Firebase host,
  stored in that browser; add/edit/delete as many as you like (e.g. several
  rooms or deployments). Selecting one makes it active.
- **Live map** — the live map for the active map, with the same zone
  **notifications** (pop-up cards + beep + an “In zone” badge).
- **Responses** — a running history of every zone **entered / left** event, with
  a per-zone filter and a clear button (kept in the browser).
- **About** — what the system is.

No host field on the main views, no calibration, no editor. The host comes from
the control site's **“Open viewer”** button (which passes `?host=…` and seeds a
map), or you add a map by hand. Everything else — anchor geometry, smoothing, and
the trigger areas — is read live from Firebase `/display`, which the control site
publishes whenever you change a zone or option. So you set things up once on the
control site and every viewer updates automatically.

### About Z (height) — important
Three anchors define a **flat plane**, so the tag's Z is computed but its **sign
is ambiguous**: the tag could be the same distance above *or* below that plane.
Use the **“Tag is below anchor plane”** toggle to pick the side. For
unambiguous, robust 3-D, add a **4th anchor mounted out of the plane** (the math
and UI are structured to extend to it).

---

## Tuning notes
- Antenna delay (`TX_ANT_DLY`/`RX_ANT_DLY = 16385`) is the main accuracy knob;
  calibrate it once against a known distance if absolute accuracy matters.
- Anchor↔tag timing constants (`*_DLY_UUS`, `*_TIMEOUT_UUS`) must match across
  tag and anchor firmware — they already do.
- `secureClient.setInsecure()` skips TLS validation — fine for a prototype, not
  for production.
