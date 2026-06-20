// uwb-tag/src/main.cpp
// Tag (Initiator) — ranges to 3 anchors, uploads distances to Firebase over WiFi.

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include "dw3000.h"
#include "SPI.h"

// ====== FILL THESE IN ======
const char* WIFI_SSID     = "sktechchange";
const char* WIFI_PASSWORD = "dmc11111";
// Your Realtime Database URL, WITHOUT https:// and WITHOUT trailing slash:
const char* FIREBASE_HOST = "uwb-positioning-a2892-default-rtdb.asia-southeast1.firebasedatabase.app";
// ===========================

#define APP_NAME "UWB Tag -> Firebase"

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
#define POLL_TX_TO_RESP_RX_DLY_UUS 700
#define RESP_RX_TIMEOUT_UUS 800
#define NUM_ANCHORS 3

static uint8_t tx_poll_msg[] = {0x41, 0x88, 0, 0xCA, 0xDE, 0x00, 'T', 'A', 0xE0, 0, 0};
static uint8_t rx_resp_msg[] = {0x41, 0x88, 0, 0xCA, 0xDE, 0x00, 'A', 'T', 0xE1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0};

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
static double distances[NUM_ANCHORS] = {-1, -1, -1};
static uint32_t uploadSeq = 0;

// When a range momentarily fails (a brief UWB dropout) we DON'T immediately
// report -1, which would make the web app's position jump or vanish. Instead we
// hold the last good distance for that anchor for up to RANGE_HOLD_MAX
// consecutive misses, so a transient glitch keeps the tag steady. After that we
// give up and report -1 so a truly gone anchor is shown as "no data".
// One loop pass is ~360 ms, so 25 misses ≈ 9 s of holding before we let go.
#define RANGE_HOLD_MAX 25
static double  lastGood[NUM_ANCHORS]  = {-1, -1, -1};
static uint8_t missCount[NUM_ANCHORS] = {0, 0, 0};

extern dwt_txconfig_t txconfig_options;

WiFiClientSecure secureClient;

void connectWiFi() {
  Serial.printf("Connecting to WiFi '%s'", WIFI_SSID);
  // A WPA2 passphrase is 8-63 chars; anything shorter can never authenticate.
  if (strlen(WIFI_PASSWORD) > 0 && strlen(WIFI_PASSWORD) < 8)
    Serial.printf("\n[WiFi] WARNING: password is %d chars — WPA2 needs >= 8, so this WILL fail.\n",
                  (int)strlen(WIFI_PASSWORD));

  WiFi.persistent(false);   // don't reuse stale creds saved in flash (a common AUTH_FAIL cause)
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);     // steadier connection, fewer drops

  // ESP32 can spuriously report AUTH_FAIL on the first attempt, then join on a
  // fresh begin(). Try a few times before giving up.
  for (int attempt = 1; attempt <= 3 && WiFi.status() != WL_CONNECTED; attempt++) {
    WiFi.disconnect(true, true);   // clear any half-open state
    delay(200);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    uint32_t start = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - start < 10000) {
      delay(500);
      Serial.print(".");
    }
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("\n[WiFi] Connected. IP: %s\n", WiFi.localIP().toString().c_str());
  } else {
    Serial.printf("\n[WiFi] FAILED (status %d). 202=AUTH_FAIL usually means wrong password;\n"
                  "       also check the network is 2.4 GHz (ESP32 can't see 5 GHz). SSID='%s'.\n",
                  WiFi.status(), WIFI_SSID);
  }
  secureClient.setInsecure();  // skip cert validation (simplest for prototyping)
}

void setupUWB() {
  SPI.begin(36, 37, 35, PIN_SS);
  spiBegin(PIN_IRQ, PIN_RST);
  spiSelect(PIN_SS);
  delay(2);
  while (!dwt_checkidlerc()) { Serial.println("[UWB] IDLE FAILED"); while (1); }
  if (dwt_initialise(DWT_DW_INIT) == DWT_ERROR) { Serial.println("[UWB] INIT FAILED"); while (1); }
  dwt_setleds(DWT_LEDS_ENABLE | DWT_LEDS_INIT_BLINK);
  if (dwt_configure(&config)) { Serial.println("[UWB] CONFIG FAILED"); while (1); }
  dwt_configuretxrf(&txconfig_options);
  dwt_setrxantennadelay(RX_ANT_DLY);
  dwt_settxantennadelay(TX_ANT_DLY);
  dwt_setrxaftertxdelay(POLL_TX_TO_RESP_RX_DLY_UUS);
  dwt_setrxtimeout(RESP_RX_TIMEOUT_UUS);
  dwt_setlnapamode(DWT_LNA_ENABLE | DWT_PA_ENABLE);
  Serial.println("[UWB] Initialized");
}

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println(APP_NAME);
  connectWiFi();
  setupUWB();
  Serial.println("Setup over.");
}

