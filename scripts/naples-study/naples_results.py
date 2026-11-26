#!/usr/bin/env python3
"""
Bay of Naples study, step 5.4-5.6: the 30 m wind for race week, 29 Jun - 3 Jul, 11-17 local.

Read-only; writes <study>/results/*.csv|json and the report's SVG figures (--fig-dir).

How each piece is built (plan 5.4, as revised after the 5.2 gate):
  regime odds      classify_regimes.py's labels, ERA5, 21 summers 2006-2026.
  sea-breeze days  Northstar 72's masthead (32 m), the 11 May days ERA5 labels sea breeze, per local
                   hour -- no reanalysis has hour-to-hour skill on these days (r ~ 0.1), so the
                   masthead IS the wind -- times a May -> July factor F measured at the stations.
  other days       ERA5 at the course, lifted 10 -> 100 m to 32 m in ln z (as validate_n72.py), plus
                   the bias measured against the masthead on the N72 gradient days. Each simulated
                   gradient day is a REAL historical day, so its hours keep their own shape.
  F                July (15 Jun - 20 Jul) over May (10-31 May) afternoon wind on ERA5 sea-breeze days
                   at Capri, Capodichino and Capo Posillipo. Ratios only: each station's shelter
                   cancels to the extent it does not change with season, which is why Capri, often in
                   the island's lee, can still vote. Drawn uniform over the stations' range.
  race weeks       every historical summer's five-day sequence of regimes, for the real week and for
                   the week shifted -15..+15 days in 3-day steps (persistence kept, not independent
                   days). A sea-breeze day draws one whole N72 sea-breeze day (same sub-type if the
                   boat sailed one), so the hours of a day stay together.
  uncertainty      90 % intervals from a bootstrap that resamples SUMMERS and N72 DAYS together.

  python naples_results.py --fig-dir ../../docs/naples-figs
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd

HOME = Path.home() / "Documents/Claude/Projects/Smart Sailing Analytics"
STUDY = HOME / "naples-study-2027"
RAW = STUDY / "raw"
OBS = HOME / "wind-verification/obs_sorrento.csv"
KN = 1.943844
MAST_M = 32.0
POINT = (40.65, 14.37)            # the mean N72 position: where the ERA5 bias was measured
HOURS = list(range(11, 18))       # local, start of the hour
LIMITS = (6.0, 25.0)
MIN_HOURS = 3                     # a race-able day: >= 3 hours inside the limits
WEEK = ("06-29", "07-03")
SHIFTS = range(-15, 16, 3)
SECTORS = [("N-NE", 340, 80), ("E-SE", 80, 170), ("S-SW", 170, 235), ("SW-W", 235, 290), ("NW", 290, 340)]
rng = np.random.default_rng(7)


def between(d, lo, hi):
    d = np.asarray(d) % 360
    return (d >= lo) & (d < hi) if lo < hi else (d >= lo) | (d < hi)


def sector(d):
    out = np.full(len(d), "", dtype=object)
    for n, lo, hi in SECTORS:
        out[between(d, lo, hi)] = n
    return out


def circ_mean(deg, w=None):
    r = np.radians(np.asarray(deg, float))
    w = np.ones_like(r) if w is None else np.asarray(w, float)
    return float(np.degrees(np.arctan2((w * np.sin(r)).sum(), (w * np.cos(r)).sum())) % 360)


# ---------------------------------------------------------------- inputs
def regimes():
    r = pd.read_csv(STUDY / "regimes_era5.csv", parse_dates=["day"])
    r["broad"] = r.regime.str.replace(r"^gradient.*", "gradient", regex=True)
    return r.set_index("day")


def n72_hourly(reg):
    o = pd.read_csv(OBS)
    o = o[o.lat.between(40.3, 41.0) & o.lon.between(13.7, 14.7)]
    t = pd.to_datetime(o.t_start_utc).dt.tz_localize(None) + pd.Timedelta(hours=2)
    o["day"], o["lh"] = t.dt.normalize(), t.dt.hour
    rows = [{"day": d, "lh": h, "kn": g.tws_kn.mean(), "dir": circ_mean(g.twd_deg, g.tws_kn),
             "gust": g.gust_kn.max(), "gf": (g.gust_kn / g.tws_kn).median()}
            for (d, h), g in o.groupby(["day", "lh"]) if len(g) >= 3 and h in HOURS]
    n = pd.DataFrame(rows).join(reg[["regime", "broad", "sub"]], on="day")
    return n


def era5_point():
    """ERA5 at POINT, every hour on disk (09-15 UTC = 11-17 local), lifted to 32 m."""
    frames = []
    for f in sorted((RAW / "era5").glob("*.csv.gz")):
        e = pd.read_csv(f, parse_dates=["valid_time"], usecols=["valid_time", "latitude", "longitude",
                                                                 "u10", "v10", "u100", "v100"])
        e = e.groupby(["valid_time", "latitude", "longitude"], as_index=False).first()
        lats, lons = np.sort(e.latitude.unique()), np.sort(e.longitude.unique())
        i, j = np.searchsorted(lats, POINT[0]) - 1, np.searchsorted(lons, POINT[1]) - 1
        la0, la1, lo0, lo1 = lats[i], lats[i + 1], lons[j], lons[j + 1]
        fy, fx = (POINT[0] - la0) / (la1 - la0), (POINT[1] - lo0) / (lo1 - lo0)
        w = {(la0, lo0): (1 - fy) * (1 - fx), (la0, lo1): (1 - fy) * fx, (la1, lo0): fy * (1 - fx), (la1, lo1): fy * fx}
        e = e[[(a, b) in w for a, b in zip(e.latitude, e.longitude)]].copy()
        e["w"] = [w[(a, b)] for a, b in zip(e.latitude, e.longitude)]
        for v in ("u10", "v10", "u100", "v100"):
            e[v] = e[v] * e.w
        frames.append(e.groupby("valid_time")[["u10", "v10", "u100", "v100"]].sum())
    e = pd.concat(frames).sort_index()
    a = np.log(MAST_M / 10) / np.log(10)
    s10, s100 = np.hypot(e.u10, e.v10), np.hypot(e.u100, e.v100)
    u, v = e.u10 + (e.u100 - e.u10) * a, e.v10 + (e.v100 - e.v10) * a
    out = pd.DataFrame({"kn": (s10 + (s100 - s10) * a) * KN,
                        "dir": np.degrees(np.arctan2(-u, -v)) % 360}, index=e.index)
    lt = out.index + pd.Timedelta(hours=2)
    out["day"], out["lh"] = lt.normalize(), lt.hour
    return out[out.lh.isin(HOURS)].reset_index(drop=True)


def era5_bias(reg):
    """ERA5 (32 m, at the boat) minus masthead on the N72 hours, by our regime label. Held out by
    regatta as well, so the number that is applied is one that transfers."""
    p = pd.read_csv(STUDY / "validation_n72_pairs.csv", parse_dates=["valid_time", "day"])
    p = p.join(reg[["broad"]], on="day")
    p["err"] = p.era5_kn - p.obs_kn
    g = p[p.broad == "gradient"]
    by_reg = g.groupby("regatta").err.mean()
    nb = p[p.broad.isin(["no breeze", "SB on gradient"])]
    return {"bias": float(g.err.mean()), "n_hours": int(len(g)), "n_days": int(g.day.nunique()),
            "other_days": {str(d.date()): round(float(x.err.mean()), 2) for d, x in nb.groupby("day")},
            "by_regatta": by_reg.round(2).to_dict(),
            "sb_ratio": float(p[p.broad == "sea breeze"].obs_kn.mean() / p[p.broad == "sea breeze"].era5_kn.mean())}


# Which stations VOTE on F and the hourly shape. Capri is computed and shown but does not vote (Wouter,
# 26 Nov 2026): from personal observation it is often in the island's lee and does not see the sea
# breeze, so its July/May ratio measures its shelter as much as the breeze. Posillipo, Napoli port and
# Capodichino are on the bay's own shore.
USED = ("posillipo", "napoli_port", "capodichino")
SHAPE_FROM = ("napoli_port", "capodichino")       # the two with every hour 11-17 well sampled

DIRS16 = {k: i * 22.5 for i, k in enumerate("N NNE NE ENE E ESE SE SSE S SSW SW WSW W WNW NW NNW".split())}


def stations(reg):
    """July / May afternoon wind on ERA5 sea-breeze days, per station: pooled, and per summer."""
    st = {}
    for n in ("capri", "capodichino"):
        f = pd.read_csv(RAW / f"stations/isd_{n}.csv.gz", parse_dates=["t_utc"])
        st[n] = f.rename(columns={"t_utc": "t"})
    p = pd.read_csv(RAW / "stations/posillipo_pangaea_896272.tsv.gz", sep="\t")
    p.columns = ["t", "T", "RH", "P", "pr", "prr", "ff", "fg", "dir", "gdir"]
    # the PANGAEA clock is local summer time: the June-July temperature minimum falls at 06, the
    # sunrise minimum in local time, not 08 as it would if the stamps were UTC
    p["t"] = pd.to_datetime(p.t) - pd.Timedelta(hours=2)
    st["posillipo"] = pd.DataFrame({"t": p.t, "kn": p.ff * KN, "dir": p.dir.map(DIRS16)})
    st["napoli_port"] = pd.read_csv(RAW / "stations/ispra_napoli.csv.gz", parse_dates=["t_utc"]).rename(columns={"t_utc": "t"})
    out = {}
    for n, f in st.items():
        f = f.copy()
        lt = f.t + pd.Timedelta(hours=2)
        f["day"], f["lh"] = lt.dt.normalize(), lt.dt.hour
        f = f[f.lh.isin(HOURS)].join(reg[["broad"]], on="day")
        f = f[f.broad == "sea breeze"]
        md = f.day.dt.strftime("%m-%d")
        f["season"] = np.where(md <= "05-31", "May", np.where(md.between("06-15", "07-20"), "Jul", ""))
        f = f[f.season != ""]
        m = f.groupby("season").kn.mean()
        y = f.groupby([f.day.dt.year, "season"]).kn.mean().unstack()
        yr = (y.Jul / y.May).dropna()
        jul = f[f.season == "Jul"].groupby("lh").kn.mean()
        out[n] = {"used": n in USED, "shape": (jul / jul[15]).round(3).to_dict(), "ratio": float(m.Jul / m.May), "may_kn": float(m.May), "jul_kn": float(m.Jul),
                  "summers": int(len(yr)), "yr_p25": float(yr.quantile(.25)), "yr_p75": float(yr.quantile(.75)),
                  "days_may": int(f[f.season == "May"].day.nunique()), "days_jul": int(f[f.season == "Jul"].day.nunique())}
    return out


# ---------------------------------------------------------------- simulation
def week_days(reg):
    """(summer, shift) -> the five days of that historical race week."""
    weeks = []
    for y in sorted(reg.index.year.unique()):
        start = pd.Timestamp(f"{y}-{WEEK[0]}")
        for s in SHIFTS:
            d = [start + pd.Timedelta(days=s + k) for k in range(5)]
            if all(x in reg.index for x in d):
                weeks.append((y, s, d))
    return weeks


def sb_profiles(n72, shape):
    """Each N72 sea-breeze day as a complete 11-17 profile. The boat raced ~12-15 local, so only 5 of
    the 11 days have 11:00 and ONE has 16:00 or 17:00. A missing hour is the day's nearest sailed hour
    times the stations' July sea-breeze shape between the two hours (Capri and Capodichino, 20
    summers): the LEVEL is the masthead's, the SHAPE the stations'. Direction: the nearest sailed hour's."""
    out = {}
    for d, g in n72[n72.broad == "sea breeze"].groupby("day"):
        g = g.set_index("lh")
        rows = []
        for h in HOURS:
            if h in g.index:
                rows.append((h, g.loc[h].kn, g.loc[h].dir, False))
            else:
                h0 = min(g.index, key=lambda x: (abs(x - h), x))
                rows.append((h, g.loc[h0].kn * shape[h] / shape[h0], g.loc[h0].dir, True))
        out[d] = (g["sub"].iloc[0], pd.DataFrame(rows, columns=["lh", "kn", "dir", "filled"]).set_index("lh"))
    return out


