#!/bin/bash
pkill -f recorder.py

# Wait for recorder.py to actually finish exiting (up to 30 sec)
for i in $(seq 1 30); do
    if ! pgrep -f "recorder.py" > /dev/null; then
        break
    fi
    sleep 1
done

# Small buffer to let the OS finish flushing the last file writes
sleep 2

/home/shyla_agrawal/morning_pipeline.sh
