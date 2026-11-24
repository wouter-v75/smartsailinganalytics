#!/usr/bin/env python3
"""
Bay of Naples study, step 5.3 / 5.4.1: give every day 2006-2026 ONE regime label, from ERA5 alone.

Read-only. Reads the ERA5 CSVs cds_fetch.py wrote (era5 = surface, era5pl = 850 hPa, era5low = 1000 /
925 hPa) and writes <study>/regimes_era5.csv, one row per day, plus the tables printed here.

Why ERA5 alone: the same rule has to label the 19 Northstar 72 days and the 21 summers, so it may use
nothing the archive does not have -- in particular not the boat's own direction, which the gate's rule
(validate_n72.py) leaned on. Reproducing that rule's labels on the N72 days is the calibration check.

The features, per day (UTC; local = UTC + 2 all summer):
  g850       850 hPa wind over the bay at 12 UTC (14 local), kn and direction -- the synoptic gradient.
             Above the sea-breeze layer, so the breeze does not contaminate it.
  m925       925 hPa wind at 06 UTC (08 local) -- the MORNING gradient. Site knowledge S4: the breeze's
             direction track is set by it (SE morning 160 -> 250, NW morning 210 -> 280-290).
  pm100      ERA5's own 100 m wind at the course cell at 13 UTC (15 local) against 09 UTC (11 local).
             ERA5 under-does every sea-breeze afternoon by ~40 % (5.2), but it does TURN onshore, so
             the turn is used and the speed is not.
  dT         land 2 m T (Campanian plain) minus SST in the bay at 12 UTC -- the breeze's engine.
  stab       theta(925) - theta(1000) at 12 UTC, K -- the low lid (S6). 850 hPa is above the lid,
             which is why T850 - SST did not separate the days.
  t850       850 hPa T at 12 UTC -- the heat-dome / subsidence flag of 5.3.

The rule (v1, 24 Nov 2026). Thresholds are the gate's (10 / 12 kn) and the plan's sectors; nothing is
fitted to the 19 days, which are the check:
  g850 >= 12 kn                       -> gradient, by 850 direction: NW (270-340), N-NE (340-80),
                                         E-SE (80-170), S-SW (170-270)
  g850 < 10 and the afternoon onshore -> SEA BREEZE, sub-labelled by the morning 925 hPa direction:
                                         SE-morning (90-200), NW-morning (250-20), other-morning
  g850 < 10, NOT onshore, or onshore
  but 925 hPa E-SE >= 8 kn at 14 local -> NO BREEZE (a lost race day for a sea-breeze venue), with the
                                         reason it most likely failed: E-SE low-level flow (S6), a stable
                                         lid (stab above the window's p75), or neither
  10 <= g850 < 12                     -> SB on a gradient if onshore, else gradient by direction
'Onshore' = the 15-local 100 m direction in 150-300 deg at the course. 150, not 180, because of S4:
after an SE morning the breeze STARTS at ~160 and veers to 250, and ERA5 runs late (5.2), so at 15
local it can still be on the first half of that track -- 2024-05-14 and -15, both sea-breeze days at
the masthead (obs 236 and 207 deg), read 179.5 and 150.5 in ERA5. Set from the site answer, not fitted;
without the 925 hPa data the check agreed on 16 of 19 days at 180 and 17 at 150.

With the 2024-26 925 hPa data in (24 Nov) it agrees on 16 of 19, and the E-SE kill rule is the reason:
it KILLS 2024-05-15 (a sea breeze at the masthead, 207 deg 9.4 kn) and still does not catch 2025-05-20,
the E-SE day (obs 118 deg) it was written for. The third miss, 2026-05-25, is a 6 kn day ERA5 has
NNW. The kill rule is v1 and unvalidated; read 'no breeze / E-SE low-level flow' with that in mind.

Flags, not labels, until the station archive can calibrate them: lid = stab above the window's p75,
heat = t850 above the window's p90.

  python classify_regimes.py                 # tables; writes regimes_era5.csv
  python classify_regimes.py --years 2024-2026
"""
from __future__ import annotations

import argparse
import glob
from pathlib import Path

import numpy as np
import pandas as pd

STUDY = Path.home() / "Documents/Claude/Projects/Smart Sailing Analytics/naples-study-2027"
RAW = STUDY / "raw"
KN = 1.943844
COURSE = (40.62, 14.32)                     # off Sorrento, where N72 raced
BAY_850 = dict(lat=(40.5, 41.0), lon=(13.75, 14.75))
LAND = dict(lat=(40.75, 41.25), lon=(14.0, 15.0))      # Campanian plain behind Naples
SEA = dict(lat=(40.5, 40.8), lon=(14.0, 14.5))         # the bay itself
WINDOW = ((5, 30), (8, 2))                  # regatta 29 Jun - 3 Jul +/- 30 days
REGATTA = ((6, 29), (7, 3))
MAY = ((5, 10), (5, 31))


def wdir(u, v):
    return (np.degrees(np.arctan2(-u, -v)) + 360) % 360


