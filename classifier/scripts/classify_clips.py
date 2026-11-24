"""
classify_clips.py

Runs YAMNet (a pretrained audio classification model from Google's AudioSet)
on every clip listed in a night's peaks_DATE.csv and adds vehicle-confidence
scores to that file.

This does NOT run on the Pi -- YAMNet needs TensorFlow, which the Pi Zero W
cannot run. It runs in GitHub Actions (see run_pipeline.py and the workflow).

Two scores are written for every event:

  vehicle_confidence_mean   The ORIGINAL method: average YAMNet score across
                            the whole padded clip (~32 s). A car is only loud
                            for 2-5 s of that, so this is diluted ~10x.

  vehicle_confidence_event  The NEW method: highest vehicle-class score within
                            the event's own time window (event start to end,
                            plus EVENT_MARGIN_SECONDS either side). The window
                            is computed from the start / end / clip_window_start
                            columns in the peaks file.

DECISION_METHOD chooses which one sets is_vehicle (and the
vehicle_confidence column the website shows). It stays on "mean" until the
event method's threshold has been tuned on clips that were listened to and
labeled by hand.
"""

import os
import re
import sys
import csv
import datetime
import numpy as np

# ---- vehicle class matching ------------------------------------------------
# Whole-word matches against YAMNet's ~521 class names (so "car" no longer
# matches "Carnatic music" and "bus" no longer matches "Busy signal").
VEHICLE_KEYWORDS = [
    "car", "truck", "bus", "vehicle", "motorcycle", "traffic",
    "engine", "accelerating", "revving", "vroom", "skidding",
    "tire squeal", "race car", "auto racing",
]
# Classes that match a keyword but are not road vehicles.
EXCLUDED_CLASSES = {"railroad car, train wagon"}

_VEHICLE_RE = re.compile(
    r"\b(" + "|".join(re.escape(k) for k in VEHICLE_KEYWORDS) + r")\b",
    re.IGNORECASE,
)

# ---- decision settings -----------------------------------------------------
DECISION_METHOD = "mean"          # "mean" (original) or "event" (new)
MEAN_THRESHOLD = 0.025            # threshold for the original whole-clip average
EVENT_THRESHOLD = 0.25            # PLACEHOLDER: set from hand-labeled clips
                                  # before switching DECISION_METHOD to "event"

# Seconds of audio kept on each side of the detected event when scoring it.
EVENT_MARGIN_SECONDS = 1.5

# YAMNet frame geometry: 0.96 s windows, one every 0.48 s.
YAMNET_FRAME_SECONDS = 0.96
YAMNET_HOP_SECONDS = 0.48


def is_vehicle_class(name):
    if name.lower() in EXCLUDED_CLASSES:
        return False
    return bool(_VEHICLE_RE.search(name))


def load_class_names(model):
    import tensorflow as tf
    class_map_path = model.class_map_path().numpy().decode("utf-8")
    class_names = []
    with tf.io.gfile.GFile(class_map_path) as f:
        reader = csv.DictReader(f)
        for row in reader:
            class_names.append(row["display_name"])
    return class_names


def event_window_seconds(row, clip_length_seconds):
    """
    Where the event sits inside its clip, as (start_s, end_s) in seconds from
    the start of the clip, widened by EVENT_MARGIN_SECONDS. Returns None if
    the row doesn't have usable timestamps.
    """
    try:
        start = datetime.datetime.fromisoformat(row["start"])
        end = datetime.datetime.fromisoformat(row["end"])
        clip_start = datetime.datetime.fromisoformat(row["clip_window_start"])
    except (KeyError, ValueError, TypeError):
        return None
    w0 = (start - clip_start).total_seconds() - EVENT_MARGIN_SECONDS
    w1 = (end - clip_start).total_seconds() + EVENT_MARGIN_SECONDS
    w0 = max(0.0, w0)
    w1 = min(clip_length_seconds, w1)
    if w1 <= w0:
        return None
    return w0, w1


def frames_in_window(n_frames, w0, w1):
    """Indices of YAMNet frames that overlap the time window [w0, w1]."""
    starts = np.arange(n_frames) * YAMNET_HOP_SECONDS
    ends = starts + YAMNET_FRAME_SECONDS
    return np.where((ends > w0) & (starts < w1))[0]


