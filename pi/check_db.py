import sys
import wave
import struct
import numpy as np

if len(sys.argv) < 2:
    print("Usage: python3 check_db.py <filename.wav>")
    sys.exit(1)

filename = sys.argv[1]
CHUNK_SECONDS = 0.5

w = wave.open(filename, "rb")
channels = w.getnchannels()
rate = w.getframerate()
sampwidth = w.getsampwidth()

print(f"File: {filename}")
print(f"Channels: {channels}, Rate: {rate}, Sample width: {sampwidth} bytes")
print("-" * 40)

frames = w.readframes(w.getnframes())

if sampwidth == 4:
    fmt = "<" + str(len(frames) // 4) + "i"
elif sampwidth == 2:
    fmt = "<" + str(len(frames) // 2) + "h"
else:
    raise ValueError(f"Unexpected sample width: {sampwidth}")

samples = struct.unpack(fmt, frames)
samples = np.array(samples, dtype=np.float64)

if channels == 2:
    left = samples[0::2]
else:
    left = samples

chunk_size = int(rate * CHUNK_SECONDS)
num_chunks = len(left) // chunk_size

REFERENCE = 1.0

for i in range(num_chunks):
    chunk = left[i * chunk_size:(i + 1) * chunk_size]
    rms = np.sqrt(np.mean(chunk ** 2))
    if rms <= 0:
        db = 0.0
    else:
        db = 20 * np.log10(rms / REFERENCE)
        db = max(db, 0.0)
    t = i * CHUNK_SECONDS
    bar = "#" * int(db / 2)
    print(f"t={t:4.1f}s  db={db:7.1f}  {bar}")

print("-" * 40)
print(f"Overall min/max amplitude: {left.min():.0f} / {left.max():.0f}")