def simulate(reg, prof, e5, bias, F, years=None, n72_days=None):
    """One pass over the historical weeks -> per-day hourly winds. Returns a long frame."""
    pool = list(prof) if n72_days is None else list(n72_days)
    subs = np.array([prof[d][0] for d in pool])
    e5d = {d: g.set_index("lh") for d, g in e5.groupby("day")}
    weeks = week_days(reg)
    if years is not None:
        weeks = [w for y in years for w in weeks if w[0] == y]
    rows = []
    for wi, (y, s, days) in enumerate(weeks):
        f = rng.uniform(*F)
        for k, d in enumerate(days):
            lab = reg.loc[d]
            if lab.broad == "sea breeze":
                same = np.flatnonzero(subs == lab["sub"])
                pick = prof[pool[rng.choice(same) if len(same) else rng.integers(len(pool))]][1]
                for h in HOURS:
                    src = pick.loc[h]
                    rows.append((wi, y, s, k, d, h, "sea breeze", lab["sub"], src.kn * f, src.dir))
            else:
                g = e5d.get(d)
                for h in HOURS:
                    if g is None or h not in g.index:
                        continue
                    rows.append((wi, y, s, k, d, h, lab.broad, lab.regime, max(g.loc[h].kn - bias, 0), g.loc[h].dir))
    return pd.DataFrame(rows, columns=["week", "year", "shift", "k", "day", "lh", "broad", "detail", "kn", "dir"])


