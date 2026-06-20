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
                      │  REST poll (GET /live.json, /calib.json)
                      │  PUT /control/calibrate  ("Calibrate" button)
                      ▼
            web/ (static site)  ──►  X, Y, Z + top/side views + zone triggers
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
| `index.html`      | Page structure. |
| `styles.css`      | Styling. |
| `app.js`          | Logic: polling, trilateration, calibration button, zone trigger engine. |
| `zones.config.js` | **Edit this** — defines the trigger AREAS and the information each one shows. |

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

// /control/calibrate   (web app, PUT — a token the anchors watch)
1718900000000           // a fresh number each time you press "Calibrate anchors"
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
  beep on/off, once-vs-repeat, cooldown, pop-up hold time, an image URL, and a
  link**. Every change **saves automatically in your browser** (localStorage).
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
