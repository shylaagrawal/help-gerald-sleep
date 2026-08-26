"""
run_pipeline.py

Run daily by GitHub Actions. Checks Google Drive (via rclone, already
configured by the workflow) for any night's summary zip that hasn't been
processed yet, downloads it, unzips it, classifies its clips with YAMNet,
runs the background-subtraction/centroid analysis, and prepares compressed
audio + CSVs for the website. Keeps a manifest so nights never get
processed twice.

Manual backfill: set the BACKFILL_DATES env var to a comma-separated list
of dates (e.g. "2026-08-22,2026-08-23") to force-reprocess specific nights
even if they're already in processed_nights.txt -- useful when a new
pipeline step (like prepare_web_assets.py) gets added after a night was
already classified. This re-downloads the zip from Drive (which still has
the raw audio clips) and runs the full pipeline again for just those dates.

Deletes the raw audio clips after prepare_web_assets.py has compressed and
copied what it needs into website/data/, so the git repo doesn't balloon
with raw WAV files over time.
"""

import os
import sys
import subprocess
import zipfile
import re
import shutil

sys.path.insert(0, os.path.dirname(__file__))
import classify_clips
import analyze_events
import prepare_web_assets

REMOTE = "gdrive:gerald_backups/"
RESULTS_DIR = "classifier/results"
MANIFEST_PATH = "classifier/processed_nights.txt"


def load_manifest():
    if not os.path.exists(MANIFEST_PATH):
        return set()
    with open(MANIFEST_PATH) as f:
        return set(line.strip() for line in f if line.strip())


def save_manifest(processed):
    with open(MANIFEST_PATH, "w") as f:
        for name in sorted(processed):
            f.write(name + "\n")


def list_remote_zips():
    result = subprocess.run(
        ["rclone", "lsf", REMOTE, "--include", "*.zip", "--files-only"],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        print("rclone lsf failed. stdout:")
        print(result.stdout)
        print("rclone lsf failed. stderr:")
        print(result.stderr)
        result.check_returncode()
    return [line.strip() for line in result.stdout.splitlines() if line.strip()]


def process_zip(zip_name, processed):
    """
    Downloads one night's zip from Drive, classifies its clips, runs the
    background-subtraction/centroid analysis, and prepares compressed
    audio + CSVs for the website. Marks the zip as processed on success.
    """
    print(f"Processing {zip_name}...")
    subprocess.run(["rclone", "copy", REMOTE + zip_name, RESULTS_DIR], check=True)
    local_zip = os.path.join(RESULTS_DIR, zip_name)

    with zipfile.ZipFile(local_zip, "r") as z:
        z.extractall(RESULTS_DIR)
    os.remove(local_zip)

    m = re.match(r"night_(\d{4}-\d{2}-\d{2})_summary\.zip", zip_name)
    if not m:
        print(f"  Couldn't parse a date from {zip_name}, skipping classification")
        processed.add(zip_name)
        save_manifest(processed)
        return

    date_str = m.group(1)
    night_dir = os.path.join(RESULTS_DIR, f"night_{date_str}")

    try:
        classify_clips.process_night(night_dir)
    except Exception as e:
        print(f"  Classification failed for {date_str}: {e}")
        # Don't mark as processed -- we want to retry this night next run
        return
    try:
        analyze_events.process_night(date_str)
    except Exception as e:
        print(f"  Analyzing failed for {date_str}: {e}")

    # Compress clips + copy CSVs into website/data/ so the site can actually
    # serve them (classifier/results/ never gets deployed), then drop the
    # raw WAVs -- the compressed copies under website/data/ are what stick
    # around long-term.
    try:
        prepare_web_assets.process_night(date_str, night_dir)
    except Exception as e:
        print(f"  prepare_web_assets failed for {date_str}: {e}")

    clips_dir = os.path.join(night_dir, f"peak_audio_clips_{date_str}")
    if os.path.isdir(clips_dir):
        shutil.rmtree(clips_dir)

    processed.add(zip_name)
    save_manifest(processed)
    print(f"  Done with {date_str}")


def main():
    os.makedirs(RESULTS_DIR, exist_ok=True)
    processed = load_manifest()

    backfill_env = os.environ.get("BACKFILL_DATES", "").strip()
    if backfill_env:
        backfill_dates = [d.strip() for d in backfill_env.split(",") if d.strip()]
        for date_str in backfill_dates:
            zip_name = f"night_{date_str}_summary.zip"
            print(f"Backfilling {date_str}...")
            process_zip(zip_name, processed)
        return

    zips = list_remote_zips()
    new_zips = [z for z in zips if z not in processed]

    if not new_zips:
        print("No new nights to process.")
        return

    for zip_name in new_zips:
        process_zip(zip_name, processed)


if __name__ == "__main__":
    main()