def summarise(sim):
    sim = sim.copy()
    sim["ok"] = sim.kn.between(*LIMITS)
    hourly = sim.groupby("lh").kn.quantile([.1, .25, .5, .75, .9]).unstack()
    hourly["mean"] = sim.groupby("lh").kn.mean()
    hourly["p_in_limits"] = sim.groupby("lh").ok.mean()
    hourly["p_lt6"] = sim.groupby("lh").kn.apply(lambda x: (x < LIMITS[0]).mean())
    hourly["p_ge12"] = sim.groupby("lh").kn.apply(lambda x: (x >= 12).mean())
    hourly["p_ge16"] = sim.groupby("lh").kn.apply(lambda x: (x >= 16).mean())
    day = sim.groupby(["week", "k"]).agg(ok_h=("ok", "sum"), broad=("broad", "first"), peak=("kn", "max"))
    day["raceable"] = day.ok_h >= MIN_HOURS
    wk = day.groupby("week").raceable.sum()
    return {"hourly": hourly,
            "p_day": float(day.raceable.mean()),
            "p_day_by_regime": day.groupby("broad").raceable.mean().to_dict(),
            "p_ge4": float((wk >= 4).mean()), "p_all5": float((wk == 5).mean()),
            "days_lost_mean": float((5 - wk).mean()),
            "peak_p50": float(day.peak.median()),
            "sectors": pd.crosstab(sim.lh, sector(sim.dir.values), normalize="index")}


