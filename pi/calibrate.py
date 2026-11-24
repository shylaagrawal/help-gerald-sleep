import subprocess
import threading
import time
import math
import json
import numpy as np

SAMPLE_RATE = 16000
CHUNK_SECONDS = 0.2
REFERENCE = 1.0

current_db = 0.0
lock = threading.Lock()

def audio_worker():
    global current_db
    cmd = ["arecord", "-D", "plughw:0,0", "-c2", "-r", str(SAMPLE_RATE), "-f", "S32_LE", "-t", "raw"]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE)
    bytes_per_chunk = int(SAMPLE_RATE * CHUNK_SECONDS) * 2 * 4
    while True:
        raw = proc.stdout.read(bytes_per_chunk)
        if len(raw) < bytes_per_chunk:
            continue
        samples = np.frombuffer(raw, dtype="<i4").astype(np.float64)
        left = samples[0::2]
        rms = np.sqrt(np.mean(left ** 2))
        db = 20 * math.log10(rms / REFERENCE) if rms > 0 else 0.0
        with lock:
            current_db = max(db, 0.0)

t = threading.Thread(target=audio_worker, daemon=True)
t.start()
time.sleep(1.5)

print("=" * 60)
print("Gerald mic calibration (v2 - fixed timing)")
print("Hold a STEADY sound level (talk continuously, or play")
print("steady music/tone). While holding it steady, press Enter")
print("to freeze Gerald's reading, THEN read your phone and type")
print("its number. Type 'done' when finished with 6-8+ points.")
print("=" * 60)

pairs = []

while True:
    cmd = input("Press Enter to capture a reading (while holding steady sound), or type 'done': ").strip()
    if cmd.lower() == "done":
        break
    with lock:
        apparent_db = current_db
    print(f"  Gerald froze at: {apparent_db:.1f}  (glance at your phone NOW)")
    entry = input("  Real dB(A) from phone for that same moment: ").strip()
    try:
        real_db = float(entry)
    except ValueError:
        print("  Not a number, discarded that point.")
        continue
    pairs.append((apparent_db, real_db))
    print(f"  Logged: apparent={apparent_db:.1f}  real={real_db:.1f}  ({len(pairs)} points so far)")

if len(pairs) < 2:
    print("Need at least 2 points to calibrate. Exiting without saving.")
else:
    apparent = np.array([p[0] for p in pairs])
    real = np.array([p[1] for p in pairs])
    m, b = np.polyfit(apparent, real, 1)
    predicted = m * apparent + b
    ss_res = np.sum((real - predicted) ** 2)
    ss_tot = np.sum((real - np.mean(real)) ** 2)
    r2 = 1 - ss_res / ss_tot if ss_tot > 0 else 0.0

    print("-" * 60)
    print(f"Fit: real_dB = {m:.4f} * apparent_dB + {b:.4f}")
    print(f"R^2 = {r2:.4f}")

    with open("calibration.json", "w") as f:
        json.dump({"slope": m, "intercept": b, "r2": r2, "points": pairs}, f, indent=2)
    print("Saved to calibration.json")
