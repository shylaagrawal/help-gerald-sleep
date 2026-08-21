"""
classify_clips.py

Runs YAMNet (a pretrained audio classification model from Google's AudioSet)
on every clip listed in a night's events_DATE.csv, and writes out a new
classified_DATE.csv with vehicle-confidence scores added.

This does NOT run on the Pi -- YAMNet needs TensorFlow, which the Pi Zero W
cannot run. This is meant to run in GitHub Actions (see run_pipeline.py and
the workflow file).
"""

import os
import sys
import csv
import numpy as np
import tensorflow as tf
import tensorflow_hub as hub
import soundfile as sf

# Keywords used to identify "vehicle-related" classes in YAMNet's ~521
# AudioSet classes. Matched case-insensitively as substrings.
VEHICLE_KEYWORDS = [
    "car", "truck", "bus", "vehicle", "motorcycle", "traffic",
    "engine", "accelerating", "revving", "vroom", "skidding",
    "tire squeal", "race car", "auto racing",
]

# How confident the model needs to be in a vehicle-related class before we
# count the clip as a confirmed vehicle. Start conservative; tune this
# after looking at real results -- if too many real cars are being marked
# false, lower it; if too many non-vehicle sounds are slipping through,
# raise it.
VEHICLE_CONFIDENCE_THRESHOLD = 0.05


def load_class_names(model):
    class_map_path = model.class_map_path().numpy().decode("utf-8")
    class_names = []
    with tf.io.gfile.GFile(class_map_path) as f:
        reader = csv.DictReader(f)
        for row in reader:
            class_names.append(row["display_name"])
    return class_names


def is_vehicle_class(name):
    name_lower = name.lower()
    return any(kw in name_lower for kw in VEHICLE_KEYWORDS)


def classify_clip(model, class_names, wav_path):
    audio, sr = sf.read(wav_path, dtype="int16")
    if sr != 16000:
        raise ValueError(f"Expected 16kHz audio, got {sr}Hz for {wav_path}")
    if audio.ndim > 1:
        audio = audio[:, 0]
    waveform = audio.astype(np.float32) / 32768.0

    scores, embeddings, spectrogram = model(waveform)
    scores_np = scores.numpy()
    mean_scores = scores_np.mean(axis=0)

    top_idx = int(np.argmax(mean_scores))
    top_class = class_names[top_idx]
    top_score = float(mean_scores[top_idx])

    vehicle_score = 0.0
    vehicle_class = None
    for i, name in enumerate(class_names):
        if is_vehicle_class(name) and mean_scores[i] > vehicle_score:
            vehicle_score = float(mean_scores[i])
            vehicle_class = name

    return {
        "top_class": top_class,
        "top_class_confidence": round(top_score, 4),
        "vehicle_confidence": round(vehicle_score, 4),
        "vehicle_matched_class": vehicle_class or "",
        "is_vehicle": vehicle_score >= VEHICLE_CONFIDENCE_THRESHOLD,
    }


def process_night(night_dir):
    date_str = os.path.basename(night_dir).replace("night_", "")
    events_path = os.path.join(night_dir, f"events_{date_str}.csv")
    clips_dir = os.path.join(night_dir, f"peak_audio_clips_{date_str}")

    if not os.path.exists(events_path):
        print(f"No events file found for {date_str}, skipping")
        return None

    print("Loading YAMNet model (first run downloads it, ~15MB)...")
    model = hub.load("https://tfhub.dev/google/yamnet/1")
    class_names = load_class_names(model)

    out_path = os.path.join(night_dir, f"classified_{date_str}.csv")

    with open(events_path, newline="") as f_in:
        reader = csv.DictReader(f_in)
        rows = list(reader)
        fieldnames = reader.fieldnames + [
            "top_class", "top_class_confidence",
            "vehicle_confidence", "vehicle_matched_class", "is_vehicle",
        ]

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
            result = classify_clip(model, class_names, local_clip_path)
            row.update(result)
            writer.writerow(row)

    print(f"Saved classification results to {out_path}")
    return out_path


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python3 classify_clips.py <night_dir>")
        sys.exit(1)
    process_night(sys.argv[1])