"""
prepare_web_assets.py

Runs after analyze_events.py in the nightly pipeline. Takes one night's
results (peaks_DATE.csv, final_isolated_results_DATE.csv, raw_data_DATE.csv,
and the raw WAV clips) and produces everything data.html needs to render
that night, written into website/data/<date>/ so it's actually deployed
by Cloudflare Pages (classifier/results/ is not).

Audio clips are trimmed to a FIXED 15 seconds, centered on the car's
actual centroid moment, then compressed to MP3 (mono, 64kbps). The
source clips from peak_detection.py are intentionally variable-length
(needed for the background-subtraction math in analyze_events.py), but
a fixed length is more predictable and less "boring" for a visitor
listening on the website, and makes it easy to sync a moving playhead
against the clip on the front end.

Also maintains website/data/manifest.json, a flat list of every night
that's been processed, so the site knows what nights exist without
needing a directory listing.
"""

import os
import csv
import json
import shutil
import subprocess
import datetime

WEBSITE_DATA_DIR = "website/data"
MANIFEST_PATH = os.path.join(WEBSITE_DATA_DIR, "manifest.json")
FIXED_CLIP_SECONDS = 15.0


def trim_and_compress_clip(wav_path, mp3_path, start_seconds, duration_seconds):
    subprocess.run(
        [
            "ffmpeg", "-y", "-loglevel", "error",
            "-ss", str(max(0, start_seconds)),
            "-i", wav_path,
            "-t", str(duration_seconds),
            "-codec:a", "libmp3lame", "-b:a", "64k", "-ac", "1",
            mp3_path,
        ],
        check=True,
    )


def compute_trim_window(centroid_time, clip_window_start, clip_duration_seconds):
    """
    Returns (start_seconds, duration_seconds) into the ORIGINAL variable-
    length clip that gives a fixed FIXED_CLIP_SECONDS window centered on
    the car's centroid moment -- shifted inward (not padded with silence)
    if the car happened too close to either edge of the original clip.
    """
    centroid_offset = (centroid_time - clip_window_start).total_seconds()

    if clip_duration_seconds <= FIXED_CLIP_SECONDS:
        # original clip is already shorter than our target -- just use all of it
        return 0.0, clip_duration_seconds

    half = FIXED_CLIP_SECONDS / 2
    start = centroid_offset - half
    start = max(0.0, min(start, clip_duration_seconds - FIXED_CLIP_SECONDS))

    return start, FIXED_CLIP_SECONDS


def read_csv_rows(path):
    with open(path, newline="") as f:
        return list(csv.DictReader(f))


def build_night_summary(date_str, final_rows):
    if not final_rows:
        return {
            "date": date_str, "events": 0, "peak_isolated_db": None,
            "violations_45db": 0, "avg_isolated_db": None,
        }
    isolated = [float(r["isolated_db_a"]) for r in final_rows]
    violations = sum(1 for r in final_rows if r["exceeds_who_45db_threshold"] == "True")
    return {
        "date": date_str,
        "events": len(final_rows),
        "peak_isolated_db": round(max(isolated), 1),
        "violations_45db": violations,
        "avg_isolated_db": round(sum(isolated) / len(isolated), 1),
    }


def update_manifest(night_summary):
    manifest = []
    if os.path.exists(MANIFEST_PATH):
        with open(MANIFEST_PATH) as f:
            manifest = json.load(f)
    manifest = [n for n in manifest if n["date"] != night_summary["date"]]
    manifest.append(night_summary)
    manifest.sort(key=lambda n: n["date"])
    os.makedirs(WEBSITE_DATA_DIR, exist_ok=True)
    with open(MANIFEST_PATH, "w") as f:
        json.dump(manifest, f, indent=2)


def process_night(date_str, night_dir):
    peaks_path = os.path.join(night_dir, f"peaks_{date_str}.csv")
    final_path = os.path.join(night_dir, f"final_isolated_results_{date_str}.csv")
    raw_path = os.path.join(night_dir, f"raw_data_{date_str}.csv")
    clips_dir = os.path.join(night_dir, f"peak_audio_clips_{date_str}")

    if not os.path.exists(peaks_path) or not os.path.exists(final_path):
        print(f"  prepare_web_assets: missing CSVs for {date_str}, skipping")
        return

    out_dir = os.path.join(WEBSITE_DATA_DIR, date_str)
    out_audio_dir = os.path.join(out_dir, "audio")
    os.makedirs(out_audio_dir, exist_ok=True)

    shutil.copy(peaks_path, os.path.join(out_dir, "peaks.csv"))
    shutil.copy(final_path, os.path.join(out_dir, "final.csv"))
    if os.path.exists(raw_path):
        shutil.copy(raw_path, os.path.join(out_dir, "raw.csv"))

    peaks_rows = read_csv_rows(peaks_path)
    final_rows = read_csv_rows(final_path)

    # need each confirmed event's centroid_timestamp to center the trim on
    final_by_id = {r["event_id"]: r for r in final_rows}

    for row in peaks_rows:
        event_id = row["event_id"]
        clip_filename = os.path.basename(row.get("clip_file", ""))
        local_clip_path = os.path.join(clips_dir, clip_filename)
        mp3_path = os.path.join(out_audio_dir, f"{event_id}.mp3")

        if not clip_filename or not os.path.exists(local_clip_path):
            print(f"  prepare_web_assets: clip missing for event {event_id}, skipping audio")
            continue

        final_row = final_by_id.get(event_id)
        if not final_row:
            # not a confirmed vehicle (filtered out in analyze_events.py) -- no audio needed
            continue

        centroid_time = datetime.datetime.fromisoformat(final_row["centroid_timestamp"])
        clip_window_start = datetime.datetime.fromisoformat(row["clip_window_start"])
        clip_duration = float(row["clip_duration_seconds"])

        start_seconds, duration_seconds = compute_trim_window(
            centroid_time, clip_window_start, clip_duration
        )

        trim_and_compress_clip(local_clip_path, mp3_path, start_seconds, duration_seconds)

    summary = build_night_summary(date_str, final_rows)
    update_manifest(summary)

    print(f"  prepare_web_assets: wrote {out_dir} ({len(peaks_rows)} clips processed)")
