#!/usr/bin/env python3
"""
Bay of Naples study: Open-Meteo's copy of CERRA, 10 and 100 m, hourly, for one sea point per zone.

The CHECK on the capped CERRA (Wouter, 25 Nov 2026). The CDS holds CERRA's 30 m level but serves it
off tape, at ~17 h a summer without starting, so the CDS copy is capped at the 2024-26 pilot plus
2006-08 (cds_fetch.CERRA_YEARS). Open-Meteo serves the same reanalysis from disk, at 10 and 100 m only,
and only to 30 Jun 2021: so 2006-2020 whole and 2021 to the end of June. It gives the gradient-day
statistics and the zone-to-zone ratios fifteen more summers to be checked against, NOT a 30 m series:
30 m comes from interpolating 10 -> 100 m with the shear CERRA's own 15/30/50 m levels show in the
pilot years, and that step is stated wherever the numbers are used.

Where it overlaps the CDS copy (2006-08, once those land), the two are compared before anything here
is used; a mismatch there means this copy is not the same product, and it is dropped.

Writes <study>/raw/omcerra/<zone>.csv.gz: valid_time (UTC), the grid cell Open-Meteo picked, and
speed (kn) and direction at 10 and 100 m. cell_selection=sea, the lesson from the MOS work: the default
`land` takes an inland cell for a coastal point.

  python openmeteo_cerra.py           # dry run: the points and the calls it would make
  python openmeteo_cerra.py --write
"""
from __future__ import annotations

import argparse
import gzip
import io
import json
import time
import urllib.parse
import urllib.request
from pathlib import Path

import pandas as pd

STUDY = Path.home() / "Documents/Claude/Projects/Smart Sailing Analytics/naples-study-2027"
OUT = STUDY / "raw" / "omcerra"
URL = "https://archive-api.open-meteo.com/v1/archive"
YEARS = range(2006, 2022)
LAST_DAY = "2021-06-30"                       # Open-Meteo's CERRA ends here
SPAN = ("05-10", "08-02")                     # the same days as cds_fetch.DAYS

# One point per zone of the plan's section 4, at each box's centre; Open-Meteo moves it to the nearest
# sea cell and the cell it chose is stored on every row.
ZONES = {
    "course": (40.62, 14.32),                 # off Sorrento, where N72 raced (classify_regimes.COURSE)
    "sorrento": (40.65, 14.375),              # box 40.60-40.70 N, 14.30-14.45 E
    "bottom": (40.72, 14.43),                 # Castellammare - Torre Annunziata (site knowledge S3)
    "midbay": (40.74, 14.25),                 # box 40.70-40.78 N, 14.18-14.32 E
    "posillipo": (40.805, 14.23),             # box 40.78-40.83 N, 14.18-14.28 E
}
HOURLY = ["wind_speed_10m", "wind_direction_10m", "wind_speed_100m", "wind_direction_100m"]


def fetch(lat: float, lon: float, start: str, end: str) -> pd.DataFrame:
    q = urllib.parse.urlencode({
        "latitude": lat, "longitude": lon, "start_date": start, "end_date": end,
        "hourly": ",".join(HOURLY), "models": "cerra", "wind_speed_unit": "kn",
        "timezone": "GMT", "cell_selection": "sea"})
    for attempt in range(5):
        try:
            with urllib.request.urlopen(f"{URL}?{q}", timeout=60) as r:
                d = json.load(r)
            break
        except urllib.error.HTTPError as e:   # 429: the per-minute limit; back off and retry
            if e.code != 429 or attempt == 4:
                raise
            time.sleep(30 * (attempt + 1))
    f = pd.DataFrame(d["hourly"]).rename(columns={"time": "valid_time"})
    f["cell_lat"], f["cell_lon"] = d["latitude"], d["longitude"]
    return f.dropna(subset=["wind_speed_10m"])


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--write", action="store_true")
    a = ap.parse_args()
    calls = [(z, y) for z in ZONES for y in YEARS]
    print(f"{len(ZONES)} zones x {len(YEARS)} summers = {len(calls)} calls -> {OUT}")
    if not a.write:
        for z, (lat, lon) in ZONES.items():
            print(f"  {z:10s} {lat:.3f} {lon:.3f}")
        print("dry run; add --write")
        return
    OUT.mkdir(parents=True, exist_ok=True)
    for z, (lat, lon) in ZONES.items():
        out = OUT / f"{z}.csv.gz"
        if out.exists():
            print(f"skip  {z} (exists)")
            continue
        parts = []
        for y in YEARS:
            end = min(f"{y}-{SPAN[1]}", LAST_DAY)
            parts.append(fetch(lat, lon, f"{y}-{SPAN[0]}", end))
            time.sleep(1)
        f = pd.concat(parts, ignore_index=True)
        buf = io.BytesIO()
        f.to_csv(buf, index=False)
        out.write_bytes(gzip.compress(buf.getvalue()))
        print(f"done  {z}: cell {f.cell_lat.iloc[0]:.3f} {f.cell_lon.iloc[0]:.3f}, {len(f)} hours, "
              f"{f.valid_time.str[:4].nunique()} summers", flush=True)


if __name__ == "__main__":
    main()