def between_deg(d, lo, hi):
    """d in the sector lo -> hi clockwise (wraps through north when lo > hi)."""
    return (d >= lo) & (d < hi) if lo <= hi else (d >= lo) | (d < hi)


def theta(t, p):
    return t * (1000.0 / p) ** 0.2857


def read(kind: str, years) -> pd.DataFrame:
    files = [f for f in sorted(glob.glob(str(RAW / kind / "*.csv.gz")))
             if int(Path(f).name[:4]) in years]
    if not files:
        return pd.DataFrame()
    return pd.concat((pd.read_csv(f, parse_dates=["valid_time"]) for f in files), ignore_index=True)


def box(df, b):
    return df[df.latitude.between(*b["lat"]) & df.longitude.between(*b["lon"])]


def at(df, hour):
    return df[df.valid_time.dt.hour == hour]


def features(years) -> pd.DataFrame:
    sfc, pl, low = read("era5", years), read("era5pl", years), read("era5low", years)
    if sfc.empty or pl.empty:
        raise SystemExit("no ERA5 on disk for those years yet")
    for d in (sfc, pl, low):
        if not d.empty:
            d["day"] = d.valid_time.dt.normalize()
    # surface rows come twice when an older file stacked the two streams: keep one per cell-hour
    sfc = sfc.groupby(["valid_time", "latitude", "longitude"], as_index=False).first()
    sfc["day"] = sfc.valid_time.dt.normalize()

    out = {}
    p8 = at(box(pl[pl.pressure_level == 850], BAY_850), 12).groupby("day")[["u", "v", "t"]].mean()
    out["g850"] = np.hypot(p8.u, p8.v) * KN
    out["d850"] = wdir(p8.u, p8.v)
    out["t850"] = p8.t - 273.15

    if not low.empty:
        b = box(low, BAY_850)
        m9 = at(b[b.pressure_level == 925], 6).groupby("day")[["u", "v"]].mean()
        out["m925"] = np.hypot(m9.u, m9.v) * KN
        out["dm925"] = wdir(m9.u, m9.v)
        a9 = at(b[b.pressure_level == 925], 12).groupby("day")[["u", "v", "t"]].mean()
        out["a925"] = np.hypot(a9.u, a9.v) * KN
        out["da925"] = wdir(a9.u, a9.v)
        t0 = at(b[b.pressure_level == 1000], 12).groupby("day").t.mean()
        out["stab"] = theta(a9.t, 925) - theta(t0, 1000)

    # course cell: the nearest ERA5 SEA point to COURSE
    cells = sfc[["latitude", "longitude", "lsm"]].drop_duplicates(["latitude", "longitude"])
    sea = cells[cells.lsm < 0.5].copy()
    sea["d"] = np.hypot(sea.latitude - COURSE[0], (sea.longitude - COURSE[1]) * np.cos(np.radians(COURSE[0])))
    c = sea.nsmallest(1, "d").iloc[0]
    cc = sfc[(sfc.latitude == c.latitude) & (sfc.longitude == c.longitude)].set_index("day")
    am, pm = at(cc.reset_index(), 9).set_index("day"), at(cc.reset_index(), 13).set_index("day")
    out["am100"] = np.hypot(am.u100, am.v100) * KN
    out["dam100"] = wdir(am.u100, am.v100)
    out["pm100"] = np.hypot(pm.u100, pm.v100) * KN
    out["dpm100"] = wdir(pm.u100, pm.v100)
    out["blh"] = at(cc.reset_index(), 12).set_index("day").blh

    land = at(box(sfc[sfc.lsm > 0.9], LAND), 12).groupby("day").t2m.mean()
    sst = at(box(sfc[sfc.lsm < 0.1], SEA), 12).groupby("day").sst.mean()
    out["dT"] = land - sst
    out["sst"] = sst - 273.15
    f = pd.DataFrame(out)
    f.index.name = "day"
    # a month whose surface or 850 file has not arrived yet has only its 1000/925 rows: not a day
    return f.dropna(subset=["g850", "dpm100"]).sort_index()


def sector(d):
    return np.select([between_deg(d, 270, 340), between_deg(d, 340, 80), between_deg(d, 80, 170)],
                     ["NW", "N-NE", "E-SE"], "S-SW")


def classify(f: pd.DataFrame, lid_kelvin: float) -> pd.DataFrame:
    f = f.copy()
    onshore = between_deg(f.dpm100, 150, 300)
    strong, weak = f.g850 >= 12, f.g850 < 10
    morning = np.select([between_deg(f.get("dm925", pd.Series(np.nan, f.index)), 90, 200),
                         between_deg(f.get("dm925", pd.Series(np.nan, f.index)), 250, 20)],
                        ["SE-morning", "NW-morning"], "other-morning")
    ese_low = between_deg(f.get("da925", pd.Series(np.nan, f.index)), 60, 170) & (f.get("a925", 0) >= 8)
    lid = f.get("stab", pd.Series(np.nan, f.index)) > lid_kelvin
    why = np.select([ese_low, lid], ["E-SE low-level flow", "stable lid"], "neither")
    # S6 first: a strong E-SE low-level flow kills the breeze even when ERA5's afternoon reads
    # 'onshore' -- at 150-170 deg an SE gradient and the start of an SE-morning breeze look alike at
    # 100 m, and only the flow above the breeze (925 hPa at 14 local) tells them apart.
    onshore = onshore & ~ese_low
    f["regime"] = np.select(
        [strong, weak & onshore, weak & ~onshore, onshore],
        ["gradient " + sector(f.d850), "sea breeze", "no breeze", "SB on gradient"],
        "gradient " + sector(f.d850))
    f["sub"] = np.where(f.regime.isin(["sea breeze", "SB on gradient"]), morning,
                        np.where(f.regime == "no breeze", why, ""))
    f["lid_flag"] = lid
    return f


