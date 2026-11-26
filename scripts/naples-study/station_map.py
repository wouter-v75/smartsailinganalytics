#!/usr/bin/env python3
"""
Bay of Naples study: a map of what the study measures with -- stations, the Northstar 72 masthead
bins, and the reanalysis sea cells per zone -- as a self-contained SVG (no plotting library needed;
md2pdf embeds an ```html block raw, so the report carries it inline).

Coastline: OpenStreetMap natural=coastline ways for the bay (raw/coast/osm_coastline.json, fetched
once from Overpass; (c) OpenStreetMap contributors, ODbL).

  python station_map.py --out docs/naples-station-map.svg
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import pandas as pd

HOME = Path.home() / "Documents/Claude/Projects/Smart Sailing Analytics"
RAW = HOME / "naples-study-2027/raw"
OBS = HOME / "wind-verification/obs_sorrento.csv"

LON0, LON1, LAT0, LAT1 = 13.86, 14.56, 40.50, 40.93
W = 760
K = W / ((LON1 - LON0) * math.cos(math.radians(40.7)))
H = round((LAT1 - LAT0) * K)

# name, lat, lon, height, role, label offset (dx, dy)
STATIONS = [
    ("Capri LIQC", 40.55, 14.25, "269 m · NOT USED: often in the island's lee", "", (-12, 20), "#9a9a9a"),
    ("Capodichino LIRN", 40.886, 14.291, "10 m, inland", "", (10, -8), "#c0392b"),
    ("Capo Posillipo", 40.8015, 14.186, "Davis, 108 m headland", "", (-14, -12), "#c0392b"),
    ("Napoli port (ISPRA)", 40.8406, 14.2689, "10 m, tide gauge", "", (12, -18), "#c0392b"),
]
# Private Davis stations SSA polls live (src/lib/windObsDavisMap.ts): no history before SSA's archive
PWS = [("In-marelab", 40.83357, 14.26801), ("PROCIDAMETEO", 40.75847, 14.00983),
       ("Volla", 40.88501, 14.35091), ("Pompei Oss.", 40.74737, 14.50132)]
ZONES = ["course", "sorrento", "bottom", "midbay", "posillipo"]


def xy(lat, lon):
    return (lon - LON0) * math.cos(math.radians(40.7)) * K, (LAT1 - lat) * K


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, required=True)
    a = ap.parse_args()
    osm = json.loads((RAW / "coast/osm_coastline.json").read_text())
    paths = []
    for el in osm["elements"]:
        pts = [xy(p["lat"], p["lon"]) for p in el.get("geometry", [])]
        if len(pts) < 2:
            continue
        paths.append("M" + " L".join(f"{x:.1f},{y:.1f}" for x, y in pts))
    o = pd.read_csv(OBS)
    o = o[o.lat.between(40.3, 41.0) & o.lon.between(13.7, 14.7)]
    s = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="100%" '
         f'style="font-family:Helvetica,Arial,sans-serif;font-size:12px">',
         f'<defs><clipPath id="frame"><rect width="{W}" height="{H}"/></clipPath></defs>',
         f'<rect width="{W}" height="{H}" fill="#e8f1f8"/>',
         f'<g clip-path="url(#frame)"><path d="{" ".join(paths)}" fill="none" stroke="#5a6b78" stroke-width="1.1"/></g>']
    # the plan's three course boxes
    for name, la0, la1, lo0, lo1 in [("Sorrento box", 40.60, 40.70, 14.30, 14.45),
                                      ("mid-bay", 40.70, 40.78, 14.18, 14.32),
                                      ("Posillipo/Naples", 40.78, 40.83, 14.18, 14.28)]:
        x0, y0 = xy(la1, lo0)
        x1, y1 = xy(la0, lo1)
        s.append(f'<rect x="{x0:.1f}" y="{y0:.1f}" width="{x1 - x0:.1f}" height="{y1 - y0:.1f}" '
                 f'fill="none" stroke="#8aa4b8" stroke-dasharray="4 3"/>')
        s.append(f'<text x="{x0 + 3:.1f}" y="{y1 - 4:.1f}" fill="#6a8498" font-size="10">{name}</text>')
    for la, lo in zip(o.lat, o.lon):
        x, y = xy(la, lo)
        s.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="1.6" fill="#e07a2e" opacity=".55"/>')
    for z in ZONES:
        f = pd.read_csv(RAW / f"omcerra/{z}.csv.gz", nrows=1)
        x, y = xy(f.cell_lat[0], f.cell_lon[0])
        s.append(f'<rect x="{x - 4:.1f}" y="{y - 4:.1f}" width="8" height="8" fill="none" stroke="#2c6e9e" stroke-width="1.6"/>')
        s.append(f'<text x="{x + 7:.1f}" y="{y + 4:.1f}" fill="#2c6e9e" font-size="10">{z}</text>')
    for name, la, lo in PWS:
        x, y = xy(la, lo)
        s.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="5" fill="#fff" stroke="#8e44ad" stroke-width="2"/>')
        end = x > W - 90
        s.append(f'<text x="{x + (-8 if end else 8):.1f}" y="{y + 14:.1f}" text-anchor="{"end" if end else "start"}" fill="#8e44ad" font-size="10">{name}</text>')
    for name, la, lo, h, role, (dx, dy), col in STATIONS:
        x, y = xy(la, lo)
        anchor = "end" if dx < 0 else "start"
        s.append(f'<path d="M{x:.1f},{y - 7:.1f} L{x + 6:.1f},{y + 4:.1f} L{x - 6:.1f},{y + 4:.1f} Z" fill="{col}"/>')
        s.append(f'<text x="{x + dx:.1f}" y="{y + dy:.1f}" text-anchor="{anchor}" font-weight="bold" fill="#222">{name}</text>')
        s.append(f'<text x="{x + dx:.1f}" y="{y + dy + 13:.1f}" text-anchor="{anchor}" fill="#555" font-size="10">{h}</text>')
    # Ponza is 100 km off the map to the west
    s.append(f'<path d="M30,{H * .12:.0f} L12,{H * .12:.0f} M18,{H * .12 - 5:.0f} L12,{H * .12:.0f} L18,{H * .12 + 5:.0f}" stroke="#c0392b" stroke-width="2" fill="none"/>')
    s.append(f'<text x="34" y="{H * .12 + 4:.0f}" font-weight="bold">Ponza LIQZ</text>')
    s.append(f'<text x="34" y="{H * .12 + 17:.0f}" fill="#555" font-size="10">185 m, ~100 km W — upwind gradient reference</text>')
    # legend
    ly = H - 98
    s += [f'<rect x="{W - 262}" y="{ly - 16}" width="256" height="96" fill="#fff" opacity=".9" stroke="#bbb"/>',
          f'<path d="M{W - 236},{ly - 3} L{W - 230},{ly + 7} L{W - 242},{ly + 7} Z" fill="#c0392b"/>',
          f'<text x="{W - 222}" y="{ly + 6}">station (NOAA ISD / PANGAEA)</text>',
          f'<circle cx="{W - 236}" cy="{ly + 22}" r="3" fill="#e07a2e"/>',
          f'<text x="{W - 222}" y="{ly + 26}">N72 masthead, 10-min bins, May 2024-26</text>',
          f'<rect x="{W - 240}" y="{ly + 38}" width="8" height="8" fill="none" stroke="#2c6e9e" stroke-width="1.6"/>',
          f'<text x="{W - 222}" y="{ly + 46}">CERRA sea cell per zone</text>',
          f'<circle cx="{W - 236}" cy="{ly + 60}" r="4" fill="#fff" stroke="#8e44ad" stroke-width="2"/>',
          f'<text x="{W - 222}" y="{ly + 64}">private station, live in SSA, no history</text>',
          f'<text x="6" y="{H - 6}" fill="#777" font-size="9">Coastline © OpenStreetMap contributors (ODbL). '
          f'Capri at the ISD position (rounded to 0.05°); Napoli port approximate.</text>',
          "</svg>"]
    a.out.write_text("\n".join(s))
    print(f"wrote {a.out} ({len(paths)} coastline ways, {len(o)} N72 bins)")


if __name__ == "__main__":
    main()