def bootstrap(reg, prof, e5, bias, F, n=200):
    years = sorted(reg.index.year.unique())
    sbdays = sorted(prof)
    keep = {"p50_14": [], "p50_15": [], "p_day": [], "p_ge4": [], "p_all5": [], "p_in_14": []}
    for _ in range(n):
        ys = list(rng.choice(years, len(years)))
        ds = list(rng.integers(len(sbdays), size=len(sbdays)))
        s = summarise(simulate(reg, prof, e5, bias, F, ys, [sbdays[i] for i in ds]))
        keep["p50_14"].append(s["hourly"].loc[14, .5]); keep["p50_15"].append(s["hourly"].loc[15, .5])
        keep["p_in_14"].append(s["hourly"].loc[14, "p_in_limits"])
        for k in ("p_day", "p_ge4", "p_all5"):
            keep[k].append(s[k])
    return {k: (float(np.quantile(v, .05)), float(np.quantile(v, .95))) for k, v in keep.items()}


def sen_slope(y):
    y = np.asarray(y, float)
    x = np.arange(len(y))
    s = [(y[j] - y[i]) / (j - i) for i in range(len(y)) for j in range(i + 1, len(y))]
    sgn = sum(np.sign(y[j] - y[i]) for i in range(len(y)) for j in range(i + 1, len(y)))
    n = len(y)
    var = n * (n - 1) * (2 * n + 5) / 18
    z = (sgn - np.sign(sgn)) / np.sqrt(var) if sgn else 0.0
    return float(np.median(s)), float(z)


# ---------------------------------------------------------------- zones (CERRA)
ZONES = {"course": (40.62, 14.32), "sorrento": (40.65, 14.375), "bottom": (40.72, 14.43),
         "midbay": (40.74, 14.25), "posillipo": (40.805, 14.23)}


def zones_cerra_cds(reg):
    """CDS CERRA (2024-26 pilot) 30 m at each zone's nearest SEA cell, sea-breeze days in the
    window, ratio to the course cell, by analysis hour."""
    lsm = pd.read_csv(RAW / "lsm/cerra-lsm.csv.gz")[["iy", "ix", "lsm"]]
    frames = [pd.read_csv(f, parse_dates=["valid_time"]) for f in sorted((RAW / "cerra").glob("*-an.csv.gz"))]
    c = pd.concat(frames).merge(lsm, on=["iy", "ix"])
    c = c[c.lsm < 0.5]
    cells = c.drop_duplicates(["iy", "ix"])[["iy", "ix", "latitude", "longitude"]]
    pick = {}
    for z, (la, lo) in ZONES.items():
        d = np.hypot(cells.latitude - la, (cells.longitude - lo) * np.cos(np.radians(la)))
        pick[z] = tuple(cells.loc[d.idxmin(), ["iy", "ix"]])
    c["day"] = c.valid_time.dt.normalize()
    c = c.join(reg[["broad"]], on="day")
    md = c.day.dt.strftime("%m-%d")
    c = c[(c.broad == "sea breeze") & md.between("05-30", "08-02")]
    out = {}
    for z, (iy, ix) in pick.items():
        out[z] = c[(c.iy == iy) & (c.ix == ix)].set_index("valid_time").ws30 * KN
    f = pd.DataFrame(out)
    f["h"] = f.index.hour + 2
    return {z: f.groupby("h")[z].mean().div(f.groupby("h")["course"].mean()).round(2).to_dict() for z in ZONES}, \
        {z: (f[z] - f.course).groupby(f.h).mean().round(1).to_dict() for z in ZONES}, int(f.index.normalize().nunique())


