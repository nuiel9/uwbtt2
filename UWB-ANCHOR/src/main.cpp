// uwb-anchor/src/main.cpp
// Fixed ANCHOR — does TWO jobs:
//   1) RESPONDER: answers ranging polls from the tag (and from peer anchors).
//   2) WEB-TRIGGERED CALIBRATION: the anchor NO LONGER calibrates on its own.
//      Instead it watches Firebase /control/calibrate for a calibration request
//      from the web app. When you press "Calibrate anchors" on the website it
//      writes a fresh token there; each anchor then ranges to its PEER anchors
//      ONCE and pushes the anchor-to-anchor distances to Firebase /calib. The
//      web app turns those pairwise distances into anchor coordinates.
//
//      The token is a number (a timestamp). Each anchor remembers the last
//      token it acted on, so a new button press = new token = one calibration
//      run. On boot the anchor adopts whatever token is already there WITHOUT
//      calibrating — so it never auto-calibrates on power-up.
//
// ESP32-S3 + Qorvo DWM3000EVB
//
// IMPORTANT: Set ANCHOR_ID to 1, 2, or 3 — DIFFERENT for each of your 3 boards!
// Only the LOWER-id anchor of a pair initiates, so on a calibration run:
//   Anchor 1 measures d12, d13     (and uploads them)
//   Anchor 2 measures d23          (and uploads it)
//   Anchor 3 measures nothing      (pure responder)

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include "dw3000.h"
#include "SPI.h"

// ====== CHANGE THIS FOR EACH ANCHOR BOARD ======
#define ANCHOR_ID 2// <-- Set to 1, 2, or 3 (unique per board)
// ===============================================

// ====== FILL THESE IN (needed so anchors can upload calibration) ======
// Leave blank to disable WiFi/upload — calibration distances still print to serial.
const char* WIFI_SSID     = "";
const char* WIFI_PASSWORD = "";
// Realtime Database URL, WITHOUT https:// and WITHOUT trailing slash:
const char* FIREBASE_HOST = "uwb-positioning-a2892-default-rtdb.asia-southeast1.firebasedatabase.app";
// ======================================================================

#define APP_NAME "UWB Anchor (Responder + Web-Triggered Calib)"
#define NUM_ANCHORS 3
// Calibration runs ONLY when the website asks for it (a new token appears in
// Firebase /control/calibrate). We poll that flag every few seconds; when a run
// is requested we do a few quick rounds so all powered peers are caught in one
// press. For best results have all three anchors powered when you press the
// button. Values persist in Firebase, so you only ever need to calibrate again
// if the anchors physically move.
#define CALIB_POLL_MS      3000   // how often we check the website for a request
#define CALIB_ROUNDS       3      // measurement rounds per request (catch all peers)
#define CALIB_RETRIES      6      // ranging attempts per peer within one round
#define RANGE_HANG_MS      10     // software backstop so ranging can never hang
// All anchors see the same request token at once, so without staggering anchor 1
// and anchor 2 would both stop listening to measure at the same instant — and
// d12 (anchor1 -> anchor2) would never land because anchor 2 isn't responding.
// Each anchor waits (ANCHOR_ID-1) * this before it starts measuring, so the
// lower-id anchor measures the pair while the higher-id one is still listening.
#define CALIB_STAGGER_MS   1200

const uint8_t PIN_RST = 16;
const uint8_t PIN_IRQ = 15;
const uint8_t PIN_SS  = 21;

static dwt_config_t config = {
    5, DWT_PLEN_128, DWT_PAC8, 9, 9, 1,
    DWT_BR_6M8, DWT_PHRMODE_STD, DWT_PHRRATE_STD,
    (129 + 8 - 8), DWT_STS_MODE_OFF, DWT_STS_LEN_64, DWT_PDOA_M0
};

#define TX_ANT_DLY 16385
#define RX_ANT_DLY 16385

// --- Timing (must match the tag) ---
#define POLL_RX_TO_RESP_TX_DLY_UUS 1100  // responder: poll RX -> our response TX
#define POLL_TX_TO_RESP_RX_DLY_UUS 700   // initiator: our poll TX -> start listening
#define RESP_RX_TIMEOUT_UUS        800   // initiator: how long to wait for a reply
#define RESPONDER_RX_TIMEOUT_UUS   60000 // responder: listen window before we recheck calib

