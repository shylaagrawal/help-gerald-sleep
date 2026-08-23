"""
run_pipeline.py
 
Run daily by GitHub Actions. Checks Google Drive (via rclone, already
configured by the workflow) for any night's summary zip that hasn't been
processed yet, downloads it, unzips it, classifies its clips with YAMNet,
and keeps a manifest so nights never get processed twice.
 
Deletes the raw audio clips after classification (keeps only the small
CSV results) so the git repo doesn't balloon with binary audio files over
time -- if you want to keep audio for spot-checking, comment out the
cleanup step near the bottom.
"""
 
import os
import sys
import subprocess
import zipfile
import re
import shutil
 
sys.path.insert(0, os.path.dirname(__file__))
import classify_clips
 
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
 
 
def main():
    os.makedirs(RESULTS_DIR, exist_ok=True)
    processed = load_manifest()
    zips = list_remote_zips()
    new_zips = [z for z in zips if z not in processed]
 
    if not new_zips:
        print("No new nights to process.")
        return
 
    for zip_name in new_zips:
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
            continue
 
        date_str = m.group(1)
        night_dir = os.path.join(RESULTS_DIR, f"night_{date_str}")
 
        try:
            classify_clips.process_night(night_dir)
        except Exception as e:
            print(f"  Classification failed for {date_str}: {e}")
            # Don't mark as processed -- we want to retry this night next run
            continue
 
        # Keep only the CSVs, drop the raw audio clips to keep repo size sane
        clips_dir = os.path.join(night_dir, f"peak_audio_clips_{date_str}")
        if os.path.isdir(clips_dir):
            shutil.rmtree(clips_dir)
 
        processed.add(zip_name)
        save_manifest(processed)
        print(f"  Done with {date_str}")
 
 
if __name__ == "__main__":
    main()