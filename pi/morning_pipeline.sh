#!/bin/bash
# Runs at 6:30 AM (after the recorder is stopped): finds the night's loud
# events, zips the results, and uploads the zip to Google Drive.
#
# Uploads are retried (the Pi's Wi-Fi sometimes drops for a minute), and a zip
# is only deleted after Drive confirms it. Any zip that still hasn't uploaded
# is kept and retried at the next morning's run.

HOME_DIR="${HOME_DIR:-/home/shyla_agrawal}"
RCLONE="${RCLONE:-/usr/bin/rclone}"
RETRY_SLEEP="${RETRY_SLEEP:-60}"     # seconds between upload attempts
MAX_ATTEMPTS=5

cd "$HOME_DIR"
DATA="$HOME_DIR/gerald_night_data"
LOG="$HOME_DIR/morning_pipeline.log"

# Upload every night_*_summary.zip that is still waiting, then delete each one
# only if its upload succeeded.
upload_pending_zips() {
    local zip name attempt
    for zip in "$DATA"/night_*_summary.zip; do
        [ -e "$zip" ] || continue
        name=$(basename "$zip")
        for attempt in $(seq 1 $MAX_ATTEMPTS); do
            if "$RCLONE" copy "$zip" gdrive:gerald_backups/ >> "$LOG" 2>&1; then
                echo "$(date): Upload complete for $name" >> "$LOG"
                rm "$zip"
                break
            fi
            echo "$(date): Upload of $name failed (attempt $attempt of $MAX_ATTEMPTS)" >> "$LOG"
            [ "$attempt" -lt "$MAX_ATTEMPTS" ] && sleep "$RETRY_SLEEP"
        done
        if [ -e "$zip" ]; then
            echo "$(date): Upload FAILED for $name - zip kept, will retry next morning" >> "$LOG"
        fi
    done
}

NIGHT_DATE=$(python3 -c "
import datetime
now = datetime.datetime.now()
if now.hour < 12:
    d = now.date() - datetime.timedelta(days=1)
else:
    d = now.date()
print(d.isoformat())
")

echo "$(date): Processing night: $NIGHT_DATE" >> "$LOG"

CSV_PATH="gerald_night_data/night_${NIGHT_DATE}/raw_data_${NIGHT_DATE}.csv"

if [ ! -f "$CSV_PATH" ]; then
    echo "$(date): No CSV found at $CSV_PATH, skipping (nothing to process)" >> "$LOG"
    upload_pending_zips   # still retry any zip left over from an earlier failure
    exit 0
fi

python3 peak_detection.py "$NIGHT_DATE" >> "$LOG" 2>&1
if [ $? -ne 0 ]; then
    echo "$(date): peak_detection.py failed, skipping upload" >> "$LOG"
    exit 1
fi

cd "$DATA"
zip -r "night_${NIGHT_DATE}_summary.zip" \
    "night_${NIGHT_DATE}/raw_data_${NIGHT_DATE}.csv" \
    "night_${NIGHT_DATE}/peaks_${NIGHT_DATE}.csv" \
    "night_${NIGHT_DATE}/peak_audio_clips_${NIGHT_DATE}" \
    >> "$LOG" 2>&1
if [ $? -ne 0 ]; then
    echo "$(date): zip failed for $NIGHT_DATE, skipping upload" >> "$LOG"
    exit 1
fi

upload_pending_zips
cd "$HOME_DIR"
