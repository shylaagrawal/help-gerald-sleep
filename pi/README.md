# Gerald's Raspberry Pi code

This is the code that runs on Gerald himself: a Raspberry Pi Zero W with an INMP441 I2S microphone and four WS2812B LEDs. It records the street overnight, finds the loud moments, and uploads each night to Google Drive. The analysis that happens afterwards is in [`classifier/`](../classifier).

## The daily schedule

Gerald's schedule is in [`crontab.txt`](crontab.txt) and runs in the Pi's local time, so daylight saving needs no special handling:

| Time | Script | What happens |
| --- | --- | --- |
| 12:00 AM | `start_recorder.sh` | Starts `recorder.py` (unless it's already running) |
| 6:30 AM | `stop_and_process.sh` | Stops the recorder, then runs `morning_pipeline.sh` |
| 1:00 PM | `cleanup_old_data.sh` | Deletes old audio to free up space |

## The scripts

**Overnight pipeline**

| File | What it does |
| --- | --- |
| `recorder.py` | Records from the microphone. Once per second it logs a calibrated dB(A) reading to `raw_data_DATE.csv` (columns: `timestamp`, `apparent_db`, `calibrated_db_a`), and it saves the audio as one-hour mono WAV files. Needs `calibration.json`. |
| `peak_detection.py` | Finds loud events. A reading is "loud" if it is more than 15 dB above the average of the previous 60 quiet readings. Loud readings less than 3 seconds apart are merged into one event, events shorter than 2 seconds are dropped, and a clip with 15 seconds of audio on each side is saved for every event. Writes `peaks_DATE.csv`. |
| `morning_pipeline.sh` | Runs peak detection, zips the night's `raw_data`, `peaks` and clips, and uploads the zip to Google Drive with `rclone`. Everything is logged to `morning_pipeline.log`. |
| `start_recorder.sh`, `stop_and_process.sh` | Small wrappers that cron calls to start and stop the recorder. |
| `cleanup_old_data.sh` | Removes hour-long audio older than 5 days and peak clips older than 10 days. |

**Setup and testing**

| File | What it does |
| --- | --- |
| `calibrate.py` | Calibrates the microphone. Hold a steady sound, press Enter to freeze Gerald's reading, then type what a phone sound meter shows. After 6 or more points it fits a straight line and saves it to `calibration.json`. |
| `calibration.json` | The result of the calibration: `real_dB = slope × apparent_dB + intercept`, plus the points used. |
| `live_led.py` | Runs the LEDs live. They glow green, and turn red when the sound is more than 15 dB above a rolling baseline of the last 50 quiet readings (about 10 seconds). |
| `test_leds.py`, `test_hardware.py` | Check the LEDs and microphone after wiring or changes. |
| `check_db.py` | Prints the loudness over time for any WAV file. Handy for checking a clip. |

## Notes

- **Only one program can use the microphone at a time.** Stop the recorder (`pkill -f recorder.py`) before running `calibrate.py`, `live_led.py` or the hardware test.
- The scripts use the Pi's home folder (`/home/shyla_agrawal`) and `gerald_night_data/` for storage. Change those paths if you set up your own.
- The uploads need an `rclone` remote called `gdrive`. The credentials are set up on the Pi and are not in this repo.
- LED control uses the `rpi_ws281x` library, which usually needs `sudo`.
- Only the left channel of the microphone is used.
