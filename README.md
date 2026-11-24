# Help Gerald Sleep 🪿

Gerald is a goose who can't sleep because of road noise, and he's a lot like the rest of us on a busy street in Bothell, WA. **Help Gerald Sleep** is a neighborhood road-noise project: a small home-built noise monitor (also named Gerald) records the street overnight, picks out the individual vehicles, and publishes their measured loudness next to the World Health Organization's night-time guideline.

**Live site:** https://helpgeraldsleep.pages.dev  
**See the data:** https://helpgeraldsleep.pages.dev/data.html

## What Gerald does

1. **Records.** A Raspberry Pi Zero W with an INMP441 microphone sits in a 3D-printed goose on my windowsill and records from midnight to 6:30 AM. Four LEDs light up when it hears something loud. (Code: [`pi/`](pi).)
2. **Finds the loud moments.** Each morning the Pi finds the moments that rise well above the quiet background, saves a short audio clip around each one, and uploads everything to Google Drive.
3. **Identifies vehicles.** A GitHub Actions job downloads each new night and runs [YAMNet](https://tfhub.dev/google/yamnet/1), Google's pretrained sound classifier, on every clip to decide whether it was a vehicle.
4. **Isolates each car.** The background noise just before and after each vehicle is subtracted (in power, not decibels, since decibels are logarithmic) to estimate how loud the vehicle itself was.
5. **Publishes.** Results, charts and short audio clips are added to the website, which Cloudflare Pages deploys automatically.

```
Pi (record + find peaks) → Google Drive → GitHub Actions (classify + analyze) → website/ → Cloudflare Pages
```

## What's in this repo

| Folder | What it holds |
| --- | --- |
| `website/` | The public site (HTML, CSS, JS) and the processed data it displays, one folder per night in `website/data/` |
| `pi/` | The code that runs on Gerald's Raspberry Pi: recording, loud-event detection, the morning upload to Drive, plus calibration and hardware-test scripts. See [`pi/README.md`](pi/README.md). |
| `classifier/` | The nightly analysis pipeline: `run_pipeline.py` runs `classify_clips.py` → `analyze_events.py` → `prepare_web_assets.py`. Per-night results are saved in `classifier/results/`. |
| `3D_Gerald/` | Blender and STL files for Gerald's 3D-printed case |
| `.github/workflows/` | `classify-nightly.yml` runs the pipeline on new nights. `gerald-watchdog.yml` emails me if a night's recording never reaches Drive. |

## How the pipeline runs

- `classify-nightly.yml` checks Google Drive three times a day for nights that haven't been processed yet (listed in `classifier/processed_nights.txt`). If it finds any, it processes them and commits the results. You can also run it by hand from the Actions tab and give it `backfill_dates` to reprocess specific nights.
- The classifier needs TensorFlow, which the Pi Zero W can't run, so classification happens in GitHub Actions instead.
- Raw audio is never committed. Only short, compressed clips of detected vehicles are published.

## Limitations

- Sound levels are calibrated against a phone sound-level meter (R² = 0.97, 8 reference points), not lab equipment. Treat anything above about 75 dB(A) as approximate.
- The WHO's 45 dB(A) night guideline is for a single event measured **inside a bedroom**. Gerald measures at a windowsill, so the comparison is a guide, not a legal measurement.
- Only events that rise well above the quiet background are detected, so very quiet vehicles are not counted.

## Run it yourself

The analysis needs Python 3.10+ and ffmpeg:

```
pip install -r classifier/requirements.txt
python3 classifier/scripts/run_pipeline.py
```

`run_pipeline.py` reads from a Google Drive folder through an `rclone` config, so it needs your own Drive credentials. To look at the data without running anything, open any night's folder in `website/data/`.

## About

Started by Shyla Agrawal (North Creek High School, Bothell WA). The county traffic research behind it was done with Swarali Karale and supervised by Mr. Jason Rukman. Traffic data: Snohomish County Public Works and the Washington Traffic Safety Commission. Methodology: see the link at the bottom of the [data page](https://helpgeraldsleep.pages.dev/data.html).

Code is released under the [MIT License](LICENSE).
