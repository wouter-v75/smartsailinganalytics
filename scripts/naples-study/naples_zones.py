#!/usr/bin/env python3
"""
Bay of Naples study: race-week wind per AREA, 10:00-18:00 local -- Sorrento, Mid-bay and
Posillipo / Naples harbour -- as hourly bars and wind roses.

Builds on naples_results.py (same regime odds, masthead, ERA5 correction, May -> July factor and
historical race weeks), with two additions:

  10:00 and 18:00  The ERA5 archive was fetched for 11-17 local only. A sea-breeze day's 10 and 18 come
                   from the same station shape as its other unsailed hours (Napoli port + Capodichino,
                   which record 10-18). Any other day's come from its 11:00 / 17:00 times CERRA's own
                   ratio between those hours at Sorrento, for that weather type (Open-Meteo CERRA,
                   2006-2021, every hour).
  areas            The simulation is the wind where Northstar 72 sailed -- the Sorrento box. Mid-bay
                   and Posillipo/Naples add CERRA's mean difference from Sorrento, per hour AND per
                   weather type, in speed and in direction (Open-Meteo CERRA at each area's sea cell,
                   30 May - 2 Aug 2006-2021, lifted to 32 m in ln z between 10 and 100 m). The speed
                   offsets agree with local knowledge (Naples +1-2 kn); the direction offsets have no
                   independent check.

  python naples_zones.py --fig-dir ../../docs/naples-figs
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import numpy as np
import pandas as pd

import sys
sys.path.insert(0, str(Path(__file__).resolve().parent))   # run with python -I, which drops the script dir
import naples_results as nr  # noqa: E402

HOURS = list(range(10, 19))
nr.HOURS = HOURS                     # every nr function reads the module global at call time
AREAS = {"sorrento": "Sorrento", "midbay": "Mid-bay", "posillipo": "Posillipo / Naples harbour"}
BINS = [(0, 6, "&lt; 6 kn"), (6, 10, "6-10"), (10, 14, "10-14"), (14, 18, "14-18"), (18, 99, "18 +")]
BIN_COL = ["#d6e4ee", "#9cc3dc", "#4f93c0", "#1f5f8f", "#0b2f4d"]
AREA_COL = {"sorrento": "#2c6e9e", "midbay": "#e07a2e", "posillipo": "#16a085"}


def cerra_areas(reg):
    a = math.log(nr.MAST_M / 10) / math.log(10)
    out = {}
    for z in AREAS:
        f = pd.read_csv(nr.RAW / f"omcerra/{z}.csv.gz", parse_dates=["valid_time"])
        lt = f.valid_time + pd.Timedelta(hours=2)
        f["day"], f["lh"] = lt.dt.normalize(), lt.dt.hour
        f = f[f.lh.isin(HOURS) & f.day.dt.strftime("%m-%d").between("05-30", "08-02")]
        f = f.join(reg[["broad"]], on="day")
        uv = lambda s, d: (-s * np.sin(np.radians(d)), -s * np.cos(np.radians(d)))
        u10, v10 = uv(f.wind_speed_10m, f.wind_direction_10m)
        u1, v1 = uv(f.wind_speed_100m, f.wind_direction_100m)
        f["kn"] = f.wind_speed_10m + (f.wind_speed_100m - f.wind_speed_10m) * a
        u, v = u10 + (u1 - u10) * a, v10 + (v1 - v10) * a
        f["dir"] = np.degrees(np.arctan2(-u, -v)) % 360
        out[z] = f.set_index(["day", "lh"])[["kn", "dir", "broad"]]
    ref = out["sorrento"]
    offs = {}
    for z in AREAS:
        j = out[z].join(ref[["kn", "dir"]], suffixes=("", "_s")).dropna()
        j["dk"] = j.kn - j.kn_s
        j["dd"] = (j.dir - j.dir_s + 180) % 360 - 180
        g = j.groupby(["broad", "lh"])
        offs[z] = pd.DataFrame({"dk": g.dk.mean(), "dd": g.dd.median()})
    shape = ref.groupby(["broad", "lh"]).kn.mean()
    return offs, shape


def era5_extended(e5, shape):
    """ERA5 has 11-17; add 10 and 18 per day from its nearest hour x CERRA's ratio for the day's type."""
    reg = nr.regimes()
    e = e5.join(reg[["broad"]], on="day")
    add = []
    for h, h0 in ((10, 11), (18, 17)):
        x = e[e.lh == h0].copy()
        x["kn"] = [k * shape.get((b, h), np.nan) / shape.get((b, h0), np.nan) for k, b in zip(x.kn, x.broad)]
        x["lh"] = h
        add.append(x)
    return pd.concat([e] + add, ignore_index=True).dropna(subset=["kn"]).drop(columns="broad")


def per_area(sim, offs):
    out = {}
    for z in AREAS:
        o = offs[z]
        k = pd.MultiIndex.from_arrays([sim.broad, sim.lh])
        dk = o.dk.reindex(k).fillna(0).values
        dd = o.dd.reindex(k).fillna(0).values
        out[z] = sim.assign(kn=np.maximum(sim.kn.values + dk, 0), dir=(sim.dir.values + dd) % 360)
    return out


def fig_bars(stats, path):
    W, H, L, R, T, B = 700, 340, 46, 16, 46, 40
    ymax = 20
    n = len(AREAS)
    gw = (W - L - R) / len(HOURS)
    bw = gw * 0.78 / n
    Y = lambda v: T + (H - T - B) * (1 - min(v, ymax) / ymax)
    s = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="100%" '
         f'style="font-family:Helvetica,Arial,sans-serif;font-size:11px">',
         f'<text x="{L}" y="16" font-weight="bold" font-size="12">Typical wind at 30 m by hour, race week 29 Jun - 3 Jul, three areas</text>']
    for i, (z, lab) in enumerate(AREAS.items()):
        s.append(f'<rect x="{L + i * 200}" y="26" width="10" height="10" fill="{AREA_COL[z]}"/>'
                 f'<text x="{L + i * 200 + 14}" y="35">{lab}</text>')
    for v in range(0, ymax + 1, 5):
        s.append(f'<line x1="{L}" x2="{W - R}" y1="{Y(v):.1f}" y2="{Y(v):.1f}" stroke="#e3e3e3"/>'
                 f'<text x="{L - 6}" y="{Y(v) + 4:.1f}" text-anchor="end" fill="#666">{v}</text>')
    s.append(f'<line x1="{L}" x2="{W - R}" y1="{Y(6):.1f}" y2="{Y(6):.1f}" stroke="#c0392b" stroke-dasharray="4 3"/>'
                 )
    for hi, h in enumerate(HOURS):
        x0 = L + hi * gw + gw * 0.11
        for zi, z in enumerate(AREAS):
            q = stats[z].loc[h]
            x = x0 + zi * bw
            s.append(f'<rect x="{x:.1f}" y="{Y(q[.5]):.1f}" width="{bw - 1.5:.1f}" height="{Y(0) - Y(q[.5]):.1f}" fill="{AREA_COL[z]}"/>')
            cx = x + (bw - 1.5) / 2
            s.append(f'<line x1="{cx:.1f}" x2="{cx:.1f}" y1="{Y(q[.25]):.1f}" y2="{Y(q[.75]):.1f}" stroke="#222" stroke-width="1.2"/>'
                     f'<line x1="{cx - 3:.1f}" x2="{cx + 3:.1f}" y1="{Y(q[.75]):.1f}" y2="{Y(q[.75]):.1f}" stroke="#222"/>'
                     f'<line x1="{cx - 3:.1f}" x2="{cx + 3:.1f}" y1="{Y(q[.25]):.1f}" y2="{Y(q[.25]):.1f}" stroke="#222"/>'
                     f'<circle cx="{cx:.1f}" cy="{Y(q[.9]):.1f}" r="2.2" fill="none" stroke="#222"/>')
            s.append(f'<text x="{cx:.1f}" y="{Y(0) - 4:.1f}" text-anchor="middle" fill="#fff" font-size="8.5">{q[.5]:.0f}</text>')
        s.append(f'<text x="{L + hi * gw + gw / 2:.1f}" y="{H - B + 16}" text-anchor="middle" fill="#444">{h:02d}:00</text>')
    s.append(f'<text x="14" y="{T + (H - T - B) / 2}" transform="rotate(-90 14 {T + (H - T - B) / 2})" text-anchor="middle" fill="#444">kn at 30 m</text>')
    s.append(f'<text x="{W - R}" y="{H - 4}" text-anchor="end" fill="#777" font-size="10">bar: median (P50) · whisker: P25-P75 · circle: P90 · red dashes: 6 kn lower limit · local time (CEST)</text>')
    s.append("</svg>")
    path.write_text("\n".join(s))


def fig_roses(rose, path):
    W, H = 780, 330
    rmax = max(float(t.sum(axis=1).max()) for t in rose.values())
    rmax = math.ceil(rmax / 5) * 5
    R0 = 100
    s = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="100%" '
         f'style="font-family:Helvetica,Arial,sans-serif;font-size:11px">',
         f'<text x="10" y="16" font-weight="bold" font-size="12">Wind roses, race week 10:00-18:00: % of hours from each direction, by strength (kn at 30 m)</text>']
    for i, (z, lab) in enumerate(AREAS.items()):
        cx, cy = 135 + i * 255, 160
        s.append(f'<text x="{cx}" y="{cy - R0 - 14}" text-anchor="middle" font-weight="bold">{lab}</text>')
        for ring in range(5, rmax + 1, 5):
            r = R0 * ring / rmax
            s.append(f'<circle cx="{cx}" cy="{cy}" r="{r:.1f}" fill="none" stroke="#ddd"/>')
            s.append(f'<text x="{cx + r * 0.71 + 2:.1f}" y="{cy + r * 0.71 + 8:.1f}" fill="#999" font-size="8">{ring}%</text>')
        for lab2, ang in (("N", 0), ("E", 90), ("S", 180), ("W", 270)):
            a = math.radians(ang)
            s.append(f'<text x="{cx + (R0 + 10) * math.sin(a):.1f}" y="{cy - (R0 + 10) * math.cos(a) + 4:.1f}" text-anchor="middle" fill="#555" font-size="10">{lab2}</text>')
        t = rose[z]
        for k, sec in enumerate(t.index):
            a0, a1 = math.radians(sec - 9), math.radians(sec + 9)
            r_in = 0.0
            for b, col in zip(t.columns, BIN_COL):
                v = float(t.loc[sec, b])
                if v <= 0:
                    continue
                r_out = r_in + R0 * v / rmax
                p = [(cx + r_in * math.sin(a0), cy - r_in * math.cos(a0)), (cx + r_out * math.sin(a0), cy - r_out * math.cos(a0)),
                     (cx + r_out * math.sin(a1), cy - r_out * math.cos(a1)), (cx + r_in * math.sin(a1), cy - r_in * math.cos(a1))]
                s.append('<polygon points="' + " ".join(f"{x:.1f},{y:.1f}" for x, y in p) + f'" fill="{col}" stroke="#fff" stroke-width=".4"/>')
                r_in = r_out
    for j, ((_, _, lab), col) in enumerate(zip(BINS, BIN_COL)):
        s.append(f'<rect x="{200 + j * 70}" y="{H - 22}" width="12" height="12" fill="{col}"/>'
                 f'<text x="{216 + j * 70}" y="{H - 12}">{lab}</text>')
    s.append("</svg>")
    path.write_text("\n".join(s))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--fig-dir", type=Path)
    ap.add_argument("--boot", type=int, default=200)
    a = ap.parse_args()
    reg = nr.regimes()
    n72 = nr.n72_hourly(reg)
    st = nr.stations(reg)
    F = tuple(sorted(v["ratio"] for v in st.values() if v["used"]))
    F = (F[0], F[-1])
    shape = {h: float(np.mean([st[k]["shape"][h] for k in nr.SHAPE_FROM])) for h in HOURS}
    prof = nr.sb_profiles(n72, shape)
    offs, cshape = cerra_areas(reg)
    e5 = era5_extended(nr.era5_point(), cshape)
    b = nr.era5_bias(reg)
    sim = nr.simulate(reg, prof, e5, b["bias"], F)
    areas = per_area(sim, offs)

    print(f"station shape 10-18: { {h: round(v, 2) for h, v in shape.items()} }")
    print(f"{sim.week.nunique()} race weeks, F {F[0]:.2f}-{F[1]:.2f}")
    stats, rose, res = {}, {}, {}
    for z, d in areas.items():
        q = d.groupby("lh").kn.quantile([.1, .25, .5, .75, .9]).unstack()
        q["in_limits"] = d.groupby("lh").kn.apply(lambda x: x.between(*nr.LIMITS).mean())
        stats[z] = q
        sec = ((d.dir + 11.25) // 22.5 % 16 * 22.5).values
        binl = np.select([d.kn.between(lo, hi, inclusive="left") for lo, hi, _ in BINS], [l for *_, l in BINS], default="")
        t = pd.crosstab(sec, binl, normalize=True) * 100
        rose[z] = t.reindex(index=[i * 22.5 for i in range(16)], columns=[l for *_, l in BINS], fill_value=0)
        print(f"\n{AREAS[z]}\n", q.round(1))
        print("  rose, % of hours by sector (top 6):", rose[z].sum(axis=1).sort_values(ascending=False).head(6).round(1).to_dict())
        res[z] = {"hourly": q.round(2).to_dict(), "rose": rose[z].round(2).to_dict()}
    print("\nCERRA offsets from Sorrento (kn, deg) by weather type and hour:")
    for z in ("midbay", "posillipo"):
        print(z, "\n", offs[z].unstack(0).round(1))
    out = nr.STUDY / "results"
    (out / "areas_10_18.json").write_text(json.dumps(res, indent=1, default=str))
    for z in AREAS:
        stats[z].to_csv(out / f"area_{z}_hourly_10_18.csv")
        rose[z].to_csv(out / f"area_{z}_rose_10_18.csv")
    # Section 2 of the report for Posillipo / Naples harbour: the racing hours 11-17, all statistics
    race = [h for h in HOURS if 11 <= h <= 17]
    nap = areas["posillipo"][areas["posillipo"].lh.isin(race)]
    nr.HOURS = race
    s2 = nr.summarise(nap)
    by_reg = {r: nr.summarise(g)["hourly"] for r, g in nap.groupby("broad")}
    print("\nNAPLES, section 2, all days:\n", s2["hourly"].round(2))
    for r, h in by_reg.items():
        print(f"  {r}:", {k: f"{h.loc[k, .5]:.1f} ({h.loc[k, .1]:.1f}-{h.loc[k, .9]:.1f})" for k in race})
    years = sorted(reg.index.year.unique())
    keep = {14: [], 15: []}
    for _ in range(a.boot):
        ys = list(nr.rng.choice(years, len(years)))
        ds = [sorted(prof)[i] for i in nr.rng.integers(len(prof), size=len(prof))]
        nr.HOURS = HOURS
        x = per_area(nr.simulate(reg, prof, e5, b["bias"], F, ys, ds), offs)["posillipo"]
        for h in keep:
            keep[h].append(float(x[x.lh == h].kn.median()))
    ci = {h: (round(float(np.quantile(v, .05)), 1), round(float(np.quantile(v, .95)), 1)) for h, v in keep.items()}
    print("  90 % interval of the median:", ci)
    s2["hourly"].to_csv(out / "naples_section2_hourly.csv")
    (out / "naples_section2.json").write_text(json.dumps(
        {"hourly": s2["hourly"].round(3).to_dict(), "ci_p50": ci,
         "by_regime": {r: h.round(2).to_dict() for r, h in by_reg.items()}}, indent=1, default=str))
    if a.fig_dir:
        nr.HOURS = race
        nr.fig_fan(s2["hourly"], a.fig_dir / "fan_all_naples.svg",
                   "Race week 29 Jun - 3 Jul: wind at 30 m, Posillipo / Naples harbour, all days")
        nr.fig_fan(by_reg["sea breeze"], a.fig_dir / "fan_seabreeze_naples.svg", "Naples: sea-breeze days only (~70 % of race-week days)")
        nr.fig_fan(by_reg["gradient"], a.fig_dir / "fan_gradient_naples.svg", "Naples: gradient days only (~23 %)")
        nr.HOURS = HOURS
    if a.fig_dir:
        fig_bars(stats, a.fig_dir / "areas_hourly_bars.svg")
        fig_roses(rose, a.fig_dir / "areas_roses.svg")
        print(f"figures -> {a.fig_dir}")


if __name__ == "__main__":
    main()
