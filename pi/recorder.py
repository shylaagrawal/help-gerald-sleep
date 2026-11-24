import subprocess
import time
import math
import csv
import os
import json
import wave
import datetime
import numpy as np

SAMPLE_RATE = 16000
CHUNK_SECONDS = 1.0
REFERENCE = 1.0
BASE_DIR = "/home/shyla_agrawal/gerald_night_data"
CALIBRATION_FILE = "calibration.json"
AUDIO_SEGMENT_SECONDS = 3600
AUDIO_BIT_SHIFT = 13

def load_calibration():
    if not os.path.exists(CALIBRATION_FILE):
        raise FileNotFoundError(f"{CALIBRATION_FILE} not found. Run calibrate.py first.")
    with open(CALIBRATION_FILE, "r") as f:
        cal = json.load(f)
    print(f"Loaded calibration: real_dB = {cal['slope']:.4f} * apparent_dB + {cal['intercept']:.4f} (R^2={cal.get('r2', 'unknown')})")
    return cal["slope"], cal["intercept"]

def apparent_db_from_chunk(left_samples):
    rms = np.sqrt(np.mean(left_samples ** 2))
    if rms <= 0:
        return 0.0
    db = 20 * math.log10(rms / REFERENCE)
    return max(db, 0.0)

def night_date_str():
    now = datetime.datetime.now()
    if now.hour < 12:
        return (now.date() - datetime.timedelta(days=1)).isoformat()
    return now.date().isoformat()

def night_paths():
    date_str = night_date_str()
    night_dir = os.path.join(BASE_DIR, f"night_{date_str}")
    hour_dir = os.path.join(night_dir, f"hour_audio_{date_str}")
    os.makedirs(hour_dir, exist_ok=True)
    csv_path = os.path.join(night_dir, f"raw_data_{date_str}.csv")
    return csv_path, hour_dir

def new_audio_segment(hour_dir):
    ts = datetime.datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    path = os.path.join(hour_dir, f"{ts}.wav")
    wav = wave.open(path, "wb")
    wav.setnchannels(1)
    wav.setsampwidth(2)
    wav.setframerate(SAMPLE_RATE)
    return wav, path

def main():
    slope, intercept = load_calibration()
    filepath, hour_dir = night_paths()
    file_exists = os.path.exists(filepath)

    cmd = ["arecord", "-D", "plughw:0,0", "-c2", "-r", str(SAMPLE_RATE), "-f", "S32_LE", "-t", "raw"]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE)
    bytes_per_chunk = int(SAMPLE_RATE * CHUNK_SECONDS) * 2 * 4

    print(f"Recording started. Logging calibrated dB(A) to {filepath}")
    print(f"Audio segments ({AUDIO_SEGMENT_SECONDS}s each) saving to {hour_dir}")

    audio_wav, audio_path = new_audio_segment(hour_dir)
    segment_start = time.time()
    print(f"  -> {audio_path}")

    try:
        with open(filepath, "a", newline="") as f:
            writer = csv.writer(f)
            if not file_exists:
                writer.writerow(["timestamp", "apparent_db", "calibrated_db_a"])

            while True:
                raw = proc.stdout.read(bytes_per_chunk)
                if len(raw) < bytes_per_chunk:
                    continue

                samples = np.frombuffer(raw, dtype="<i4")
                left_int32 = samples[0::2]

                left_float = left_int32.astype(np.float64)
                apparent_db = apparent_db_from_chunk(left_float)
                calibrated_db = slope * apparent_db + intercept
                timestamp = datetime.datetime.now().isoformat(timespec="seconds")
                writer.writerow([timestamp, round(apparent_db, 2), round(calibrated_db, 2)])
                f.flush()

                shifted = (left_int32.astype(np.int64) >> AUDIO_BIT_SHIFT)
                clipped = np.clip(shifted, -32768, 32767)
                left_int16 = clipped.astype(np.int16)
                audio_wav.writeframes(left_int16.tobytes())

                if time.time() - segment_start >= AUDIO_SEGMENT_SECONDS:
                    audio_wav.close()
                    audio_wav, audio_path = new_audio_segment(hour_dir)
                    segment_start = time.time()
                    print(f"  -> {audio_path}")

    except KeyboardInterrupt:
        print("\nStopped by user.")
    finally:
        audio_wav.close()
        proc.terminate()

if __name__ == "__main__":
    main()
