# Room Guide — Mobile web app

What this delivers
- A small single-page web app (index.html, styles.css, app.js) you can open on an iPhone browser.
- Simulator built in so you can test without an ESP32.
- Optional Firebase Realtime Database integration: read tag positions at /tags/{id} and trigger proximity-based audio/TTS.

Files
- index.html — UI and simulator
- styles.css — small responsive styles
- app.js — main logic. Set FIREBASE_CONFIG to enable live mode.

How to run locally (quick)
1. In the project folder (this repo's web/), start a static server: python3 -m http.server 8000
2. Open http://<your-machine-ip>:8000 on your iPhone (same network) or host the files on any static host (Netlify, Vercel, GitHub Pages).

Live mode (real UWB hardware)  ← NEW
- Use the "Live (real UWB tag)" panel. It reads the SAME data the ESP32 firmware
  writes — raw anchor distances at /live and anchor-to-anchor distances at /calib —
  straight from Firebase over REST, and trilaterates the tag position here. No
  Firebase SDK config / API key is needed (matches the open-rules prototype DB).
- The host is pre-filled with the project database. Press "Connect live".
- Calibrate the anchors first (press "Calibrate anchors" on the control site) so
  /calib has d12/d13/d23 — otherwise live mode shows "no calibration yet".
- Attractions: if the control site has published areas to /display, live mode uses
  THOSE as the attraction points (same coordinates + image + audio), and the map
  auto-fits them. Otherwise it falls back to the built-in 6-point layout.
- The /tags/{id} Firebase-SDK path (FIREBASE_CONFIG below, and walk-sim.py) is a
  separate simulation route and is NOT what the firmware uses.

Simulator
- Use the Simulator controls in the page: pick Tag 1–3, move sliders, press "Send simulated position".
- The map shows 5 attraction points. When your selected tag is moved within the trigger radius, the app will show the attraction info and speak it (TTS) by default.

Firebase integration
- To enable live data, paste your Firebase config object into app.js FIREBASE_CONFIG constant.
- ESP32 should write positions to Realtime Database under path /tags/{tagId} with JSON: { x: number, y: number, ts: number }.
- Example structure:
  /tags/1 -> { "x": 2.1, "y": 3.4, "ts": 1680000000000 }

ESP32 notes (sketch)
- Use Firebase Arduino libraries to push positions. Ensure numeric x/y are floats.

Audio
- By default the app uses Web Speech (speechSynthesis) for TTS — works on modern iOS Safari without extra files.
- If you prefer pre-recorded audio, place files under /audio (paths used in app.js). Note iOS requires a user gesture to unlock audio — use the "Enable Audio" button.

Testing evidence
- I started a local server and exercised the simulator. When the simulator sent position x=2,y=2 for Tag 1 the UI state updated and the status line showed: "Speaking: Sculpture".
- Screenshot saved under .playwright-mcp/page-2026-06-08T06-19-54-187Z.png in the workspace.

Notes / environment
- I attempted to run lsp_diagnostics but the workspace lacked the configured language servers; that is an environment limitation — the source files are plain HTML/CSS/JS and ready to use.

Next steps you may want
- Replace FIREBASE_CONFIG in app.js and deploy the files to a static host so your iPhone can access them via HTTPS.
- Add/replace attraction audio files in /audio and disable TTS if you want recorded guides.

If you want, I can:
- Hook the app to your Firebase config (you can paste it here) and validate live updates from your ESP32 (I will not keep the secret).
- Convert this into a small PWA with an install prompt and offline caching.
