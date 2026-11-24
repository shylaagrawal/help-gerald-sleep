#!/bin/bash
BASE_DIR="/home/shyla_agrawal/gerald_night_data"

# Delete hour-long audio folders older than 5 days
find "$BASE_DIR" -maxdepth 2 -type d -name "hour_audio_*" -mtime +5 -exec rm -rf {} + 2>/dev/null

# Delete peak clip folders older than 10 days
find "$BASE_DIR" -maxdepth 2 -type d -name "peak_audio_clips_*" -mtime +10 -exec rm -rf {} + 2>/dev/null

echo "$(date): Cleanup ran" >> /home/shyla_agrawal/cleanup.log
