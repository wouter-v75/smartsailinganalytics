#!/usr/bin/env python3
"""
Bay of Naples study: the stations' hourly wind from NOAA ISD (Integrated Surface Database), for the
May -> July transfer (plan 5.4.3) -- the one step the May-only masthead cannot measure for itself.

Read from the public AWS Open Data copy (noaa-global-hourly-pds, no key). One file per station-year;
only 10 May - 2 Aug and 08-16 UTC (10-18 local) are kept, wind speed in kn and direction, QC'd on
ISD's own quality codes, calms (code 9 direction with 0 speed) kept as 0 kn, 999 coded missing.

Stations (plan 3.3). Neither is lifted to 30 m; they enter only as RATIOS (July over May on sea-breeze
days), in which their shelter and height cancel to the extent the shelter does not change with season.
  LIQC  Capri, 269 m on the island        16294099999
  LIRN  Napoli Capodichino, inland 10 m   16289034113   (the ISD id carries a WBAN since 1998)
  LIQZ  Ponza, 185 m, open Tyrrhenian     16280099999   (upwind gradient reference)

MOST RECENT YEAR FIRST (Wouter, 25 Nov 2026), so a partial fetch is the most relevant years.

  python isd_fetch.py            # dry run
  python isd_fetch.py --write
"""
from __future__ import annotations

import argparse
import io
import time
import urllib.error
import urllib.request
from pathlib import Path

import pandas as pd

STUDY = Path.home() / "Documents/Claude/Projects/Smart Sailing Analytics/naples-study-2027"
OUT = STUDY / "raw" / "stations"
URL = "https://noaa-global-hourly-pds.s3.amazonaws.com/{y}/{sid}.csv"
STATIONS = {"capri": "16294099999", "capodichino": "16289034113", "ponza": "16280099999"}
YEARS = range(2025, 2005, -1)
KN = 1.943844


def parse(raw: bytes) -> pd.DataFrame:
    d = pd.read_csv(io.BytesIO(raw), usecols=["DATE", "REPORT_TYPE", "WND"], dtype=str)
    w = d.WND.str.split(",", expand=True)
    d["dir"] = pd.to_numeric(w[0], errors="coerce")
    d["dq"], d["type"], d["sq"] = w[1], w[2], w[4]
    d["ms"] = pd.to_numeric(w[3], errors="coerce") / 10
    ok = d.sq.isin(list("01459ACIMPRU")) & (d.ms < 99)
    d = d[ok].copy()
    d.loc[d.dir == 999, "dir"] = float("nan")          # variable or calm
    d["t"] = pd.to_datetime(d.DATE)
    d = d[d.t.dt.strftime("%m-%d").between("05-10", "08-02") & d.t.dt.hour.between(8, 16)]
    # METAR and SYNOP both arrive; keep one report per half hour, preferring FM-15 (METAR)
    d["slot"] = d.t.dt.floor("30min")
    d = d.sort_values("REPORT_TYPE").drop_duplicates("slot", keep="last")
    return pd.DataFrame({"t_utc": d.slot, "kn": (d.ms * KN).round(1), "dir": d.dir})


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--write", action="store_true")
    a = ap.parse_args()
    print(f"{len(STATIONS)} stations x {len(YEARS)} years -> {OUT}")
    if not a.write:
        print("dry run; add --write")
        return
    OUT.mkdir(parents=True, exist_ok=True)
    for name, sid in STATIONS.items():
        out = OUT / f"isd_{name}.csv.gz"
        parts = []
        for y in YEARS:
            try:
                with urllib.request.urlopen(URL.format(y=y, sid=sid), timeout=120) as r:
                    parts.append(parse(r.read()))
            except urllib.error.HTTPError as e:
                print(f"  {name} {y}: HTTP {e.code}")
            time.sleep(0.5)
        f = pd.concat(parts, ignore_index=True).sort_values("t_utc")
        f.to_csv(out, index=False, compression="gzip")
        print(f"done  {name}: {len(f)} half-hours, {f.t_utc.dt.year.nunique()} summers", flush=True)


if __name__ == "__main__":
    main()
