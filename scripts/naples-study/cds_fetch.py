#!/usr/bin/env python3
"""
Bay of Naples 30 m wind study (2027 regatta, 29 Jun - 3 Jul) -- Copernicus downloads.

Pulls, for every summer 1985-2026, 10 May - 2 Aug (the study window 30 May - 2 Aug
plus the N72 May days for comparison), the RACING WINDOW ONLY: 11:00-17:00 local =
09-15 UTC (CEST is UTC+2 all summer).

  cerra   CERRA height levels, wind speed + direction at 15 / 30 / 50 m, hourly:
          analyses 09, 12, 15 UTC + forecasts from 09 and 12 at +1 h, +2 h
          (10, 11, 13, 14 UTC). Never leads beyond +2 h.
  lsm     CERRA land-sea mask (once), to keep only sea cells.
  era5    ERA5 single levels (10/100 m wind, 2 m T, SST, BLH, MSLP, gust, cloud),
          09-15 UTC, over a box around the bay -- the regime classifier's surface input.
  era5pl  ERA5 850 / 700 hPa u, v, T at 09, 12, 15 UTC -- the gradient wind and the
          subsidence (heat-dome) signal.

CERRA HAS NO AREA OPTION on the CDS: every field comes back for all of Europe
(~1069 x 1069 points). Each request is therefore one month of one product, cropped
to the bay box on arrival and the full-domain file deleted, so the disk only ever
holds one or two raw files. ERA5 is cropped server-side.

Dry run by default: prints what it would request. --write downloads.

  python cds_fetch.py check                 # tiny request: proves the key + licences
  python cds_fetch.py plan                  # counts and sizes, nothing fetched
  python cds_fetch.py all --years 2024-2026 --write    # pilot: three summers
  python cds_fetch.py all --write           # everything, resumable

Output: <out>/<dataset>/<YYYY>-<MM>[-an|-fc].csv.gz, one file per request. A file
that exists is skipped, so an interrupted run just restarts.
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import os
import shutil
import sys
import tempfile
import zipfile
from pathlib import Path

DEFAULT_OUT = Path.home() / "Documents/Claude/Projects/Smart Sailing Analytics/naples-study-2027/raw"

# Bay box for CERRA cropping: Ischia & Procida (W) to Castellammare (E),
# south of Capri (S) to Posillipo / Naples waterfront (N), with a cell of margin.
BAY = dict(lat_min=40.45, lat_max=40.92, lon_min=13.80, lon_max=14.62)
# ERA5 box (N, W, S, E): wider, so the regime classifier sees the Tyrrhenian upwind.
ERA5_AREA = [41.25, 12.75, 40.25, 15.00]

YEARS = list(range(1985, 2027))
# 10 May - 2 Aug
DAYS = {5: range(10, 32), 6: range(1, 31), 7: range(1, 32), 8: range(1, 3)}
UTC_HOURS = [f"{h:02d}:00" for h in range(9, 16)]  # 11:00-17:00 CEST
HEIGHTS = ["15_m", "30_m", "50_m"]


REPO = Path(__file__).resolve().parents[2]


def cds_credentials() -> tuple[str, str] | None:
    """CDSAPI_URL / CDSAPI_KEY from the environment, else from the repo's .env.local
    (gitignored, where every other key of this project lives). None -> cdsapi falls
    back to ~/.cdsapirc."""
    url, key = os.environ.get("CDSAPI_URL"), os.environ.get("CDSAPI_KEY")
    env = REPO / ".env.local"
    if not key and env.exists():
        for line in env.read_text().splitlines():
            k, _, v = line.partition("=")
            v = v.strip().strip('"').strip("'")
            if k.strip() == "CDSAPI_KEY":
                key = v
            elif k.strip() == "CDSAPI_URL":
                url = v
    if not key:
        return None
    return (url or "https://cds.climate.copernicus.eu/api", key)


def client():
    import cdsapi

    cred = cds_credentials()
    if cred:
        return cdsapi.Client(url=cred[0], key=cred[1], quiet=True, progress=False)
    return cdsapi.Client(quiet=True, progress=False)


def days(month: int) -> list[str]:
    return [f"{d:02d}" for d in DAYS[month]]


# ---------------------------------------------------------------- requests
def cerra_requests(years):
    for y in years:
        for m in DAYS:
            common = {
                "variable": ["wind_speed", "wind_direction"],
                "height_level": HEIGHTS,
                "data_type": "reanalysis",
                "year": str(y), "month": f"{m:02d}", "day": days(m),
                # GRIB, not NetCDF: the same values bit for bit, 2.3 MB a field against 5.3
                "data_format": "grib",
            }
            yield ("cerra", f"{y}-{m:02d}-an", "reanalysis-cerra-height-levels",
                   {**common, "product_type": "analysis", "time": ["09:00", "12:00", "15:00"]},
                   len(days(m)) * 3 * 6)
            yield ("cerra", f"{y}-{m:02d}-fc", "reanalysis-cerra-height-levels",
                   {**common, "product_type": "forecast", "time": ["09:00", "12:00"],
                    "leadtime_hour": ["1", "2"]},
                   len(days(m)) * 4 * 6)


def lsm_request():
    yield ("lsm", "cerra-lsm", "reanalysis-cerra-single-levels",
           {"variable": ["land_sea_mask", "orography"], "level_type": "surface_or_atmosphere",
            "data_type": "reanalysis", "product_type": "analysis",
            "year": "2020", "month": "06", "day": "01", "time": "12:00",
            "data_format": "grib"}, 2)


def era5_requests(years):
    for y in years:
        for m in DAYS:
            yield ("era5", f"{y}-{m:02d}", "reanalysis-era5-single-levels",
                   {"product_type": ["reanalysis"],
                    "variable": ["10m_u_component_of_wind", "10m_v_component_of_wind",
                                 "100m_u_component_of_wind", "100m_v_component_of_wind",
                                 "10m_wind_gust_since_previous_post_processing",
                                 "2m_temperature", "2m_dewpoint_temperature",
                                 "sea_surface_temperature", "boundary_layer_height",
                                 "mean_sea_level_pressure", "total_cloud_cover",
                                 "land_sea_mask"],
                    "year": str(y), "month": f"{m:02d}", "day": days(m), "time": UTC_HOURS,
                    "area": ERA5_AREA, "data_format": "netcdf", "download_format": "unarchived"},
                   0)
            yield ("era5pl", f"{y}-{m:02d}", "reanalysis-era5-pressure-levels",
                   {"product_type": ["reanalysis"],
                    "variable": ["u_component_of_wind", "v_component_of_wind", "temperature"],
                    "pressure_level": ["850", "700"],
                    "year": str(y), "month": f"{m:02d}", "day": days(m),
                    "time": ["09:00", "12:00", "15:00"],
                    "area": ERA5_AREA, "data_format": "netcdf", "download_format": "unarchived"},
                   0)


# ---------------------------------------------------------------- processing
def open_files(path: Path, workdir: Path) -> list[Path]:
    """The CDS returns a bare GRIB/.nc or a zip of several; normalise to a list."""
    with open(path, "rb") as f:
        magic = f.read(4)
    if magic[:2] == b"PK":
        with zipfile.ZipFile(path) as z:
            z.extractall(workdir)
            return [workdir / n for n in z.namelist() if n.endswith((".nc", ".grib", ".grb"))]
    return [path]


def to_frame(nc: Path, crop: bool):
    import numpy as np
    import xarray as xr

    with open(nc, "rb") as f:
        grib = f.read(4) == b"GRIB"
    ds = (xr.open_dataset(nc, engine="cfgrib", backend_kwargs={"indexpath": ""}) if grib
          else xr.open_dataset(nc))
    lat = ds["latitude"]
    lon = ds["longitude"]
    lon = xr.where(lon > 180, lon - 360, lon)
    if crop and lat.ndim == 2:
        # CERRA: 2-D Lambert grid. Take the index rectangle that covers the box,
        # then keep the exact cells inside it.
        inside = ((lat >= BAY["lat_min"]) & (lat <= BAY["lat_max"])
                  & (lon >= BAY["lon_min"]) & (lon <= BAY["lon_max"]))
        if not bool(inside.any()):
            raise SystemExit(f"{nc.name}: no grid cell inside the bay box -- check lat/lon names")
        ydim, xdim = lat.dims
        iy = np.where(inside.any(dim=xdim).values)[0]
        ix = np.where(inside.any(dim=ydim).values)[0]
        ds = ds.isel({ydim: slice(iy.min(), iy.max() + 1), xdim: slice(ix.min(), ix.max() + 1)})
        ds = ds.assign_coords(iy=(ydim, np.arange(iy.min(), iy.max() + 1)),
                              ix=(xdim, np.arange(ix.min(), ix.max() + 1)))
    df = ds.to_dataframe().reset_index()
    # Keep a stable valid-time column whatever the converter called it.
    if "valid_time" not in df.columns:
        if "time" in df.columns and "step" in df.columns:
            df["valid_time"] = df["time"] + df["step"]
        elif "time" in df.columns:
            df["valid_time"] = df["time"]
    drop = [c for c in ("number", "expver", "surface", "x", "y") if c in df.columns]
    return df.drop(columns=drop)


def process(raw: Path, out: Path, crop: bool):
    import pandas as pd

    with tempfile.TemporaryDirectory(dir=raw.parent) as td:
        frames = [to_frame(p, crop) for p in open_files(raw, Path(td))]
    if len(frames) == 1:
        df = frames[0]
    else:
        # ERA5 single levels come back as a zip of two files (instant + the gust's
        # accumulation stream) holding DIFFERENT variables for the same hours and
        # cells: join them, never stack them, or every hour appears twice, half-empty.
        keys = [c for c in ("valid_time", "pressure_level", "latitude", "longitude", "iy", "ix",
                            "heightAboveGround") if all(c in f.columns for f in frames)]
        df = frames[0]
        for f in frames[1:]:
            f = f.drop(columns=[c for c in f.columns if c in df.columns and c not in keys])
            df = df.merge(f, on=keys, how="outer")
    hcol = next((c for c in ("heightAboveGround", "height", "height_above_ground") if c in df.columns), None)
    if hcol:
        # wide: one row per (valid_time, cell), each variable per height (ws15, ws30, wdir30 ...)
        df = df.rename(columns={hcol: "heightAboveGround"})
        keys = [c for c in ("valid_time", "iy", "ix", "latitude", "longitude") if c in df.columns]
        skip = set(keys) | {"heightAboveGround", "time", "step", "forecast_reference_time"}
        vals = [c for c in df.columns if c not in skip and df[c].dtype.kind == "f"]
        df = df.pivot_table(index=keys, columns="heightAboveGround", values=vals).reset_index()
        df.columns = [f"{a}{int(b)}" if b != "" else a for a, b in df.columns]
    if "iy" in df.columns:
        import numpy as np
        # CERRA's GRIB says "Degree true" AND uvRelativeToGrid=1. If the second is
        # right, true = wdir + gridrot (Lambert, Latin 50, LoV 8 E: ~4.7 deg at
        # Naples). Kept as a column so the N72 TWD check decides, not this script.
        df["gridrot"] = np.degrees(np.sin(np.radians(50.0)) * np.radians(df["longitude"] - 8.0))
    tmp = out.with_suffix(".tmp.gz")
    df.to_csv(tmp, index=False, compression="gzip", float_format="%.3f")
    tmp.rename(out)
    raw.unlink()
    return len(df)


def fetch_one(req, out_root: Path, write: bool):
    ds_key, name, dataset, body, _ = req
    out = out_root / ds_key / f"{name}.csv.gz"
    if out.exists():
        return f"skip  {ds_key}/{name} (exists)"
    if not write:
        return f"would {ds_key}/{name}  <- {dataset}"
    out.parent.mkdir(parents=True, exist_ok=True)
    raw = out.parent / f".{name}.download"
    client().retrieve(dataset, body).download(str(raw))
    mb = raw.stat().st_size / 1e6
    n = process(raw, out, crop=ds_key in ("cerra", "lsm"))
    return f"done  {ds_key}/{name}: {mb:.0f} MB downloaded -> {n} rows kept"


# ---------------------------------------------------------------- CLI
def parse_years(s: str | None):
    if not s:
        return YEARS
    a, _, b = s.partition("-")
    return list(range(int(a), int(b or a) + 1))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("what", choices=["check", "plan", "cerra", "era5", "all"])
    ap.add_argument("--years", help="e.g. 2024-2026 (default 1985-2026)")
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    ap.add_argument("--jobs", type=int, default=3, help="parallel CDS requests (default 3)")
    ap.add_argument("--write", action="store_true", help="actually download")
    a = ap.parse_args()
    years = parse_years(a.years)

    if a.what == "check":
        if not cds_credentials() and not (Path.home() / ".cdsapirc").exists():
            sys.exit("No CDS key: put CDSAPI_KEY in .env.local (or ~/.cdsapirc) first.")
        print("key from", "env / .env.local" if cds_credentials() else "~/.cdsapirc")
        reqs = list(lsm_request()) + [next(era5_requests([2025]))]
        reqs[1] = ("check", "era5-one-hour", reqs[1][2],
                   {**reqs[1][3], "month": "07", "day": ["01"], "time": ["12:00"]}, 0)
        for r in reqs:
            print(fetch_one(r, a.out, write=True))
        print("CDS key and both licences work.")
        return

    reqs = []
    if a.what in ("cerra", "all", "plan"):
        reqs += list(lsm_request()) + list(cerra_requests(years))
    if a.what in ("era5", "all", "plan"):
        reqs += list(era5_requests(years))

    if a.what == "plan":
        cerra_fields = sum(r[4] for r in reqs if r[0] == "cerra")
        print(f"years {years[0]}-{years[-1]}, 10 May-2 Aug, 09-15 UTC (11-17 local)")
        print(f"{len(reqs)} requests; CERRA {cerra_fields:,} full-domain fields "
              f"(~{cerra_fields * 2.3 / 1000:,.0f} GB passes through, ~2 GB kept at most at once)")
        done = sum((a.out / r[0] / f"{r[1]}.csv.gz").exists() for r in reqs)
        print(f"{done} already on disk in {a.out}")
        return

    print(f"{len(reqs)} requests -> {a.out}  ({'WRITE' if a.write else 'dry run, add --write'})")
    if not a.write:
        for r in reqs[:6]:
            print(fetch_one(r, a.out, False))
        print("  ...")
        return
    free = shutil.disk_usage(a.out.parent if a.out.parent.exists() else Path.home()).free / 1e9
    if free < 10:
        sys.exit(f"only {free:.0f} GB free; each CERRA month passes ~1-1.5 GB through disk")
    with cf.ThreadPoolExecutor(max_workers=a.jobs) as ex:
        futs = {ex.submit(fetch_one, r, a.out, True): r for r in reqs}
        for f in cf.as_completed(futs):
            r = futs[f]
            try:
                print(f.result(), flush=True)
            except Exception as e:  # keep going; a rerun retries only what failed
                print(f"FAIL  {r[0]}/{r[1]}: {e}", flush=True)


if __name__ == "__main__":
    main()
