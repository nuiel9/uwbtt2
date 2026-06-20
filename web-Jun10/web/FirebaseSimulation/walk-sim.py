"""
Tourist tag walk simulator -> Firebase Realtime Database.

Writes to /tags/{tagId} with payload { x, y, ts } to match the web app
(see ../app.js DB_PATH = '/tags'). Three tags walk between five attraction
points using a round-robin schedule so no two tags ever share the same
point in the same step. 70 seconds between attraction visits. Loops forever.

Setup
-----
1. pip install firebase-admin
2. Download a Service Account JSON from Firebase Console
   (Project Settings -> Service accounts -> Generate new private key).
3. Set environment variables before running:
       export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
       export FIREBASE_DB_URL=https://<your-project>-default-rtdb.firebaseio.com
   Or edit SERVICE_ACCOUNT_FILE / DATABASE_URL constants below.
4. python3 walk-sim.py
"""

import os
import time
from datetime import datetime

import firebase_admin
from firebase_admin import credentials, db

# --- Configuration ----------------------------------------------------------

SERVICE_ACCOUNT_FILE = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")  # path to .json
DATABASE_URL = os.environ.get(
    "FIREBASE_DB_URL",
    "https://YOUR-PROJECT-default-rtdb.firebaseio.com",  # <-- replace if not using env var
)

# Room is 10 x 10 (matches ROOM_SIZE in app.js)
ATTRACTIONS = [
    {"id": "A", "x": 2.0, "y": 2.0},
    {"id": "B", "x": 8.0, "y": 2.0},
    {"id": "C", "x": 5.0, "y": 4.0},
    {"id": "D", "x": 2.0, "y": 8.0},
    {"id": "E", "x": 8.0, "y": 8.0},
]

TAG_IDS = ["1", "2", "3"]

# Round-robin schedule: at step i, tag t visits ATTRACTIONS[SCHEDULES[t][i % 5]]
# Each column has 3 distinct attractions => no two tags share a point per step.
SCHEDULES = {
    "1": [0, 1, 2, 3, 4],  # A B C D E
    "2": [1, 2, 3, 4, 0],  # B C D E A
    "3": [2, 3, 4, 0, 1],  # C D E A B
}

WALK_STEP_SECONDS = 70       # time between attraction visits
UPDATE_INTERVAL_SECONDS = 2  # how often to push an interpolated position


# --- Firebase init ----------------------------------------------------------

def init_firebase():
    if SERVICE_ACCOUNT_FILE and os.path.isfile(SERVICE_ACCOUNT_FILE):
        cred = credentials.Certificate(SERVICE_ACCOUNT_FILE)
    else:
        # falls back to ADC; requires GOOGLE_APPLICATION_CREDENTIALS to be set
        cred = credentials.ApplicationDefault()
    firebase_admin.initialize_app(cred, {"databaseURL": DATABASE_URL})


def write_tag(tag_id, x, y):
    payload = {
        "x": round(x, 2),
        "y": round(y, 2),
        "ts": int(time.time() * 1000),  # ms epoch (matches Date.now() in JS)
    }
    db.reference(f"/tags/{tag_id}").set(payload)


# --- Walk loop --------------------------------------------------------------

def walk_forever():
    # Start each tag at its first scheduled attraction
    positions = {
        tag: {
            "x": ATTRACTIONS[SCHEDULES[tag][0]]["x"],
            "y": ATTRACTIONS[SCHEDULES[tag][0]]["y"],
        }
        for tag in TAG_IDS
    }

    # Push initial positions
    for tag, p in positions.items():
        write_tag(tag, p["x"], p["y"])

    step = 0
    while True:
        # Pick destination attraction for each tag this step
        destinations = {
            tag: ATTRACTIONS[SCHEDULES[tag][step % len(ATTRACTIONS)]]
            for tag in TAG_IDS
        }
        start_positions = {tag: dict(positions[tag]) for tag in TAG_IDS}

        loop_num = step // len(ATTRACTIONS) + 1
        step_num = step % len(ATTRACTIONS) + 1
        print(
            f"[{datetime.now().strftime('%H:%M:%S')}] "
            f"Loop {loop_num} step {step_num}: "
            + " | ".join(
                f"Tag{tag}->{destinations[tag]['id']}"
                f"({destinations[tag]['x']},{destinations[tag]['y']})"
                for tag in TAG_IDS
            )
        )

        # Interpolate over WALK_STEP_SECONDS, sending updates every UPDATE_INTERVAL_SECONDS
        total_ticks = max(1, WALK_STEP_SECONDS // UPDATE_INTERVAL_SECONDS)
        step_start = time.time()

        for tick in range(1, total_ticks + 1):
            t = tick / total_ticks  # 0..1
            for tag in TAG_IDS:
                s = start_positions[tag]
                d = destinations[tag]
                x = s["x"] + (d["x"] - s["x"]) * t
                y = s["y"] + (d["y"] - s["y"]) * t
                positions[tag] = {"x": x, "y": y}
                write_tag(tag, x, y)

            # Sleep until the next tick aligns with wall clock
            next_tick_at = step_start + tick * UPDATE_INTERVAL_SECONDS
            sleep_for = next_tick_at - time.time()
            if sleep_for > 0:
                time.sleep(sleep_for)

        step += 1


# --- Entry point ------------------------------------------------------------

if __name__ == "__main__":
    init_firebase()
    print(f"Connected to RTDB: {DATABASE_URL}")
    print(
        f"Writing to /tags/{{1,2,3}} every {UPDATE_INTERVAL_SECONDS}s, "
        f"{WALK_STEP_SECONDS}s per attraction."
    )
    try:
        walk_forever()
    except KeyboardInterrupt:
        print("\nStopped by user.")