def zones_openmeteo(reg):
    """Open-Meteo CERRA, 10 m and 100 m, 2006-2021, sea-breeze days in the window, 11-17 local."""
    out = {}
    for z in ZONES:
        f = pd.read_csv(RAW / f"omcerra/{z}.csv.gz", parse_dates=["valid_time"])
        lt = f.valid_time + pd.Timedelta(hours=2)
        f["day"], f["lh"] = lt.dt.normalize(), lt.dt.hour
        f = f[f.lh.isin(HOURS)].join(reg[["broad"]], on="day")
        md = f.day.dt.strftime("%m-%d")
        f = f[(f.broad == "sea breeze") & md.between("05-30", "08-02")]
        out[z] = f.set_index(["day", "lh"])[["wind_speed_10m", "wind_speed_100m"]]
    res = {}
    for z in ZONES:
        j = out[z].join(out["course"], rsuffix="_c", how="inner")
        res[z] = {"d10": float((j.wind_speed_10m - j.wind_speed_10m_c).mean()),
                  "d100": float((j.wind_speed_100m - j.wind_speed_100m_c).mean()),
                  "kn10": float(j.wind_speed_10m.mean()), "kn100": float(j.wind_speed_100m.mean()),
                  "days": int(j.index.get_level_values(0).nunique())}
    return res


# ---------------------------------------------------------------- figures (SVG, no plotting library)
def fig_fan(h, path, title):
    W, H, L, R, T, B = 640, 300, 50, 20, 28, 36
    ymax = 25
    X = lambda i: L + (W - L - R) * i / (len(HOURS) - 1)
    Y = lambda v: T + (H - T - B) * (1 - min(v, ymax) / ymax)
    s = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="100%" '
         f'style="font-family:Helvetica,Arial,sans-serif;font-size:11px">',
         f'<text x="{L}" y="16" font-weight="bold" font-size="12">{title}</text>']
    for v in range(0, ymax + 1, 5):
        s.append(f'<line x1="{L}" x2="{W - R}" y1="{Y(v):.1f}" y2="{Y(v):.1f}" stroke="#e3e3e3"/>')
        s.append(f'<text x="{L - 6}" y="{Y(v) + 4:.1f}" text-anchor="end" fill="#666">{v}</text>')
    s.append(f'<rect x="{L}" y="{Y(LIMITS[0]):.1f}" width="{W - L - R}" height="{Y(0) - Y(LIMITS[0]):.1f}" fill="#f6e3e3"/>')
    s.append(f'<text x="{W - R - 4}" y="{Y(0) - 4:.1f}" text-anchor="end" fill="#b55" font-size="10">below the 6 kn limit</text>')
    for lo, hi, op in ((.1, .9, .18), (.25, .75, .35)):
        pts = [f"{X(i):.1f},{Y(h.loc[k, hi]):.1f}" for i, k in enumerate(HOURS)] + \
              [f"{X(i):.1f},{Y(h.loc[k, lo]):.1f}" for i, k in reversed(list(enumerate(HOURS)))]
        s.append(f'<polygon points="{" ".join(pts)}" fill="#2c6e9e" opacity="{op}"/>')
    s.append('<polyline fill="none" stroke="#1d4f73" stroke-width="2.4" points="' +
             " ".join(f"{X(i):.1f},{Y(h.loc[k, .5]):.1f}" for i, k in enumerate(HOURS)) + '"/>')
    for i, k in enumerate(HOURS):
        s.append(f'<text x="{X(i):.1f}" y="{H - B + 16}" text-anchor="middle" fill="#444">{k:02d}:00</text>')
        s.append(f'<text x="{X(i):.1f}" y="{Y(h.loc[k, .5]) - 7:.1f}" text-anchor="middle" fill="#1d4f73" font-weight="bold">{h.loc[k, .5]:.1f}</text>')
    s.append(f'<text x="14" y="{T + (H - T - B) / 2}" transform="rotate(-90 14 {T + (H - T - B) / 2})" text-anchor="middle" fill="#444">kn at 30 m</text>')
    s.append(f'<text x="{W - R}" y="{H - 4}" text-anchor="end" fill="#777" font-size="10">line: median · dark band: P25-P75 · light band: P10-P90 · local time (CEST)</text>')
    s.append("</svg>")
    path.write_text("\n".join(s))