def score_scores(scores_np, class_names, vehicle_idx, window):
    """
    Pure scoring logic (no TensorFlow), so it can be tested on its own.
    scores_np: (n_frames, n_classes) YAMNet scores for one clip.
    window: (w0, w1) seconds, or None to use the whole clip.
    """
    mean_scores = scores_np.mean(axis=0)

    # --- original method: mean over the whole clip ---
    top_idx = int(np.argmax(mean_scores))
    mean_vehicle = 0.0
    mean_vehicle_class = ""
    if len(vehicle_idx):
        best = vehicle_idx[int(np.argmax(mean_scores[vehicle_idx]))]
        mean_vehicle = float(mean_scores[best])
        mean_vehicle_class = class_names[best]

    # --- new method: best vehicle score inside the event window ---
    sel = None
    if window is not None:
        sel = frames_in_window(scores_np.shape[0], *window)
    if sel is None or len(sel) == 0:
        sel = np.arange(scores_np.shape[0])
        used_window = False
    else:
        used_window = True
    win_scores = scores_np[sel]
    event_vehicle = 0.0
    event_vehicle_class = ""
    if len(vehicle_idx):
        per_class_max = win_scores[:, vehicle_idx].max(axis=0)
        j = int(np.argmax(per_class_max))
        event_vehicle = float(per_class_max[j])
        event_vehicle_class = class_names[vehicle_idx[j]]
    event_top_idx = int(np.argmax(win_scores.mean(axis=0)))

    return {
        "top_class": class_names[top_idx],
        "top_class_confidence": round(float(mean_scores[top_idx]), 4),
        "vehicle_confidence_mean": round(mean_vehicle, 4),
        "vehicle_matched_class": mean_vehicle_class,
        "vehicle_confidence_event": round(event_vehicle, 4),
        "event_vehicle_class": event_vehicle_class,
        "event_top_class": class_names[event_top_idx],
        "event_window_used": used_window,
    }


def decide(result):
    if DECISION_METHOD == "event":
        score = result["vehicle_confidence_event"]
        threshold = EVENT_THRESHOLD
    else:
        score = result["vehicle_confidence_mean"]
        threshold = MEAN_THRESHOLD
    result["vehicle_confidence"] = score
    result["is_vehicle"] = score >= threshold
    return result


def classify_clip(model, class_names, vehicle_idx, wav_path, row):
    import soundfile as sf
    audio, sr = sf.read(wav_path, dtype="int16")
    if sr != 16000:
        raise ValueError(f"Expected 16kHz audio, got {sr}Hz for {wav_path}")
    if audio.ndim > 1:
        audio = audio[:, 0]
    waveform = audio.astype(np.float32) / 32768.0
    clip_length_seconds = len(waveform) / 16000.0

    scores, embeddings, spectrogram = model(waveform)
    window = event_window_seconds(row, clip_length_seconds)
    result = score_scores(scores.numpy(), class_names, vehicle_idx, window)
    return decide(result)


NEW_COLUMNS = [
    "top_class", "top_class_confidence",
    "vehicle_confidence", "vehicle_matched_class", "is_vehicle",
    "vehicle_confidence_mean", "vehicle_confidence_event",
    "event_vehicle_class", "event_top_class", "event_window_used",
]


def process_night(night_dir):
    import tensorflow_hub as hub
    date_str = os.path.basename(night_dir).replace("night_", "")
    peaks_path = os.path.join(night_dir, f"peaks_{date_str}.csv")
    clips_dir = os.path.join(night_dir, f"peak_audio_clips_{date_str}")

    if not os.path.exists(peaks_path):
        print(f"No events file found for {date_str}, skipping")
        return None

    print("Loading YAMNet model (first run downloads it, ~15MB)...")
    model = hub.load("https://tfhub.dev/google/yamnet/1")
    class_names = load_class_names(model)
    vehicle_idx = np.array([i for i, n in enumerate(class_names) if is_vehicle_class(n)], dtype=int)
    print(f"Counting {len(vehicle_idx)} classes as vehicle-related: "
          + ", ".join(class_names[i] for i in vehicle_idx))
    print(f"Decision method: {DECISION_METHOD}")

    out_path = peaks_path

    with open(peaks_path, newline="") as f_in:
        reader = csv.DictReader(f_in)
        rows = list(reader)
        fieldnames = list(reader.fieldnames)
    for col in NEW_COLUMNS:
        if col not in fieldnames:
            fieldnames.append(col)

    with open(out_path, "w", newline="") as f_out:
        writer = csv.DictWriter(f_out, fieldnames=fieldnames)
        writer.writeheader()

        for row in rows:
            # Rebuild the clip's local path from its filename rather than
            # trusting the absolute Pi path stored in the CSV, since that
            # path won't exist on this machine.
            clip_filename = os.path.basename(row.get("clip_file", ""))
            local_clip_path = os.path.join(clips_dir, clip_filename)

            if not clip_filename or not os.path.exists(local_clip_path):
                print(f"  Clip not found: {local_clip_path}, skipping")
                continue

            print(f"  Classifying {clip_filename}...")
            result = classify_clip(model, class_names, vehicle_idx, local_clip_path, row)
            row.update(result)
            writer.writerow(row)

    print(f"Saved classification results to {out_path}")
    return out_path


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python3 classify_clips.py <night_dir>")
        sys.exit(1)
    process_night(sys.argv[1])
