#!/usr/bin/env python3
"""Validation gate (plan 5.2): is CERRA good enough to be the study's backbone?

Truth is Northstar 72's calibrated masthead GROUND wind at Sorrento, May 2024-26
(wind-verification/obs_sorrento.csv: 10-min vector-averaged bins, already UTC and
already TRUE north via the log's own MagVar). It is compared with CERRA and, as
the benchmark CERRA has to beat, with ERA5 -- both put through the same pairing:

  * time   -- obs bins whose midpoint is within +/-30 min of the model's valid
              hour, averaged (scalar speed, vector direction); >= 3 bins needed.
              CERRA hours are analyses (09/12/15 UTC) or +1/+2 h forecasts.
  * place  -- the boat's mean position in that hour. CERRA: inverse-distance over
              the 4 nearest SEA cells (lsm < 0.5). ERA5: bilinear on its 0.25 deg grid.
  * height -- N72's masthead is 32 m, not the 30.0 every obs row is labelled with
              (extract_obs.py's default). CERRA is interpolated in ln z between its
              30 and 50 m levels, ERA5 between 10 and 100 m.

Direction is reported twice for CERRA: raw `wdir`, and `wdir + gridrot` -- the GRIB
says "Degree true" AND uvRelativeToGrid=1, and only a truth that is itself true
north can say which. The one whose mean offset is ~0 wins.

Read-only. Usage:
  python validate_n72.py [--obs PATH] [--raw DIR] [--min-kn 6]
"""
from __future__ import annotations

import argparse
import glob
from pathlib import Path

import numpy as np
import pandas as pd

HOME = Path.home() / "Documents/Claude/Projects/Smart Sailing Analytics"
OBS = HOME / "wind-verification/obs_sorrento.csv"
RAW = HOME / "naples-study-2027/raw"
MAST_M = 32.0
KN = 1.943844


def circ_mean(deg, w=None):
    r = np.radians(np.asarray(deg, float))
    w = np.ones_like(r) if w is None else np.asarray(w, float)
    return float(np.degrees(np.arctan2((w * np.sin(r)).sum(), (w * np.cos(r)).sum())) % 360)


def dang(a, b):
    """signed a - b in (-180, 180]"""
    return (np.asarray(a) - np.asarray(b) + 180) % 360 - 180


def hourly_obs(path: Path) -> pd.DataFrame:
    o = pd.read_csv(path)
    # a lost GPS fix (2024-05-22 08:20 reads 34.76 N -5.13 E) would drag an hour's mean position off
    o = o[o.lat.between(40.3, 41.0) & o.lon.between(13.7, 14.7)]
    o["t0"] = pd.to_datetime(o.t_start_utc).dt.tz_localize(None)
    o["mid"] = o.t0 + (pd.to_datetime(o.t_end_utc).dt.tz_localize(None) - o.t0) / 2
    o["hour"] = (o.mid + pd.Timedelta(minutes=30)).dt.floor("h")
    rows = []
    for (reg, h), g in o.groupby(["regatta_id", "hour"]):
        if len(g) < 3:
            continue
        rows.append({"regatta": reg, "valid_time": h, "n_bins": len(g),
                     "lat": g.lat.mean(), "lon": g.lon.mean(),
                     "obs_kn": g.tws_kn.mean(), "obs_dir": circ_mean(g.twd_deg, g.tws_kn),
                     "obs_gust": g.gust_kn.max()})
    return pd.DataFrame(rows)


def load_cerra(raw: Path, days) -> pd.DataFrame:
    frames = []
    for f in sorted(glob.glob(str(raw / "cerra/*.csv.gz"))):
        d = pd.read_csv(f, parse_dates=["valid_time"])
        d["src"] = "an" if f.endswith("-an.csv.gz") else "fc"
        frames.append(d[d.valid_time.dt.normalize().isin(days)])
    c = pd.concat(frames, ignore_index=True)
    lsm = pd.read_csv(raw / "lsm/cerra-lsm.csv.gz")[["iy", "ix", "lsm"]]
    c = c.merge(lsm, on=["iy", "ix"], how="left")
    f = np.log(MAST_M / 30) / np.log(50 / 30)
    c["ws32"] = (c.ws30 + (c.ws50 - c.ws30) * f) * KN
    return c[c.lsm < 0.5]


