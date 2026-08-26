"""
prepare_web_assets.py

Runs after analyze_events.py in the nightly pipeline. Takes one night's
results (peaks_DATE.csv, final_isolated_results_DATE.csv, raw_data_DATE.csv,
and the raw WAV clips) and produces everything data.html needs to render
that night, written into website/data/<date>/ so it's actually deployed
by Cloudflare Pages (classifier/results/ is not).

Audio clips are compressed to MP3 (mono, 64kbps) to keep the repo small
enough to hold audio indefinitely -- a ~32s clip goes from ~1MB WAV to
~250KB MP3, good enough to confirm "yep, that's a truck" by ear.

Also maintains website/data/manifest.json, a flat list of every night
that's been processed, so the site knows what nights exist without
needing a directory listing.
"""

import os
import csv
import json
import shutil
import subprocess

WEBSITE_DATA_DIR = "website/data"
MANIFEST_PATH = os.path.join(WEBSITE_DATA_DIR, "manifest.json")


def compress_clip(wav_path, mp3_path):
    subprocess.run(
        [
            "ffmpeg", "-y", "-loglevel", "error",
            "-i", wav_path,
            "-codec:a", "libmp3lame", "-b:a", "64k", "-ac", "1",
            mp3_path,
        ],
        check=True,
    )


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
    for row in peaks_rows:
        event_id = row["event_id"]
        clip_filename = os.path.basename(row.get("clip_file", ""))
        local_clip_path = os.path.join(clips_dir, clip_filename)
        mp3_path = os.path.join(out_audio_dir, f"{event_id}.mp3")

        if not clip_filename or not os.path.exists(local_clip_path):
            print(f"  prepare_web_assets: clip missing for event {event_id}, skipping audio")
            continue

        compress_clip(local_clip_path, mp3_path)

    final_rows = read_csv_rows(final_path)
    summary = build_night_summary(date_str, final_rows)
    update_manifest(summary)

    print(f"  prepare_web_assets: wrote {out_dir} ({len(peaks_rows)} clips compressed)")