// Frame format — byte 5 is the TARGET anchor id (whom the poll is for).
static uint8_t tx_poll_msg[] = {0x41, 0x88, 0, 0xCA, 0xDE, 0x00, 'T', 'A', 0xE0, 0, 0};
static uint8_t tx_resp_msg[] = {0x41, 0x88, 0, 0xCA, 0xDE, 0x00, 'A', 'T', 0xE1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0};

#define ALL_MSG_SN_IDX 2
#define MSG_TARGET_ID_IDX 5
#define ALL_MSG_COMMON_LEN 9
#define RESP_MSG_POLL_RX_TS_IDX 9
#define RESP_MSG_RESP_TX_TS_IDX 13
#define RESP_MSG_TS_LEN 4

static uint8_t frame_seq_nb = 0;
#define RX_BUF_LEN 24
static uint8_t rx_buffer[RX_BUF_LEN];
static uint32_t status_reg = 0;

static uint64_t poll_rx_ts;
static uint64_t resp_tx_ts;
static uint32_t pollsAnswered = 0;

extern dwt_txconfig_t txconfig_options;

WiFiClientSecure secureClient;
static bool wifiEnabled = false;

// ---------------------------------------------------------------------------
// WiFi / Firebase
// ---------------------------------------------------------------------------
void connectWiFi() {
  if (strlen(WIFI_SSID) == 0) { wifiEnabled = false; return; }
  wifiEnabled = true;
  Serial.printf("[WiFi] Connecting to '%s'", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  uint32_t start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 15000) {
    delay(500); Serial.print(".");
  }
  if (WiFi.status() == WL_CONNECTED)
    Serial.printf("\n[WiFi] Connected. IP: %s\n", WiFi.localIP().toString().c_str());
  else
    Serial.println("\n[WiFi] FAILED (will retry on upload).");
  secureClient.setInsecure();  // skip cert validation (fine for prototyping)
}

// PATCH merges keys into /calib so each anchor writes only its own pair(s).
void uploadCalib(int a, int b, double d) {
  if (!wifiEnabled) return;
  if (WiFi.status() != WL_CONNECTED) {
    connectWiFi();
    if (WiFi.status() != WL_CONNECTED) return;
  }
  String url = "https://" + String(FIREBASE_HOST) + "/calib.json";
  char body[96];
  snprintf(body, sizeof(body), "{\"d%d%d\":%.4f,\"ts\":%lu}", a, b, d, millis());
  HTTPClient https;
  https.begin(secureClient, url);
  https.addHeader("Content-Type", "application/json");
  int code = https.sendRequest("PATCH", (uint8_t*)body, strlen(body));
  https.end();
  Serial.printf("[CAL] d%d%d = %.3f m  (HTTP %d)\n", a, b, d, code);
}

// Web-triggered calibration: poll /control/calibrate for a request token.
// The website writes a fresh number each time you press "Calibrate anchors".
// We act ONCE per new token. On the first successful read we just adopt the
// current token (so a leftover token never triggers a calibration on boot).
static String   lastCalibToken;          // last token we acted on
static bool     calibTokenSynced = false; // have we adopted the boot-time token yet?

bool calibrationRequested() {
  if (!wifiEnabled) return false;
  if (WiFi.status() != WL_CONNECTED) {
    connectWiFi();
    if (WiFi.status() != WL_CONNECTED) return false;
  }
  String url = "https://" + String(FIREBASE_HOST) + "/control/calibrate.json";
  HTTPClient https;
  https.begin(secureClient, url);
  int code = https.GET();
  String tok;
  if (code == 200) tok = https.getString();
  https.end();
  if (code != 200) return false;          // read failed — try again next poll
  tok.trim();
  // Normalise "no request yet" (missing key) to an empty baseline so we still
  // sync on it — otherwise the very first button press would be swallowed.
  String norm = (tok.length() == 0 || tok == "null") ? String("") : tok;

  if (!calibTokenSynced) {                // first good read: adopt baseline, don't act
    lastCalibToken = norm;
    calibTokenSynced = true;
    return false;
  }
  if (norm.length() > 0 && norm != lastCalibToken) {  // a NEW press -> calibrate once
    lastCalibToken = norm;
    return true;
  }
  return false;                           // same token (or still empty) — nothing to do
}