double rangeToAnchor(uint8_t anchorId) {
  tx_poll_msg[ALL_MSG_SN_IDX] = frame_seq_nb;
  tx_poll_msg[MSG_TARGET_ID_IDX] = anchorId;
  dwt_write32bitreg(SYS_STATUS_ID, SYS_STATUS_TXFRS_BIT_MASK);
  dwt_writetxdata(sizeof(tx_poll_msg), tx_poll_msg, 0);
  dwt_writetxfctrl(sizeof(tx_poll_msg), 0, 1);
  dwt_starttx(DWT_START_TX_IMMEDIATE | DWT_RESPONSE_EXPECTED);

  while (!((status_reg = dwt_read32bitreg(SYS_STATUS_ID)) &
           (SYS_STATUS_RXFCG_BIT_MASK | SYS_STATUS_ALL_RX_TO | SYS_STATUS_ALL_RX_ERR))) { };
  frame_seq_nb++;

  if (status_reg & SYS_STATUS_RXFCG_BIT_MASK) {
    uint32_t frame_len;
    dwt_write32bitreg(SYS_STATUS_ID, SYS_STATUS_RXFCG_BIT_MASK);
    frame_len = dwt_read32bitreg(RX_FINFO_ID) & RXFLEN_MASK;
    if (frame_len <= sizeof(rx_buffer)) {
      dwt_readrxdata(rx_buffer, frame_len, 0);
      uint8_t respId = rx_buffer[MSG_TARGET_ID_IDX];
      rx_buffer[ALL_MSG_SN_IDX] = 0;
      rx_buffer[MSG_TARGET_ID_IDX] = 0;
      uint8_t cmp_msg[] = {0x41, 0x88, 0, 0xCA, 0xDE, 0x00, 'A', 'T', 0xE1};
      if (respId == anchorId && memcmp(rx_buffer, cmp_msg, ALL_MSG_COMMON_LEN) == 0) {
        uint32_t poll_tx_ts, resp_rx_ts, poll_rx_ts, resp_tx_ts;
        int32_t rtd_init, rtd_resp;
        float clockOffsetRatio;
        poll_tx_ts = dwt_readtxtimestamplo32();
        resp_rx_ts = dwt_readrxtimestamplo32();
        clockOffsetRatio = ((float)dwt_readclockoffset()) / (uint32_t)(1 << 26);
        resp_msg_get_ts(&rx_buffer[RESP_MSG_POLL_RX_TS_IDX], &poll_rx_ts);
        resp_msg_get_ts(&rx_buffer[RESP_MSG_RESP_TX_TS_IDX], &resp_tx_ts);
        rtd_init = resp_rx_ts - poll_tx_ts;
        rtd_resp = resp_tx_ts - poll_rx_ts;
        double tof = ((rtd_init - rtd_resp * (1 - clockOffsetRatio)) / 2.0) * DWT_TIME_UNITS;
        return tof * SPEED_OF_LIGHT;
      }
    }
  } else {
    dwt_write32bitreg(SYS_STATUS_ID, SYS_STATUS_ALL_RX_TO | SYS_STATUS_ALL_RX_ERR);
  }
  return -1.0;
}

void uploadToFirebase() {
  if (WiFi.status() != WL_CONNECTED) {
    connectWiFi();
    if (WiFi.status() != WL_CONNECTED) return;
  }
  // PUT replaces /live with the latest reading
  String url = "https://" + String(FIREBASE_HOST) + "/live.json";
  char body[160];
  snprintf(body, sizeof(body),
           "{\"d1\":%.3f,\"d2\":%.3f,\"d3\":%.3f,\"seq\":%lu,\"ts\":%lu}",
           distances[0], distances[1], distances[2], uploadSeq++, millis());

  HTTPClient https;
  https.begin(secureClient, url);
  https.addHeader("Content-Type", "application/json");
  int code = https.sendRequest("PUT", (uint8_t*)body, strlen(body));
  https.end();

  static uint32_t lastLog = 0;
  if (millis() - lastLog > 1000) {
    lastLog = millis();
    Serial.printf("[UP] d1=%.2f d2=%.2f d3=%.2f  HTTP %d\n",
                  distances[0], distances[1], distances[2], code);
  }
}

void loop() {
  for (uint8_t id = 1; id <= NUM_ANCHORS; id++) {
    uint8_t i = id - 1;
    double d = rangeToAnchor(id);
    if (d > 0) {                                     // good range — use & remember it
      distances[i] = d;
      lastGood[i]  = d;
      missCount[i] = 0;
    } else if (lastGood[i] > 0 && missCount[i] < RANGE_HOLD_MAX) {
      missCount[i]++;                                // brief dropout — hold last good range
      distances[i] = lastGood[i];
    } else {                                         // gone too long — report no data
      distances[i] = -1.0;
    }
    delay(20);
  }
  uploadToFirebase();
  delay(300);  // ~3 uploads/sec
}