def fig_sectors(sec, path, title):
    W, H, L, R, T, B = 640, 230, 50, 110, 28, 36
    cols = {"N-NE": "#7f8c8d", "E-SE": "#c0392b", "S-SW": "#e07a2e", "SW-W": "#2c6e9e", "NW": "#16a085"}
    bw = (W - L - R) / len(HOURS)
    s = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="100%" '
         f'style="font-family:Helvetica,Arial,sans-serif;font-size:11px">',
         f'<text x="{L}" y="16" font-weight="bold" font-size="12">{title}</text>']
    for i, h in enumerate(HOURS):
        y = T
        for n in cols:
            v = float(sec.loc[h, n]) if n in sec.columns else 0
            hh = (H - T - B) * v
            s.append(f'<rect x="{L + i * bw + 4:.1f}" y="{y:.1f}" width="{bw - 8:.1f}" height="{hh:.1f}" fill="{cols[n]}"/>')
            if v >= .08:
                s.append(f'<text x="{L + i * bw + bw / 2:.1f}" y="{y + hh / 2 + 4:.1f}" text-anchor="middle" fill="#fff" font-size="10">{v * 100:.0f}</text>')
            y += hh
        s.append(f'<text x="{L + i * bw + bw / 2:.1f}" y="{H - B + 16}" text-anchor="middle" fill="#444">{h:02d}:00</text>')
    for j, (n, c) in enumerate(cols.items()):
        lab = {"N-NE": "N-NE 340-80°", "E-SE": "E-SE 80-170°", "S-SW": "S-SW 170-235°",
               "SW-W": "SW-W 235-290°", "NW": "NW 290-340°"}[n]
        s.append(f'<rect x="{W - R + 10}" y="{T + j * 18}" width="10" height="10" fill="{c}"/>')
        s.append(f'<text x="{W - R + 25}" y="{T + j * 18 + 9}">{lab}</text>')
    s.append(f'<text x="{W - R}" y="{H - 4}" text-anchor="end" fill="#777" font-size="10">% of race-week hours, by direction the wind comes FROM</text>')
    s.append("</svg>")
    path.write_text("\n".join(s))


def fig_regimes(per_year, path):
    W, H, L, R, T, B = 640, 220, 40, 120, 28, 30
    cols = {"sea breeze": "#2c6e9e", "SB on gradient": "#7fb3d5", "gradient": "#e07a2e", "no breeze": "#c0392b"}
    yrs = list(per_year.index)
    bw = (W - L - R) / len(yrs)
    s = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="100%" '
         f'style="font-family:Helvetica,Arial,sans-serif;font-size:11px">',
         f'<text x="{L}" y="16" font-weight="bold" font-size="12">Weather type, 30 May - 2 Aug, each summer (days of 65)</text>']
    for i, y in enumerate(yrs):
        top = T
        for n, c in cols.items():
            v = per_year.loc[y].get(n, 0) / per_year.loc[y].sum()
            hh = (H - T - B) * v
            s.append(f'<rect x="{L + i * bw + 1:.1f}" y="{top:.1f}" width="{bw - 2:.1f}" height="{hh:.1f}" fill="{c}"/>')
            top += hh
        if i % 2 == 0:
            s.append(f'<text x="{L + i * bw + bw / 2:.1f}" y="{H - B + 14}" text-anchor="middle" fill="#444" font-size="10">{y}</text>')
    for j, (n, c) in enumerate(cols.items()):
        s.append(f'<rect x="{W - R + 10}" y="{T + j * 18}" width="10" height="10" fill="{c}"/>')
        s.append(f'<text x="{W - R + 25}" y="{T + j * 18 + 9}">{n}</text>')
    s.append("</svg>")
    path.write_text("\n".join(s))


# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--fig-dir", type=Path)
    ap.add_argument("--boot", type=int, default=200)
    a = ap.parse_args()
    out_dir = STUDY / "results"
    out_dir.mkdir(exist_ok=True)
    pd.set_option("display.width", 200)

    reg = regimes()
    n72 = n72_hourly(reg)
    e5 = era5_point()
    b = era5_bias(reg)
    st = stations(reg)
    ratios = [v["ratio"] for k, v in st.items() if v["used"]]
    F = (min(ratios), max(ratios))
    print("ERA5 bias on non-sea-breeze N72 hours:", json.dumps(b))
    print("stations, July/May on sea-breeze days:")
    for k, v in st.items():
        print(f"  {k:12s} {'' if v['used'] else '(not used) '}{v['may_kn']:4.1f} -> {v['jul_kn']:4.1f} kn  x{v['ratio']:.2f}  "
              f"(per summer P25-P75 {v['yr_p25']:.2f}-{v['yr_p75']:.2f}, {v['summers']} summers; {v['days_may']}/{v['days_jul']} days)")
    print(f"F drawn uniform {F[0]:.2f}-{F[1]:.2f}")
    shape = {h: float(np.mean([st[k]["shape"][h] for k in SHAPE_FROM])) for h in HOURS}
    print("station July sea-breeze shape (x the 15:00 value):", {h: round(v, 2) for h, v in shape.items()})
    prof = sb_profiles(n72, shape)
    nfill = sum(p[1].filled.sum() for p in prof.values())
    print(f"N72 sea-breeze day-hours filled from the shape: {nfill} of {len(prof) * len(HOURS)}")

    sbn = n72[n72.broad == "sea breeze"]
    print(f"\nN72 sea-breeze days: {sbn.day.nunique()}, by sub-type {sbn.groupby('sub').day.nunique().to_dict()}")
    print(sbn.groupby("lh").kn.describe(percentiles=[.1, .5, .9]).round(1))

    sim = simulate(reg, prof, e5, b["bias"], F)
    s = summarise(sim)
    print(f"\nRACE WEEK, {sim.week.nunique()} historical weeks ({len(set(sim.year))} summers x {len(SHIFTS)} shifts)")
    print(s["hourly"].round(2))
    print("direction sectors by hour:\n", (s["sectors"] * 100).round(0))
    print(f"P(day race-able, >= {MIN_HOURS} h in {LIMITS}) = {s['p_day']:.2f}   by regime {s['p_day_by_regime']}")
    print(f"P(>= 4 of 5 days) = {s['p_ge4']:.2f}   P(all 5) = {s['p_all5']:.2f}   days lost per week {s['days_lost_mean']:.2f}")

    by_reg = {r: summarise(g)["hourly"] for r, g in sim.groupby("broad")}
    for r, h in by_reg.items():
        print(f"\n{r}:\n", h[[.1, .5, .9, "p_in_limits"]].round(1))

    # whole window, for the pentad view and May contrast is in classify_regimes; here: ERA5-only cross-check
    e5w = e5.join(reg[["broad"]], on="day")
    e5w = e5w[e5w.day.dt.strftime("%m-%d").between(*WEEK)]
    xchk = e5w.assign(kn=np.where(e5w.broad == "sea breeze", e5w.kn * b["sb_ratio"], e5w.kn - b["bias"])).groupby("lh").kn.median()
    print("\nCROSS-CHECK, ERA5 alone (sea-breeze days x the masthead/ERA5 ratio, others + bias), P50 by hour:\n", xchk.round(1).to_dict())

    boot = bootstrap(reg, prof, e5, b["bias"], F, a.boot)
    print("\n90 % intervals (bootstrap over summers and N72 days):", {k: tuple(round(x, 2) for x in v) for k, v in boot.items()})

    # direction by hour, and sea-breeze onset (first hour >= 8 kn), from the simulated race days
    dirs = {}
    for r, g in sim.groupby("broad"):
        dirs[r] = {int(h): round(circ_mean(x.dir, x.kn), 0) for h, x in g.groupby("lh")}
    dirs["SB, NW morning"] = {int(h): round(circ_mean(x.dir, x.kn), 0) for h, x in sim[sim.detail == "NW-morning"].groupby("lh")}
    dirs["SB, SE morning"] = {int(h): round(circ_mean(x.dir, x.kn), 0) for h, x in sim[sim.detail == "SE-morning"].groupby("lh")}
    print("\nmean direction by hour:", json.dumps(dirs))
    sbd = sim[sim.broad == "sea breeze"].sort_values("lh")
    on = sbd[sbd.kn >= 8].groupby(["week", "k"]).lh.min().reindex(sbd.groupby(["week", "k"]).size().index)
    onset = on.value_counts(normalize=True, dropna=False).sort_index().round(3)
    print("sea-breeze day: first hour >= 8 kn (NaN = never):", onset.to_dict())
    sub_odds = (sim[sim.broad == "sea breeze"].groupby(["week", "k"]).detail.first().value_counts(normalize=True).round(3))
    print("sea-breeze sub-type odds:", sub_odds.to_dict())

    # gusts, by regime (N72, 10-min max gust over 10-min mean)
    gf = n72.groupby("broad").gf.median().round(2).to_dict()
    print("\nN72 gust factor (median 10-min gust / mean):", gf)

    # trend, sea-breeze days per summer in the window
    w = reg[reg.index.strftime("%m-%d").to_series(index=reg.index).between("05-30", "08-02")]
    per_year = w.groupby([w.index.year, "broad"]).size().unstack(fill_value=0)
    slope, z = sen_slope(per_year["sea breeze"].values)
    print(f"\nsea-breeze days per summer: Sen slope {slope * 10:+.1f} days/decade, Mann-Kendall z {z:.2f}")
    wk_e5 = e5.join(reg[["broad"]], on="day")
    wk_e5 = wk_e5[wk_e5.day.dt.strftime("%m-%d").between("05-30", "08-02")]
    ann = wk_e5.groupby(wk_e5.day.dt.year).kn.mean()
    slope_kn, z_kn = sen_slope(ann.values)
    print(f"ERA5 afternoon 32 m wind, window mean: Sen slope {slope_kn * 10:+.2f} kn/decade, z {z_kn:.2f}")

    zc, zd, zdays = zones_cerra_cds(reg)
    zo = zones_openmeteo(reg)
    print(f"\nZONES, CDS CERRA 30 m (2024-26, {zdays} window sea-breeze days), difference to course, kn by local hour:")
    for z, v in zd.items():
        print(f"  {z:10s}", v)
    print("ZONES, Open-Meteo CERRA 2006-2021 sea-breeze days, 11-17 local, difference to course:")
    for z, v in zo.items():
        print(f"  {z:10s} 10 m {v['d10']:+.1f}  100 m {v['d100']:+.1f}  ({v['days']} days)")

    res = {"bias": b, "stations": st, "shape": shape, "F": F, "p_day": s["p_day"], "p_ge4": s["p_ge4"], "p_all5": s["p_all5"],
           "days_lost_mean": s["days_lost_mean"], "p_day_by_regime": s["p_day_by_regime"], "boot": boot,
           "gust_factor": gf, "sb_trend_days_per_decade": slope * 10, "sb_trend_z": z,
           "wind_trend_kn_per_decade": slope_kn * 10, "wind_trend_z": z_kn,
           "zones_cerra_cds": zd, "zones_openmeteo": zo, "xcheck_era5_p50": xchk.round(2).to_dict(),
           "weeks": int(sim.week.nunique()), "dirs": dirs,
           "onset": {str(k): v for k, v in onset.to_dict().items()}, "sub_odds": sub_odds.to_dict()}
    (out_dir / "race_week.json").write_text(json.dumps(res, indent=1, default=str))
    s["hourly"].to_csv(out_dir / "race_week_hourly.csv")
    (s["sectors"] * 100).round(1).to_csv(out_dir / "race_week_sectors.csv")
    for r, h in by_reg.items():
        h.to_csv(out_dir / f"race_week_hourly_{r.replace(' ', '_')}.csv")
    per_year.to_csv(out_dir / "regimes_per_summer.csv")
    print(f"\nwrote {out_dir}")

    if a.fig_dir:
        a.fig_dir.mkdir(parents=True, exist_ok=True)
        fig_fan(s["hourly"], a.fig_dir / "fan_all.svg", "Race week 29 Jun - 3 Jul: wind at 30 m off Sorrento, all days")
        if "sea breeze" in by_reg:
            fig_fan(by_reg["sea breeze"], a.fig_dir / "fan_seabreeze.svg", "Sea-breeze days only (~70 % of race-week days)")
        if "gradient" in by_reg:
            fig_fan(by_reg["gradient"], a.fig_dir / "fan_gradient.svg", "Gradient days only (~23 %)")
        fig_sectors(s["sectors"], a.fig_dir / "sectors.svg", "Where the wind comes from, by hour (race week, all days)")
        fig_regimes(per_year, a.fig_dir / "regimes_per_summer.svg")
        print(f"figures -> {a.fig_dir}")


if __name__ == "__main__":
    main()