def in_range(idx, rng):
    md = idx.month * 100 + idx.day
    return (md >= rng[0][0] * 100 + rng[0][1]) & (md <= rng[1][0] * 100 + rng[1][1])


def check_n72(f: pd.DataFrame):
    """The gate's labels (850 < 10 & the BOAT onshore = SB; 850 >= 12 = gradient) against ours."""
    p = STUDY / "n72_days_regime_inputs.csv"
    if not p.exists():
        return
    n = pd.read_csv(p, parse_dates=["day"]).set_index("day").drop(columns=["dT"], errors="ignore")
    n["gate"] = np.where(n.ws850 >= 12, "gradient",
                         np.where((n.ws850 < 10) & n.obs_dir.between(180, 290), "sea breeze", "other"))
    j = n.join(f, how="inner")
    if j.empty:
        print("N72 days: no ERA5 for 2024-26 on disk yet\n")
        return
    j["ours"] = np.where(j.regime.str.startswith("gradient"), "gradient",
                         np.where(j.regime.isin(["sea breeze", "SB on gradient"]), "sea breeze", "other"))
    print("N72 CHECK -- the gate's label (uses the boat's direction) against ERA5-only")
    cols = ["gate", "ours", "regime", "sub", "g850", "d850", "dm925", "dpm100", "pm100", "obs_dir", "obs_kn", "dT", "stab"]
    cols = [c for c in cols if c in j.columns]
    print(j[cols].round(1).to_string())
    agree = (j.gate == j.ours).mean()
    print(f"agree on {(j.gate == j.ours).sum()} of {len(j)} days ({agree:.0%})\n")


def table(f, rng, title):
    w = f[in_range(f.index, rng)]
    if w.empty:
        return
    yrs = w.index.year.nunique()
    print(f"{title}: {len(w)} days over {yrs} summers")
    t = (w.groupby(["regime", "sub"]).size() / len(w) * 100).rename("% of days").to_frame()
    t["days/yr"] = w.groupby(["regime", "sub"]).size() / yrs
    if "pm100" in w:
        t["ERA5 15h 100 m kn"] = w.groupby(["regime", "sub"]).pm100.mean()
    print(t.round(1).to_string(), "\n")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--years", default="2006-2026")
    ap.add_argument("--out", type=Path, default=STUDY / "regimes_era5.csv")
    a = ap.parse_args()
    lo, _, hi = a.years.partition("-")
    years = range(int(lo), int(hi or lo) + 1)

    f = features(years)
    have = sorted(set(f.index.year))
    print(f"ERA5 on disk for {len(have)} summers: {have[0]}-{have[-1]} "
          f"({', '.join(str(y) for y in sorted(set(years) - set(have))) or 'none'} missing)")
    if "stab" not in f or f.stab.isna().all():
        print("!! no 1000/925 hPa yet for these years: morning gradient and lid are blank")
    win = f[in_range(f.index, WINDOW)]
    lid_k = float(win.stab.quantile(0.75)) if "stab" in win and win.stab.notna().any() else np.inf
    print(f"lid threshold (window p75 of theta925 - theta1000 at 14 local): {lid_k:.1f} K\n")
    f = classify(f, lid_k)

    check_n72(f)
    table(f, WINDOW, "STUDY WINDOW 30 May - 2 Aug")
    table(f, REGATTA, "REGATTA WEEK 29 Jun - 3 Jul")
    table(f, MAY, "MAY 10-31 (the N72 season, for comparison)")

    w = f[in_range(f.index, WINDOW)].copy()
    w["year"] = w.index.year
    w["sb"] = w.regime.isin(["sea breeze", "SB on gradient"])
    w["lost"] = w.regime == "no breeze"
    by = w.groupby("year").agg(days=("sb", "size"), sea_breeze=("sb", "sum"), no_breeze=("lost", "sum"),
                               gradient=("regime", lambda r: r.str.startswith("gradient").sum()),
                               dT=("dT", "mean"), stab=("stab", "mean") if "stab" in w else ("dT", "size"),
                               sst=("sst", "mean"))
    print("BY SUMMER (window): days, sea-breeze, no-breeze, gradient; mean dT, stability, SST")
    print(by.round(1).to_string(), "\n")

    a.out.parent.mkdir(parents=True, exist_ok=True)
    f.round(2).to_csv(a.out)
    print(f"wrote {a.out} ({len(f)} days)")


if __name__ == "__main__":
    main()
