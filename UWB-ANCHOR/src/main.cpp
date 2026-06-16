// uwb-anchor/src/main.cpp
// Fixed ANCHOR (Responder) — only responds to polls targeting its ANCHOR_ID
// ESP32-S3 + Qorvo DWM3000EVB
//
// IMPORTANT: Set ANCHOR_ID to 1, 2, or 3 — DIFFERENT for each of your 3 anchor boards!

#include "dw3000.h"
#include "SPI.h"

// ====== CHANGE THIS FOR EACH ANCHOR BOARD ======
#define ANCHOR_ID 3   // <-- Set to 1, 2, or 3 (unique per board)
// ===============================================

#define APP_NAME "UWB Anchor (Responder)"

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

// Must match the tag's timing
#define POLL_RX_TO_RESP_TX_DLY_UUS 1100

// Frame format — byte 5 is the target anchor id
static uint8_t rx_poll_msg[] = {0x41, 0x88, 0, 0xCA, 0xDE, 0x00, 'T', 'A', 0xE0, 0, 0};
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

void setup() {
  Serial.begin(115200);
  delay(2000);
  Serial.println();
  Serial.println("=================================");
  Serial.printf("%s — ID = %d\n", APP_NAME, ANCHOR_ID);
  Serial.println("=================================");

  SPI.begin(36, 37, 35, PIN_SS);
  spiBegin(PIN_IRQ, PIN_RST);
  spiSelect(PIN_SS);
  delay(2);

  Serial.print("DWM3000 IDLE check... ");
  while (!dwt_checkidlerc()) {
    Serial.println("FAILED, retrying...");
    delay(1000);
  }
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

  Serial.println("Setup complete!");
  Serial.printf("Anchor %d waiting for polls targeting it...\n", ANCHOR_ID);
}

void loop() {
  static uint32_t lastAlive = 0;
  if (millis() - lastAlive > 5000) {
    lastAlive = millis();
    Serial.printf("[A%d] Alive - answered %lu polls\n", ANCHOR_ID, pollsAnswered);
  }

  dwt_rxenable(DWT_START_RX_IMMEDIATE);

  while (!((status_reg = dwt_read32bitreg(SYS_STATUS_ID)) &
           (SYS_STATUS_RXFCG_BIT_MASK | SYS_STATUS_ALL_RX_ERR)))
  { };

  if (status_reg & SYS_STATUS_RXFCG_BIT_MASK) {
    uint32_t frame_len;
    dwt_write32bitreg(SYS_STATUS_ID, SYS_STATUS_RXFCG_BIT_MASK);
    frame_len = dwt_read32bitreg(RX_FINFO_ID) & RXFLEN_MASK;

    if (frame_len <= sizeof(rx_buffer)) {
      dwt_readrxdata(rx_buffer, frame_len, 0);

      uint8_t targetId = rx_buffer[MSG_TARGET_ID_IDX];
      rx_buffer[ALL_MSG_SN_IDX] = 0;
      rx_buffer[MSG_TARGET_ID_IDX] = 0;
      uint8_t cmp_msg[] = {0x41, 0x88, 0, 0xCA, 0xDE, 0x00, 'T', 'A', 0xE0};

      // Only respond if this poll targets THIS anchor
      if (targetId == ANCHOR_ID && memcmp(rx_buffer, cmp_msg, ALL_MSG_COMMON_LEN) == 0) {
        uint32_t resp_tx_time;
        int ret;

        poll_rx_ts = get_rx_timestamp_u64();
        resp_tx_time = (poll_rx_ts + (POLL_RX_TO_RESP_TX_DLY_UUS * UUS_TO_DWT_TIME)) >> 8;
        dwt_setdelayedtrxtime(resp_tx_time);
        resp_tx_ts = (((uint64_t)(resp_tx_time & 0xFFFFFFFEUL)) << 8) + TX_ANT_DLY;

        resp_msg_set_ts(&tx_resp_msg[RESP_MSG_POLL_RX_TS_IDX], poll_rx_ts);
        resp_msg_set_ts(&tx_resp_msg[RESP_MSG_RESP_TX_TS_IDX], resp_tx_ts);

        tx_resp_msg[ALL_MSG_SN_IDX] = frame_seq_nb;
        tx_resp_msg[MSG_TARGET_ID_IDX] = ANCHOR_ID;  // tell tag which anchor this is
        dwt_writetxdata(sizeof(tx_resp_msg), tx_resp_msg, 0);
        dwt_writetxfctrl(sizeof(tx_resp_msg), 0, 1);
        ret = dwt_starttx(DWT_START_TX_DELAYED);

        if (ret == DWT_SUCCESS) {
          while (!(dwt_read32bitreg(SYS_STATUS_ID) & SYS_STATUS_TXFRS_BIT_MASK))
          { };
          dwt_write32bitreg(SYS_STATUS_ID, SYS_STATUS_TXFRS_BIT_MASK);
          frame_seq_nb++;
          pollsAnswered++;
        }
      }
    }
  } else {
    dwt_write32bitreg(SYS_STATUS_ID, SYS_STATUS_ALL_RX_ERR);
  }
}