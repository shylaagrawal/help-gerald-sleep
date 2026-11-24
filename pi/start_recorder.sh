#!/bin/bash
cd /home/shyla_agrawal
if ! pgrep -f "recorder.py" > /dev/null; then
    nohup /usr/bin/python3 recorder.py >> recorder_cron.log 2>&1 &
fi
