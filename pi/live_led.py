import subprocess
import threading
import time
import math
import colorsys
import numpy as np
from rpi_ws281x import PixelStrip, Color

LED_COUNT = 4
LED_PIN = 13
LED_FREQ_HZ = 800000
LED_DMA = 10
LED_BRIGHTNESS = 150
LED_INVERT = False
LED_CHANNEL = 1

REFERENCE = 1.0
CHUNK_SECONDS = 0.2
SAMPLE_RATE = 16000
LOUD_DELTA = 15.0
BASELINE_WINDOW = 50

current_db = 0.0
baseline_db = None
lock = threading.Lock()

def audio_worker():
    global current_db, baseline_db
    cmd = ["arecord", "-D", "plughw:0,0", "-c2", "-r", str(SAMPLE_RATE), "-f", "S32_LE", "-t", "raw"]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE)
    bytes_per_chunk = int(SAMPLE_RATE * CHUNK_SECONDS) * 2 * 4
    history = []
    while True:
        raw = proc.stdout.read(bytes_per_chunk)
        if len(raw) < bytes_per_chunk:
            continue
        samples = np.frombuffer(raw, dtype="<i4").astype(np.float64)
        left = samples[0::2]
        rms = np.sqrt(np.mean(left ** 2))
        db = 20 * math.log10(rms / REFERENCE) if rms > 0 else 0.0
        db = max(db, 0.0)
        with lock:
            current_baseline = baseline_db if baseline_db is not None else db
            is_loud_now = (db - current_baseline) > LOUD_DELTA
            current_db = db
            if not is_loud_now:
                history.append(db)
                if len(history) > BASELINE_WINDOW:
                    history.pop(0)
                if history:
                    baseline_db = sum(history) / len(history)

def hsv_to_rgb255(h, s, v):
    r, g, b = colorsys.hsv_to_rgb(h, s, v)
    return int(r * 255), int(g * 255), int(b * 255)

def main():
    strip = PixelStrip(LED_COUNT, LED_PIN, LED_FREQ_HZ, LED_DMA, LED_INVERT, LED_BRIGHTNESS, LED_CHANNEL)
    strip.begin()
    t = threading.Thread(target=audio_worker, daemon=True)
    t.start()
    print("Warming up baseline for a few seconds...")
    time.sleep(3)
    frame = 0
    while True:
        with lock:
            db = current_db
            base = baseline_db if baseline_db is not None else 0.0
        is_loud = (db - base) > LOUD_DELTA
        hue = 0.0 if is_loud else 0.33
        for i in range(LED_COUNT):
            phase = (frame * 0.08) + (i * 1.4)
            brightness = 0.4 + 0.6 * (0.5 + 0.5 * math.sin(phase))
            r, g, b = hsv_to_rgb255(hue, 1.0, brightness)
            strip.setPixelColor(i, Color(r, g, b))
        strip.show()
        print(f"db={db:6.1f}  baseline={base:6.1f}  {'RED' if is_loud else 'green'}")
        frame += 1
        time.sleep(0.05)

if __name__ == "__main__":
    main()