def cerra_at(c: pd.DataFrame, t, lat, lon):
    g = c[c.valid_time == t]
    if g.empty:
        return None
    dy = (g.latitude - lat) * 111.2
    dx = (g.longitude - lon) * 111.2 * np.cos(np.radians(lat))
    d = np.hypot(dx, dy)
    k = d.nsmallest(4).index
    w = 1 / np.maximum(d[k], 0.5) ** 2
    gk = g.loc[k]
    return {"cerra_kn": float((gk.ws32 * w).sum() / w.sum()),
            "cerra_dir": circ_mean(gk.wdir30, w),
            "gridrot": float(gk.gridrot.mean()),
            "cerra_src": gk.src.iloc[0], "cell_km": float(d[k].min())}


def load_era5(raw: Path, days) -> pd.DataFrame:
    e = pd.concat([pd.read_csv(f, parse_dates=["valid_time"]) for f in glob.glob(str(raw / "era5/*.csv.gz"))])
    e = e[e.valid_time.dt.normalize().isin(days)]
    # files fetched before cds_fetch joined ERA5's two streams hold each hour twice
    return e.groupby(["valid_time", "latitude", "longitude"], as_index=False).first()


def era5_at(e: pd.DataFrame, t, lat, lon):
    g = e[e.valid_time == t]
    if g.empty:
        return None
    lats, lons = np.sort(g.latitude.unique()), np.sort(g.longitude.unique())
    i = np.searchsorted(lats, lat) - 1
    j = np.searchsorted(lons, lon) - 1
    la0, la1, lo0, lo1 = lats[i], lats[i + 1], lons[j], lons[j + 1]
    fy, fx = (lat - la0) / (la1 - la0), (lon - lo0) / (lo1 - lo0)
    sub = g.set_index(["latitude", "longitude"])
    out = {}
    for v in ("u10", "v10", "u100", "v100"):
        out[v] = ((1 - fy) * (1 - fx) * sub.loc[(la0, lo0), v] + (1 - fy) * fx * sub.loc[(la0, lo1), v]
                  + fy * (1 - fx) * sub.loc[(la1, lo0), v] + fy * fx * sub.loc[(la1, lo1), v])
    s10, s100 = np.hypot(out["u10"], out["v10"]), np.hypot(out["u100"], out["v100"])
    a = np.log(MAST_M / 10) / np.log(10)
    spd = (s10 + (s100 - s10) * a) * KN
    u = out["u10"] + (out["u100"] - out["u10"]) * a
    v = out["v10"] + (out["v100"] - out["v10"]) * a
    return {"era5_kn": float(spd), "era5_dir": float((np.degrees(np.arctan2(-u, -v))) % 360)}


def skill(obs, mod):
    e = mod - obs
    slope, icpt = np.polyfit(mod, obs, 1)
    return {"n": len(e), "obs_mean": obs.mean(), "mod_mean": mod.mean(), "bias": e.mean(),
            "rmse": np.sqrt((e ** 2).mean()), "mae": np.abs(e).mean(),
            "r": np.corrcoef(obs, mod)[0, 1], "obs_on_mod_slope": slope, "icpt": icpt}


def day_boot_mean(x, day, n=4000, seed=1):
    """bootstrap by DAY: hours within a day are not independent"""
    rng = np.random.default_rng(seed)
    days = np.unique(day)
    by = {d: x[day == d] for d in days}
    m = [np.concatenate([by[d] for d in rng.choice(days, len(days))]).mean() for _ in range(n)]
    return np.percentile(m, [2.5, 97.5])


