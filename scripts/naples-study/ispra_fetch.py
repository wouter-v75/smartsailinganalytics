#!/usr/bin/env python3
"""
Bay of Naples study: ISPRA RMN Napoli (the harbour tide gauge, anemometer declared at 10 m, 10-minute
averages, UTC) for May-July 2010-2023, CC-BY-4.0 -- a sea-level witness IN the bay, with both seasons
on record, for the May -> July factor (plan 5.4.3).

The monthly CSV URLs are asked of ISPRA's own SPARQL catalogue rather than guessed (the catalogue lists
napoli_wind_202310.csv and the repository does not serve it -- scripts/ispra-rmn-import.ts). L0 data:
real-time, unvalidated by ISPRA. The station is inside the port, sheltered N-E (WMO class 4/5), so it
enters as a RATIO only.

MOST RECENT YEAR FIRST.

  python ispra_fetch.py --write
"""
from __future__ import annotations

import argparse
import io
import json
import time
import urllib.parse
import urllib.request
from pathlib import Path

import pandas as pd

OUT = Path.home() / "Documents/Claude/Projects/Smart Sailing Analytics/naples-study-2027/raw/stations/ispra_napoli.csv.gz"
SPARQL = "https://dati.isprambiente.it/sparql"
UA = {"User-Agent": "ssa-study/1.0"}
MONTHS = ("05", "06", "07")
KN = 1.943844


def files():
    q = ('SELECT ?u WHERE { ?media <https://w3id.org/italia/env/onto/top/hasDownloadURL> ?u . '
         'FILTER(CONTAINS(STR(?u), "/rmn/napoli_wind_")) } LIMIT 1000')
    req = urllib.request.Request(f"{SPARQL}?{urllib.parse.urlencode({'query': q})}",
                                 headers={**UA, "accept": "application/sparql-results+json"})
    with urllib.request.urlopen(req, timeout=120) as r:
        us = [b["u"]["value"] for b in json.load(r)["results"]["bindings"]]
    return sorted((u for u in us if u[-6:-4] in MONTHS), reverse=True)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--write", action="store_true")
    a = ap.parse_args()
    us = files()
    print(f"{len(us)} monthly files, {us[-1].split('/')[-1]} .. {us[0].split('/')[-1]}")
    if not a.write:
        print("dry run; add --write")
        return
    parts = []
    for u in us:
        try:
            with urllib.request.urlopen(urllib.request.Request(u, headers=UA), timeout=120) as r:
                d = pd.read_csv(io.BytesIO(r.read()), sep=";", na_values=["NA", ""])
        except Exception as e:                     # one month the catalogue lists is not served
            print(f"  skip {u.split('/')[-1]}: {e}")
            continue
        d.columns = [c.strip().upper() for c in d.columns]
        parts.append(pd.DataFrame({"t_utc": pd.to_datetime(d.UTC), "kn": d.WS * KN, "dir": d.WD}))
        time.sleep(0.3)
    f = pd.concat(parts).dropna(subset=["kn"]).sort_values("t_utc")
    f = f[f.t_utc.dt.hour.between(8, 16)]
    f.to_csv(OUT, index=False, compression="gzip")
    print(f"wrote {OUT}: {len(f)} ten-minute rows, {f.t_utc.dt.year.nunique()} summers")


if __name__ == "__main__":
    main()