// ---------------------------------------------------------------------------
// UWB init
// ---------------------------------------------------------------------------
void setupUWB() {
  SPI.begin(36, 37, 35, PIN_SS);
  spiBegin(PIN_IRQ, PIN_RST);
  spiSelect(PIN_SS);
  delay(2);

  Serial.print("DWM3000 IDLE check... ");
  while (!dwt_checkidlerc()) { Serial.println("FAILED, retrying..."); delay(1000); }
  Serial.println("OK");

  Serial.print("Init... ");
  if (dwt_initialise(DWT_DW_INIT) == DWT_ERROR) {
    Serial.println("FAILED");
    while (1) { delay(1000); Serial.println("Stuck on INIT - check wiring"); }
  }
  Serial.println("OK");

  dwt_setleds(DWT_LEDS_ENABLE | DWT_LEDS_INIT_BLINK);

  Serial.print("Config... ");
  if (dwt_configure(&config)) {
    Serial.println("FAILED");
    while (1) { delay(1000); Serial.println("Stuck on CONFIG"); }
  }
  Serial.println("OK");

  dwt_configuretxrf(&txconfig_options);
  dwt_setrxantennadelay(RX_ANT_DLY);
  dwt_settxantennadelay(TX_ANT_DLY);
  dwt_setlnapamode(DWT_LNA_ENABLE | DWT_PA_ENABLE);
}

void setup() {
  Serial.begin(115200);
  delay(2000);
  Serial.println();
  Serial.println("=================================");
  Serial.printf("%s — ID = %d\n", APP_NAME, ANCHOR_ID);
  Serial.println("=================================");

  connectWiFi();
  setupUWB();

  Serial.println("Setup complete!");
  Serial.printf("Anchor %d: responding to polls; calibrating peers on web request.\n", ANCHOR_ID);
}

