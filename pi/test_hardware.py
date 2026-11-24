import subprocess
import time
import sys
import numpy as np
from rpi_ws281x import PixelStrip, Color

LED_COUNT = 4
LED_PIN = 13
LED_FREQ_HZ = 800000
LED_DMA = 10
LED_BRIGHTNESS = 60
LED_INVERT = False
LED_CHANNEL = 1

SAMPLE_RATE = 16000
RECORD_SECONDS = 10
MIN_RMS_THRESHOLD = 50  # anything meaningfully above near-silent (~20-40) counts as working

def test_leds():
    try:
        strip = PixelStrip(LED_COUNT, LED_PIN, LED_FREQ_HZ, LED_DMA, LED_INVERT, LED_BRIGHTNESS, LED_CHANNEL)
        strip.begin()

        print("  All LEDs GREEN for 3 seconds...")
        for i in range(LED_COUNT):
            strip.setPixelColor(i, Color(0, 255, 0))
        strip.show()
        time.sleep(3)

        print("  All LEDs RED for 3 seconds...")
        for i in range(LED_COUNT):
            strip.setPixelColor(i, Color(255, 0, 0))
        strip.show()
        time.sleep(3)

        print("  Chasing blue light across each pixel individually...")
        for _ in range(2):  # two full passes so it's easy to catch
            for i in range(LED_COUNT):
                for j in range(LED_COUNT):
                    strip.setPixelColor(j, Color(0, 0, 0))
                strip.setPixelColor(i, Color(0, 0, 255))
                strip.show()
                time.sleep(0.3)

        for i in range(LED_COUNT):
            strip.setPixelColor(i, Color(0, 0, 0))
        strip.show()

        return True, "LEDs ran green -> red -> per-pixel blue chase -- confirm visually you saw all stages and all 4 pixels lit individually"
    except Exception as e:
        return False, f"LED test failed: {e}"

def test_mic():
    try:
        print(f"Recording {RECORD_SECONDS} seconds -- make varied noise throughout (quiet, then loud, then quiet)...")
        cmd = ["arecord", "-D", "plughw:0,0", "-c2", "-r", str(SAMPLE_RATE),
               "-f", "S32_LE", "-t", "raw", "-d", str(RECORD_SECONDS)]
        proc = subprocess.run(cmd, capture_output=True)
        raw = proc.stdout

        if len(raw) == 0:
            return False, "No audio captured at all (arecord returned nothing)"

        samples = np.frombuffer(raw, dtype="<i4")
        left = samples[0::2]
        left_float = left.astype(np.float64)

        rms = np.sqrt(np.mean(left_float ** 2))
        apparent_db = 20 * np.log10(rms) if rms > 0 else 0
        min_val = left.min()
        max_val = left.max()
        abs_max = np.abs(left).max()

        # break the recording into 1-second chunks to show variation over time
        chunk_size = SAMPLE_RATE
        num_chunks = len(left_float) // chunk_size
        print("\n  Per-second breakdown:")
        for c in range(num_chunks):
            chunk = left_float[c * chunk_size:(c + 1) * chunk_size]
            chunk_rms = np.sqrt(np.mean(chunk ** 2))
            chunk_db = 20 * np.log10(chunk_rms) if chunk_rms > 0 else 0
            bar = "#" * int(chunk_db / 2)
            print(f"    t={c}s  rms={chunk_rms:8.1f}  apparent_db={chunk_db:6.1f}  {bar}")

        print(f"\n  Overall min: {min_val}")
        print(f"  Overall max: {max_val}")
        print(f"  Overall abs max: {abs_max}")
        print(f"  Overall RMS: {rms:.1f}")
        print(f"  Overall apparent dB: {apparent_db:.1f}")

        if rms >= MIN_RMS_THRESHOLD:
            return True, f"Mic captured real signal (RMS={rms:.1f}, min={min_val}, max={max_val})"
        else:
            return False, f"Mic signal too weak/silent (RMS={rms:.1f}, min={min_val}, max={max_val}) -- check wiring"
    except Exception as e:
        return False, f"Mic test failed: {e}"

def main():
    print("=" * 50)
    print("Gerald combined hardware test: LEDs + Mic")
    print("=" * 50)

    print("\n--- LED TEST ---")
    led_ok, led_msg = test_leds()
    print(f"\n[LED]  {'PASS' if led_ok else 'FAIL'} -- {led_msg}")

    print("\n--- MIC TEST ---")
    mic_ok, mic_msg = test_mic()
    print(f"\n[MIC]  {'PASS' if mic_ok else 'FAIL'} -- {mic_msg}")

    print("\n" + "=" * 50)
    if led_ok and mic_ok:
        print("RESULT: Both LED and mic working.")
    else:
        print("RESULT: Something needs attention -- see FAIL lines above.")
    print("=" * 50)

if __name__ == "__main__":
    main()
