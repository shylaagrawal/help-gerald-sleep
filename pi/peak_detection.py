import sys
import os
import csv
import glob
import wave
import datetime
import numpy as np

BASELINE_WINDOW_SECONDS = 60
LOUD_DELTA = 15.0
MAX_GAP_SECONDS = 3
PADDING_SECONDS = 15
MIN_EVENT_SECONDS = 2

BASE_DIR = "/home/shyla_agrawal/gerald_night_data"

def load_night_csv(path):
    rows = []
    with open(path, "r", newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            ts = datetime.datetime.fromisoformat(row["timestamp"])
            db = float(row["calibrated_db_a"])
            rows.append((ts, db))
    return rows

def compute_rolling_baseline_and_flags(rows):
    history = []
    baseline = None
    flagged = []
    for ts, db in rows:
        current_baseline = baseline if baseline is not None else db
        is_loud = (db - current_baseline) > LOUD_DELTA
        flagged.append((ts, db, is_loud, current_baseline))
        if not is_loud:
            history.append(db)
            if len(history) > BASELINE_WINDOW_SECONDS:
                history.pop(0)
            if history:
                baseline = sum(history) / len(history)
    return flagged

def group_into_events(flagged):
    events = []
    current = None
    for ts, db, is_loud, baseline in flagged:
        if is_loud:
            if current is None:
                current = {"start": ts, "end": ts, "peak_db": db, "peak_time": ts, "baseline": baseline}
            else:
                gap = (ts - current["end"]).total_seconds()
                if gap <= MAX_GAP_SECONDS:
                    current["end"] = ts
                    if db > current["peak_db"]:
                        current["peak_db"] = db
                        current["peak_time"] = ts
                else:
                    events.append(current)
                    current = {"start": ts, "end": ts, "peak_db": db, "peak_time": ts, "baseline": baseline}
        else:
            if current is not None:
                events.append(current)
                current = None
    if current is not None:
        events.append(current)
    events = [e for e in events if (e["end"] - e["start"]).total_seconds() >= MIN_EVENT_SECONDS]
    return events

def load_audio_segments(hour_dir):
    segments = []
    for path in sorted(glob.glob(os.path.join(hour_dir, "*.wav"))):
        name = os.path.basename(path)
        ts_str = name.replace(".wav", "")
        try:
            date_part, time_part = ts_str.split("_", 1)
            time_part_colons = time_part.replace("-", ":")
            ts = datetime.datetime.fromisoformat(f"{date_part}T{time_part_colons}")
            segments.append((ts, path))
        except ValueError:
            print(f"Warning: couldn't parse timestamp from {name}, skipping")
    segments.sort()
    return segments

def get_segment_duration(path):
    wf = wave.open(path, "rb")
    frames = wf.getnframes()
    rate = wf.getframerate()
    wf.close()
    return frames / rate

def extract_clip(window_start, window_end, segments):
    """Pull audio covering [window_start, window_end], stitching across
    hour-file boundaries if the window happens to straddle one."""
    collected = []
    sample_rate = None
    for seg_start, seg_path in segments:
        duration = get_segment_duration(seg_path)
        seg_end = seg_start + datetime.timedelta(seconds=duration)
        overlap_start = max(seg_start, window_start)
        overlap_end = min(seg_end, window_end)
        if overlap_start < overlap_end:
            wf = wave.open(seg_path, "rb")
            sample_rate = wf.getframerate()
            start_frame = int((overlap_start - seg_start).total_seconds() * sample_rate)
            end_frame = int((overlap_end - seg_start).total_seconds() * sample_rate)
            wf.setpos(start_frame)
            raw = wf.readframes(end_frame - start_frame)
            wf.close()
            collected.append((overlap_start, np.frombuffer(raw, dtype="<i2")))
    if not collected:
        return None, None
    collected.sort(key=lambda x: x[0])
    combined = np.concatenate([c[1] for c in collected])
    return combined, sample_rate

def save_clip(samples, sample_rate, peak_time, out_dir):
    ts_str = peak_time.strftime("%Y-%m-%d_%H-%M-%S")
    path = os.path.join(out_dir, f"{ts_str}.wav")
    wf = wave.open(path, "wb")
    wf.setnchannels(1)
    wf.setsampwidth(2)
    wf.setframerate(sample_rate)
    wf.writeframes(samples.tobytes())
    wf.close()
    return path

def main():
    if len(sys.argv) < 2:
        print("Usage: python3 peak_detection.py <night_date, e.g. 2026-08-16>")
        sys.exit(1)

    date_str = sys.argv[1]
    night_dir = os.path.join(BASE_DIR, f"night_{date_str}")
    csv_path = os.path.join(night_dir, f"raw_data_{date_str}.csv")
    hour_dir = os.path.join(night_dir, f"hour_audio_{date_str}")
    clips_dir = os.path.join(night_dir, f"peak_audio_clips_{date_str}")
    os.makedirs(clips_dir, exist_ok=True)

    if not os.path.exists(csv_path):
        print(f"CSV not found: {csv_path}")
        sys.exit(1)

    rows = load_night_csv(csv_path)
    print(f"Loaded {len(rows)} readings from {csv_path}")

    flagged = compute_rolling_baseline_and_flags(rows)
    events = group_into_events(flagged)
    print(f"Found {len(events)} candidate events")

    segments = load_audio_segments(hour_dir)
    print(f"Found {len(segments)} audio hour-files in {hour_dir}")

    out_name = os.path.join(night_dir, f"peaks_{date_str}.csv")
    saved_clips = 0

    with open(out_name, "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow([
            "event_id", "start", "end", "loud_duration_seconds",
            "peak_time", "peak_db", "baseline_db",
            "clip_window_start", "clip_window_end", "clip_duration_seconds",
            "clip_file"
        ])
        for i, e in enumerate(events):
            loud_duration = (e["end"] - e["start"]).total_seconds()
            window_start = e["start"] - datetime.timedelta(seconds=PADDING_SECONDS)
            window_end = e["end"] + datetime.timedelta(seconds=PADDING_SECONDS)
            clip_duration = (window_end - window_start).total_seconds()

            samples, sample_rate = extract_clip(window_start, window_end, segments)

            clip_path = ""
            if samples is not None and len(samples) > 0:
                clip_path = save_clip(samples, sample_rate, e["peak_time"], clips_dir)
                saved_clips += 1
            else:
                print(f"  Warning: no audio found for event {i} at {e['peak_time']}")

            writer.writerow([
                i,
                e["start"].isoformat(),
                e["end"].isoformat(),
                round(loud_duration, 1),
                e["peak_time"].isoformat(),
                round(e["peak_db"], 2),
                round(e["baseline"], 2),
                window_start.isoformat(),
                window_end.isoformat(),
                round(clip_duration, 1),
                clip_path,
            ])

    print(f"Saved {len(events)} events to {out_name}")
    print(f"Extracted {saved_clips} audio clips to {clips_dir}")

if __name__ == "__main__":
    main()