// ---------------------------------------------------------------------------
// RESPONDER: listen once (with timeout) and answer a poll addressed to us.
// Returns true if a poll for us was answered.
// ---------------------------------------------------------------------------
bool listenAndRespondOnce() {
  // Responder doesn't use rx-after-tx; just listen with a finite timeout so the
  // loop can periodically break out to run calibration.
  dwt_setrxaftertxdelay(0);
  dwt_setrxtimeout(RESPONDER_RX_TIMEOUT_UUS);
  dwt_rxenable(DWT_START_RX_IMMEDIATE);

  while (!((status_reg = dwt_read32bitreg(SYS_STATUS_ID)) &
           (SYS_STATUS_RXFCG_BIT_MASK | SYS_STATUS_ALL_RX_TO | SYS_STATUS_ALL_RX_ERR)))
  { }

  if (!(status_reg & SYS_STATUS_RXFCG_BIT_MASK)) {
    dwt_write32bitreg(SYS_STATUS_ID, SYS_STATUS_ALL_RX_TO | SYS_STATUS_ALL_RX_ERR);
    return false;
  }

  uint32_t frame_len;
  dwt_write32bitreg(SYS_STATUS_ID, SYS_STATUS_RXFCG_BIT_MASK);
  frame_len = dwt_read32bitreg(RX_FINFO_ID) & RXFLEN_MASK;
  if (frame_len > sizeof(rx_buffer)) return false;

  dwt_readrxdata(rx_buffer, frame_len, 0);
  uint8_t targetId = rx_buffer[MSG_TARGET_ID_IDX];
  rx_buffer[ALL_MSG_SN_IDX] = 0;
  rx_buffer[MSG_TARGET_ID_IDX] = 0;
  uint8_t cmp_msg[] = {0x41, 0x88, 0, 0xCA, 0xDE, 0x00, 'T', 'A', 0xE0};

  // Only respond if this poll targets THIS anchor.
  if (targetId != ANCHOR_ID || memcmp(rx_buffer, cmp_msg, ALL_MSG_COMMON_LEN) != 0)
    return false;

  uint32_t resp_tx_time;
  poll_rx_ts = get_rx_timestamp_u64();
  resp_tx_time = (poll_rx_ts + (POLL_RX_TO_RESP_TX_DLY_UUS * UUS_TO_DWT_TIME)) >> 8;
  dwt_setdelayedtrxtime(resp_tx_time);
  resp_tx_ts = (((uint64_t)(resp_tx_time & 0xFFFFFFFEUL)) << 8) + TX_ANT_DLY;

  resp_msg_set_ts(&tx_resp_msg[RESP_MSG_POLL_RX_TS_IDX], poll_rx_ts);
  resp_msg_set_ts(&tx_resp_msg[RESP_MSG_RESP_TX_TS_IDX], resp_tx_ts);

  tx_resp_msg[ALL_MSG_SN_IDX] = frame_seq_nb;
  tx_resp_msg[MSG_TARGET_ID_IDX] = ANCHOR_ID;  // tell initiator which anchor this is
  dwt_writetxdata(sizeof(tx_resp_msg), tx_resp_msg, 0);
  dwt_writetxfctrl(sizeof(tx_resp_msg), 0, 1);

  if (dwt_starttx(DWT_START_TX_DELAYED) == DWT_SUCCESS) {
    while (!(dwt_read32bitreg(SYS_STATUS_ID) & SYS_STATUS_TXFRS_BIT_MASK)) { }
    dwt_write32bitreg(SYS_STATUS_ID, SYS_STATUS_TXFRS_BIT_MASK);
    frame_seq_nb++;
    pollsAnswered++;
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// INITIATOR: range to a peer anchor (same SS-TWR exchange the tag uses).
// Returns distance in metres, or -1 on failure.
// ---------------------------------------------------------------------------
double rangeToPeer(uint8_t peerId) {
  dwt_setrxaftertxdelay(POLL_TX_TO_RESP_RX_DLY_UUS);
  dwt_setrxtimeout(RESP_RX_TIMEOUT_UUS);

  tx_poll_msg[ALL_MSG_SN_IDX] = frame_seq_nb;
  tx_poll_msg[MSG_TARGET_ID_IDX] = peerId;
  dwt_write32bitreg(SYS_STATUS_ID, SYS_STATUS_TXFRS_BIT_MASK);
  dwt_writetxdata(sizeof(tx_poll_msg), tx_poll_msg, 0);
  dwt_writetxfctrl(sizeof(tx_poll_msg), 0, 1);

  // If TX fails the auto-RX is never armed and the rx-timeout bit would never
  // set — without this check the wait loop below would hang the anchor forever.
  // (Do NOT call dwt_forcetrxoff() here: this library's decamutexon() faults
  //  inside portENTER_CRITICAL. Just clear status, like the rx-timeout path.)
  if (dwt_starttx(DWT_START_TX_IMMEDIATE | DWT_RESPONSE_EXPECTED) != DWT_SUCCESS) {
    frame_seq_nb++;
    dwt_write32bitreg(SYS_STATUS_ID, SYS_STATUS_ALL_RX_TO | SYS_STATUS_ALL_RX_ERR);
    return -1.0;
  }

  // Reply is expected within <1 ms; the hardware rx-timeout normally ends this
  // loop. RANGE_HANG_MS is a software backstop in case neither bit ever sets.
  uint32_t t0 = millis();
  while (!((status_reg = dwt_read32bitreg(SYS_STATUS_ID)) &
           (SYS_STATUS_RXFCG_BIT_MASK | SYS_STATUS_ALL_RX_TO | SYS_STATUS_ALL_RX_ERR))) {
    if (millis() - t0 > RANGE_HANG_MS) {
      dwt_write32bitreg(SYS_STATUS_ID, SYS_STATUS_ALL_RX_TO | SYS_STATUS_ALL_RX_ERR | SYS_STATUS_RXFCG_BIT_MASK);
      frame_seq_nb++;
      return -1.0;
    }
  }
  frame_seq_nb++;

  if (!(status_reg & SYS_STATUS_RXFCG_BIT_MASK)) {
    dwt_write32bitreg(SYS_STATUS_ID, SYS_STATUS_ALL_RX_TO | SYS_STATUS_ALL_RX_ERR);
    return -1.0;
  }

  uint32_t frame_len;
  dwt_write32bitreg(SYS_STATUS_ID, SYS_STATUS_RXFCG_BIT_MASK);
  frame_len = dwt_read32bitreg(RX_FINFO_ID) & RXFLEN_MASK;
  if (frame_len > sizeof(rx_buffer)) return -1.0;

  dwt_readrxdata(rx_buffer, frame_len, 0);
  uint8_t respId = rx_buffer[MSG_TARGET_ID_IDX];
  rx_buffer[ALL_MSG_SN_IDX] = 0;
  rx_buffer[MSG_TARGET_ID_IDX] = 0;
  uint8_t cmp_msg[] = {0x41, 0x88, 0, 0xCA, 0xDE, 0x00, 'A', 'T', 0xE1};
  if (respId != peerId || memcmp(rx_buffer, cmp_msg, ALL_MSG_COMMON_LEN) != 0)
    return -1.0;

  uint32_t poll_tx_ts, resp_rx_ts, poll_rx_ts_l, resp_tx_ts_l;
  int32_t rtd_init, rtd_resp;
  float clockOffsetRatio;
  poll_tx_ts = dwt_readtxtimestamplo32();
  resp_rx_ts = dwt_readrxtimestamplo32();
  clockOffsetRatio = ((float)dwt_readclockoffset()) / (uint32_t)(1 << 26);
  resp_msg_get_ts(&rx_buffer[RESP_MSG_POLL_RX_TS_IDX], &poll_rx_ts_l);
  resp_msg_get_ts(&rx_buffer[RESP_MSG_RESP_TX_TS_IDX], &resp_tx_ts_l);
  rtd_init = resp_rx_ts - poll_tx_ts;
  rtd_resp = resp_tx_ts_l - poll_rx_ts_l;
  double tof = ((rtd_init - rtd_resp * (1 - clockOffsetRatio)) / 2.0) * DWT_TIME_UNITS;
  return tof * SPEED_OF_LIGHT;
}

// Measure each higher-id peer that we DON'T yet have, upload it, and remember
// it so we never re-range an already-known pair. Lower id always initiates so
// two anchors never poll each other simultaneously.
// peerDone[] is indexed by peer id. Returns the number of peers still missing
// (0 == fully calibrated).
int doCalibration(bool peerDone[]) {
  int missing = 0;
  for (uint8_t peer = ANCHOR_ID + 1; peer <= NUM_ANCHORS; peer++) {
    if (peerDone[peer]) continue;            // already have this pair — skip
    double d = -1.0;
    for (int t = 0; t < CALIB_RETRIES && d <= 0; t++) {
      d = rangeToPeer(peer);
      delay(5);
    }
    if (d > 0) {
      uploadCalib(ANCHOR_ID, peer, d);
      peerDone[peer] = true;                 // stop ranging this pair from now on
    } else {
      missing++;
      Serial.printf("[CAL] d%d%d not heard (is anchor %d powered + flashed?)\n", ANCHOR_ID, peer, peer);
    }
  }
  return missing;
}

void loop() {
  static uint32_t lastAlive = 0;
  static uint32_t lastPoll = 0;
  static uint32_t calibRunAt = 0;          // 0 = no run pending; else millis() to start at
  // Top-id anchor measures no peers, so it never needs to ask the website.
  static const bool canInitiate = (ANCHOR_ID < NUM_ANCHORS);

  if (millis() - lastAlive > 5000) {
    lastAlive = millis();
    Serial.printf("[A%d] Alive - answered %lu polls\n", ANCHOR_ID, pollsAnswered);
  }

  // Web-triggered calibration. The anchor ALWAYS responds to the tag (below);
  // it no longer calibrates on its own. We only check the website every few
  // seconds for a "Calibrate anchors" request. When one arrives we SCHEDULE the
  // measurement for a moment later (staggered by ANCHOR_ID) rather than running
  // it now, so that while a lower-id anchor measures a pair we keep listening
  // and can answer its poll — this is what lets d12 (anchor1 -> anchor2) land.
  if (canInitiate && !calibRunAt && millis() - lastPoll > CALIB_POLL_MS) {
    lastPoll = millis();
    if (calibrationRequested()) {
      calibRunAt = millis() + (uint32_t)(ANCHOR_ID - 1) * CALIB_STAGGER_MS;
      Serial.printf("[CAL] website requested calibration (token %s) — measuring in %lu ms...\n",
                    lastCalibToken.c_str(), (uint32_t)(ANCHOR_ID - 1) * CALIB_STAGGER_MS);
    }
  }

  // Time to run our scheduled measurement. Until now we stayed in the responder
  // loop (below), so lower-id anchors could range us.
  if (calibRunAt && (int32_t)(millis() - calibRunAt) >= 0) {
    calibRunAt = 0;
    Serial.println("[CAL] measuring peers...");
    bool peerDone[NUM_ANCHORS + 1] = {false};   // fresh run: re-measure all pairs
    int missing = NUM_ANCHORS;
    for (int round = 0; round < CALIB_ROUNDS && missing > 0; round++) {
      missing = doCalibration(peerDone);
      if (missing > 0) delay(200);
    }
    if (missing == 0) Serial.println("[CAL] calibration run complete.");
    else              Serial.printf("[CAL] run finished with %d peer(s) not heard.\n", missing);
  }

  listenAndRespondOnce();
}
