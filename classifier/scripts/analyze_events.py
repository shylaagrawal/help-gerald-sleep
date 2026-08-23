"""
analyze_events.py -- Steps 5-7 of the pipeline.

Reads classified_DATE.csv (vehicle-confirmed events) and csv_DATE.csv
(per-second dB(A) log), and for each confirmed vehicle event:
  - Step 5: isolates the vehicle's true contribution by subtracting the
    flanking background noise, done correctly in LINEAR power (not dB,
    since dB is logarithmic -- same principle as astronomical photometry
    background subtraction).
  - Step 6: computes a power-weighted temporal centroid for sub-second
    timing precision, instead of just using the single loudest instant.
  - Step 7: writes final results_DATE.csv with one row per confirmed
    vehicle event: centroid timestamp, isolated dB(A), classifier
    confidence, and a WHO 45 dB(A) threshold flag.

Usage: python3 analyze_events.py <night_date>
Expects to be run from a directory containing classifier/results/night_DATE/
"""

import sys
import os
import csv
import math
import datetime

WHO_EVENT_THRESHOLD_DB = 45.0
RESULTS_BASE = "classifier/results"


def db_to_power(db):
    return 10 ** (db / 10.0)


def power_to_db(power):
    if power <= 0:
        return None
    return 10 * math.log10(power)


def load_night_csv(path):
    rows = []
    with open(path, newline="") as f:
        reader = csv.DictReader(f)
        for r in reader:
            ts = datetime.datetime.fromisoformat(r["timestamp"])
            db = float(r["calibrated_db_a"])
            rows.append((ts, db))
    rows.sort(key=lambda x: x[0])
    return rows


def values_in_range(rows, start, end):
    return [db for ts, db in rows if start <= ts <= end]


def background_subtract(rows, clip_window_start, event_start, event_end, clip_window_end):
    before_end = event_start - datetime.timedelta(seconds=1)
    after_start = event_end + datetime.timedelta(seconds=1)

    bg_vals = values_in_range(rows, clip_window_start, before_end) + \
              values_in_range(rows, after_start, clip_window_end)
    event_vals = values_in_range(rows, event_start, event_end)

    if not bg_vals or not event_vals:
        return None, "missing_data"

    bg_power = sum(db_to_power(v) for v in bg_vals) / len(bg_vals)
    event_power = sum(db_to_power(v) for v in event_vals) / len(event_vals)
    isolated_power = event_power - bg_power

    if isolated_power <= 0:
        return None, "event_not_above_background"

    return round(power_to_db(isolated_power), 2), "ok"


def compute_centroid(rows, event_start, event_end):
    vals = [(ts, db) for ts, db in rows if event_start <= ts <= event_end]
    if not vals:
        return event_start
    powers = [db_to_power(db) for _, db in vals]
    total_power = sum(powers)
    if total_power <= 0:
        return event_start
    weighted_offset = sum(
        (ts - event_start).total_seconds() * p for (ts, _), p in zip(vals, powers)
    ) / total_power
    return event_start + datetime.timedelta(seconds=weighted_offset)


def process_night(date_str):
    night_dir = os.path.join(RESULTS_BASE, f"night_{date_str}")
    peaks_path = os.path.join(night_dir, f"peaks_{date_str}.csv")
    raw_data_path = os.path.join(night_dir, f"raw_data_{date_str}.csv")
    out_path = os.path.join(night_dir, f"final_isolated_results_{date_str}.csv")

    if not os.path.exists(peaks_path) or not os.path.exists(raw_data_path):
        print(f"Missing input files for {date_str}, skipping")
        return

    night_rows = load_night_csv(raw_data_path)

    with open(peaks_path, newline="") as f:
        events = list(csv.DictReader(f))

    output_rows = []
    for e in events:
        if e.get("is_vehicle") != "True":
            continue

        event_start = datetime.datetime.fromisoformat(e["start"])
        event_end = datetime.datetime.fromisoformat(e["end"])
        clip_start = datetime.datetime.fromisoformat(e["clip_window_start"])
        clip_end = datetime.datetime.fromisoformat(e["clip_window_end"])

        isolated_db, note = background_subtract(night_rows, clip_start, event_start, event_end, clip_end)
        centroid_ts = compute_centroid(night_rows, event_start, event_end)

        fallback_used = isolated_db is None
        reported_db = isolated_db if isolated_db is not None else float(e["peak_db"])

        output_rows.append({
            "event_id": e["event_id"],
            "centroid_timestamp": centroid_ts.isoformat(timespec="milliseconds"),
            "isolated_db_a": reported_db,
            "isolation_note": note,
            "used_raw_peak_fallback": fallback_used,
            "vehicle_confidence": e["vehicle_confidence"],
            "top_class": e["top_class"],
            "exceeds_who_45db_threshold": reported_db > WHO_EVENT_THRESHOLD_DB,
            "raw_peak_db": e["peak_db"],
            "raw_baseline_db": e["baseline_db"],
        })

    with open(out_path, "w", newline="") as f:
        fieldnames = list(output_rows[0].keys()) if output_rows else [
            "event_id", "centroid_timestamp", "isolated_db_a", "isolation_note",
            "used_raw_peak_fallback", "vehicle_confidence", "top_class",
            "exceeds_who_45db_threshold", "raw_peak_db", "raw_baseline_db",
        ]
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(output_rows)

    print(f"Wrote {len(output_rows)} final events to {out_path}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python3 analyze_events.py <night_date>")
        sys.exit(1)
    process_night(sys.argv[1])