def regimes(p: pd.DataFrame, raw: Path):
    """Split the gate by regime. Sea-breeze = ERA5 850 hPa over the bay < 10 kn at 12 UTC AND the boat's
    afternoon direction onshore (180-290); gradient = 850 hPa >= 12 kn; anything else 'other'.
    The finding this exists to reproduce (24 Nov 2026): on sea-breeze days neither model has hourly
    skill (r ~ 0.1) and ERA5 is a steady ~x1.4 low, so the masthead IS the sea-breeze wind."""
    pl = pd.concat(pd.read_csv(f, parse_dates=["valid_time"]) for f in glob.glob(str(raw / "era5pl/*.csv.gz")))
    pl = pl[(pl.pressure_level == 850) & pl.latitude.between(40.5, 41.0) & pl.longitude.between(13.75, 14.75)]
    g = pl.groupby("valid_time")[["u", "v"]].mean()
    ws850 = np.hypot(g.u, g.v) * KN
    day = p.groupby("day").agg(obs_dir=("obs_dir", lambda d: float(np.median(d))))
    day["ws850"] = [ws850.get(pd.Timestamp(d) + pd.Timedelta(hours=12), np.nan) for d in day.index]
    day["regime"] = np.where(day.ws850 >= 12, "gradient",
                             np.where((day.ws850 < 10) & day.obs_dir.between(180, 290), "seabreeze", "other"))
    q = p.merge(day[["regime"]], left_on="day", right_index=True)
    print("\nBY REGIME: days, hours, obs mean | CERRA bias rmse r | ERA5 bias rmse r")
    for reg, x in q.groupby("regime"):
        sc, se = skill(x.obs_kn, x.cerra_kn), skill(x.obs_kn, x.era5_kn)
        print(f"  {reg:9s} {x.day.nunique():2d} d {len(x):3d} h  {sc['obs_mean']:5.1f} | {sc['bias']:+.2f} {sc['rmse']:.2f} "
              f"{sc['r']:.2f} | {se['bias']:+.2f} {se['rmse']:.2f} {se['r']:.2f}")
    sb = q[q.regime == "seabreeze"]
    print("  sea-breeze days by LOCAL hour (+2): n, obs p25/p50/p75, CERRA mean (obs/model), ERA5 mean (obs/model)")
    for h, x in sb.groupby(sb.valid_time.dt.hour + 2):
        print(f"    {h:02d}h {len(x):2d}  {x.obs_kn.quantile(.25):4.1f} {x.obs_kn.median():4.1f} {x.obs_kn.quantile(.75):4.1f}"
              f"  {x.cerra_kn.mean():5.1f} (x{x.obs_kn.mean() / x.cerra_kn.mean():.2f})"
              f"  {x.era5_kn.mean():5.1f} (x{x.obs_kn.mean() / x.era5_kn.mean():.2f})")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--obs", type=Path, default=OBS)
    ap.add_argument("--raw", type=Path, default=RAW)
    ap.add_argument("--min-kn", type=float, default=6.0, help="direction stats only above this obs speed")
    ap.add_argument("--out", type=Path, default=None, help="write paired hours CSV")
    a = ap.parse_args()

    ob = hourly_obs(a.obs)
    days = ob.valid_time.dt.normalize().unique()
    c, e = load_cerra(a.raw, days), load_era5(a.raw, days)
    rows = []
    for r in ob.itertuples():
        cr, er = cerra_at(c, r.valid_time, r.lat, r.lon), era5_at(e, r.valid_time, r.lat, r.lon)
        if cr and er:
            rows.append({**r._asdict(), **cr, **er})
    p = pd.DataFrame(rows).drop(columns="Index")
    p["day"] = p.valid_time.dt.date.astype(str)
    print(f"{len(ob)} obs hours, {len(p)} paired with both models, {p.day.nunique()} days; "
          f"nearest CERRA sea cell median {p.cell_km.median():.1f} km\n")

    tab = pd.DataFrame({
        "CERRA (all)": skill(p.obs_kn, p.cerra_kn),
        "CERRA analyses": skill(p[p.cerra_src == "an"].obs_kn, p[p.cerra_src == "an"].cerra_kn),
        "CERRA +1/+2 h fc": skill(p[p.cerra_src == "fc"].obs_kn, p[p.cerra_src == "fc"].cerra_kn),
        "ERA5": skill(p.obs_kn, p.era5_kn),
    }).T
    print("SPEED at 32 m, kn (bias = model - obs)")
    print(tab.round(2).to_string(), "\n")

    for name, col in (("CERRA", "cerra_kn"), ("ERA5", "era5_kn")):
        lo, hi = day_boot_mean((p[col] - p.obs_kn).values, p.day.values)
        print(f"{name} bias 95% CI by day-bootstrap: {lo:+.2f} .. {hi:+.2f} kn")
    print()

    print("by regatta: obs mean / CERRA bias, rmse / ERA5 bias, rmse")
    for reg, g in p.groupby("regatta"):
        sc, se = skill(g.obs_kn, g.cerra_kn), skill(g.obs_kn, g.era5_kn)
        print(f"  {reg}: n={len(g):3d}  obs {sc['obs_mean']:.1f}  CERRA {sc['bias']:+.2f} {sc['rmse']:.2f}"
              f"  ERA5 {se['bias']:+.2f} {se['rmse']:.2f}")
    print("\nby UTC hour (local = +2): n, obs, CERRA bias, ERA5 bias")
    for h, g in p.groupby(p.valid_time.dt.hour):
        print(f"  {h:02d}: {len(g):3d}  {g.obs_kn.mean():5.1f}  {(g.cerra_kn - g.obs_kn).mean():+.2f}"
              f"  {(g.era5_kn - g.obs_kn).mean():+.2f}")
    print("\nby obs speed bin: n, CERRA bias, ERA5 bias")
    for lo_, hi_ in ((0, 6), (6, 10), (10, 14), (14, 18), (18, 40)):
        g = p[(p.obs_kn >= lo_) & (p.obs_kn < hi_)]
        if len(g):
            print(f"  {lo_:2d}-{hi_:2d} kn: {len(g):3d}  {(g.cerra_kn - g.obs_kn).mean():+.2f}"
                  f"  {(g.era5_kn - g.obs_kn).mean():+.2f}")

    q = p[p.obs_kn >= a.min_kn]
    print(f"\nDIRECTION, obs >= {a.min_kn:g} kn (n={len(q)}, {q.day.nunique()} days): obs - model")
    cands = {"CERRA raw wdir": q.cerra_dir, "CERRA wdir + gridrot": (q.cerra_dir + q.gridrot) % 360,
             "ERA5": q.era5_dir}
    for name, md in cands.items():
        d = pd.Series(dang(q.obs_dir, md), index=q.index)
        lo, hi = day_boot_mean(d.values, q.day.values)
        print(f"  {name:22s} mean {d.mean():+6.2f}  median {np.median(d):+6.2f}  "
              f"MAE {np.abs(d).mean():5.1f}  95% CI {lo:+.1f} .. {hi:+.1f}")
    print(f"  (gridrot over these hours: {q.gridrot.mean():.2f} deg)")
    print("  per regatta, CERRA raw mean offset:",
          ", ".join(f"{k} {dang(g.obs_dir, g.cerra_dir).mean():+.1f}" for k, g in q.groupby("regatta")))
    print("  per regatta, ERA5 mean offset:     ",
          ", ".join(f"{k} {dang(g.obs_dir, g.era5_dir).mean():+.1f}" for k, g in q.groupby("regatta")))

    regimes(p, a.raw)

    if a.out:
        p.to_csv(a.out, index=False)
        print(f"\npaired hours -> {a.out}")


if __name__ == "__main__":
    main()
