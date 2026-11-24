#!/usr/bin/env python3
"""
ERA5 for a weather-routing climatology: one race window, N years, one box.

For every year in --years, fetches the hourly ERA5 single-level fields from
(start date - 1 day) to (start date + --days) over the course's box, and writes
them as a flat float32 file the TypeScript router reads directly:

    <out>/era5/<YYYY>.json   header: grid, times, variable order
    <out>/era5/<YYYY>.bin    float32 little-endian, [var][time][lat asc][lon asc]
    <out>/land.json/.bin     uint8 land mask at --land-res deg (default 0.01 = ~0.6 nm)

VARIABLES. The router needs 10 m and 100 m wind (the masthead lies BETWEEN them,
so the lift is an interpolation of the model's own shear). The rest is for the
boundary-layer step and costs little: 2 m T and SST (air-sea stability), 2 m
dewpoint and surface pressure (virtual temperature), BLH, friction velocity,
sensible heat flux, Charnock (ERA5's wave-coupled roughness), and the NEUTRAL
10 m wind, whose difference from the real 10 m wind is the model's own stability
flag. ~15 fields x 24 h x (days+2) per request: well inside the CDS item cap,
and cropping with `area` does not reduce the item count, so asking for the box
costs the same as asking for less of it.

ONE REQUEST PER (YEAR, MONTH): a window that crosses a month end becomes two
requests, because the CDS takes year/month/day as a cartesian product and one
request for 28 Oct - 3 Nov would fetch 28-31 AND 1-3 of BOTH months.

Dry run by default (prints the plan); --write fetches. A year whose .bin exists is
skipped, so an interrupted run restarts where it stopped. Key: CDSAPI_KEY in the
repo's .env.local (as the Naples fetcher), else ~/.cdsapirc.

  python scripts/routing/era5_fetch.py --gpx ~/Downloads/msr.gpx --start 2026-10-17 --days 6 \
      --years 2006-2025 --out ~/routing/msr
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import sys
import tempfile
import zipfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]

# (CDS request name, candidate short names in the returned NetCDF, our key)
VARS = [
    ("10m_u_component_of_wind", ["u10"], "u10"),
    ("10m_v_component_of_wind", ["v10"], "v10"),
    ("100m_u_component_of_wind", ["u100"], "u100"),
    ("100m_v_component_of_wind", ["v100"], "v100"),
    ("2m_temperature", ["t2m"], "t2m"),
    ("sea_surface_temperature", ["sst"], "sst"),
    ("2m_dewpoint_temperature", ["d2m"], "d2m"),
    ("surface_pressure", ["sp"], "sp"),
    ("boundary_layer_height", ["blh"], "blh"),
    ("friction_velocity", ["zust"], "zust"),
    ("instantaneous_surface_sensible_heat_flux", ["ishf"], "ishf"),
    ("charnock", ["chnk", "cha"], "chnk"),
    ("10m_u_component_of_neutral_wind", ["u10n"], "u10n"),
    ("10m_v_component_of_neutral_wind", ["v10n"], "v10n"),
]
MINIMAL = {"u10", "v10", "u100", "v100", "t2m", "sst"}


def cds_client():
    import cdsapi

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
    if key:
        return cdsapi.Client(url=url or "https://cds.climate.copernicus.eu/api", key=key, quiet=True, progress=False)
    return cdsapi.Client(quiet=True, progress=False)


def gpx_box(path: Path, pad_deg: float | None):
    text = path.read_text(errors="replace")
    pts = []
    for m in re.finditer(r'<(?:rtept|wpt|trkpt)\b([^>]*)>', text):
        a = m.group(1)
        la = re.search(r'\blat\s*=\s*"([^"]+)"', a)
        lo = re.search(r'\blon\s*=\s*"([^"]+)"', a)
        if la and lo:
            pts.append((float(la.group(1)), float(lo.group(1))))
    if len(pts) < 2:
        raise SystemExit(f"{path}: fewer than two points")
    lats = [p[0] for p in pts]
    lons = [p[1] for p in pts]
    ext = max(max(lats) - min(lats), max(lons) - min(lons))
    # A route goes round things; the box must leave room for the router to.
    pad = pad_deg if pad_deg is not None else max(1.0, 0.25 * ext)
    snap = lambda x, f: f(x * 4) / 4  # noqa: E731  -- onto the 0.25 deg grid
    import math
    return [snap(max(lats) + pad, math.ceil), snap(min(lons) - pad, math.floor),
            snap(min(lats) - pad, math.floor), snap(max(lons) + pad, math.ceil)]


def windows(start: dt.date, days: int, years: list[int]):
    """Per year: the dates from start-1 to start+days, grouped by month."""
    for y in years:
        try:
            s = start.replace(year=y)
        except ValueError:  # 29 Feb
            s = start.replace(year=y, day=28)
        dates = [s + dt.timedelta(days=d) for d in range(-1, days + 1)]
        by_month: dict[tuple[int, int], list[int]] = {}
        for d in dates:
            by_month.setdefault((d.year, d.month), []).append(d.day)
        yield y, dates, by_month


def fetch_year(c, year, by_month, area, varset, tmp: Path) -> list[list[Path]]:
    """One list of files per month: a month may come back as several streams."""
    months = []
    for (yy, mm), dd in sorted(by_month.items()):
        target = tmp / f"{yy}-{mm:02d}.dl"
        c.retrieve("reanalysis-era5-single-levels", {
            "product_type": ["reanalysis"],
            "variable": [v[0] for v in VARS if v[2] in varset],
            "year": [str(yy)], "month": [f"{mm:02d}"], "day": [f"{d:02d}" for d in dd],
            "time": [f"{h:02d}:00" for h in range(24)],
            "area": area, "data_format": "netcdf", "download_format": "unarchived",
        }).download(str(target))
        with open(target, "rb") as f:
            magic = f.read(2)
        if magic == b"PK":
            with zipfile.ZipFile(target) as z:
                z.extractall(tmp / f"{yy}-{mm:02d}")
                months.append([tmp / f"{yy}-{mm:02d}" / n for n in z.namelist() if n.endswith(".nc")])
        else:
            months.append([target])
    return months


def write_year(months: list[list[Path]], out: Path, year: int, varset):
    import numpy as np
    import xarray as xr

    dss = [xr.open_dataset(f) for m in months for f in m]
    # Streams of one month are MERGED (different variables, same hours); months
    # are CONCATENATED (same variables, different hours). Merging months would
    # keep the first month's values and fill the rest with NaN.
    per_month, k = [], 0
    for m in months:
        per_month.append(xr.merge(dss[k:k + len(m)], compat="no_conflicts"))
        k += len(m)
    tname = "valid_time" if "valid_time" in per_month[0].dims else "time"
    ds = xr.concat(per_month, dim=tname, data_vars="all") if len(per_month) > 1 else per_month[0]
    ds = ds.sortby(tname).sortby("latitude").sortby("longitude")
    if "expver" in ds.dims:  # ERA5 + ERA5T mixed: take whichever is present
        ds = ds.max("expver")
    times = ds[tname].values.astype("datetime64[ms]").astype("int64")
    lat = ds["latitude"].values
    lon = ds["longitude"].values
    keys, arrays, missing = [], [], []
    for _, cands, key in VARS:
        if key not in varset:
            continue
        name = next((n for n in cands if n in ds.variables), None)
        if name is None:
            missing.append(key)
            continue
        a = ds[name].transpose(tname, "latitude", "longitude").values.astype("<f4")
        keys.append(key)
        arrays.append(a)
    if missing:
        print(f"  {year}: not in the file: {', '.join(missing)}", file=sys.stderr)
    dtms = np.diff(times)
    if len(dtms) and not np.all(dtms == 3600_000):
        raise SystemExit(f"{year}: times are not a regular hourly series")
    hdr = {
        "year": year, "vars": keys,
        "lat0": float(lat[0]), "dLat": float(lat[1] - lat[0]), "nLat": int(len(lat)),
        "lon0": float(lon[0]), "dLon": float(lon[1] - lon[0]), "nLon": int(len(lon)),
        "t0": int(times[0]), "dtMs": 3600_000, "nT": int(len(times)),
        "source": "ERA5 single levels (C3S CDS)",
    }
    (out / f"{year}.bin").write_bytes(b"".join(a.tobytes() for a in arrays))
    (out / f"{year}.json").write_text(json.dumps(hdr, indent=1))
    for d in dss:
        d.close()


def write_land(out: Path, area, res: float):
    import numpy as np
    from global_land_mask import globe

    n, w, s, e = area
    lat = np.arange(s, n + res / 2, res)
    lon = np.arange(w, e + res / 2, res)
    LON, LAT = np.meshgrid(lon, lat)
    m = globe.is_land(LAT, LON).astype("u1")
    (out / "land.bin").write_bytes(m.tobytes())
    (out / "land.json").write_text(json.dumps({
        "lat0": float(lat[0]), "dLat": res, "nLat": int(len(lat)),
        "lon0": float(lon[0]), "dLon": res, "nLon": int(len(lon)),
        "source": "global_land_mask (GLOBE 1 km)",
    }, indent=1))
    print(f"land mask {len(lat)}x{len(lon)} at {res} deg, {m.mean() * 100:.1f} % land")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--gpx", type=Path, help="course; its box (padded) is the area")
    ap.add_argument("--area", type=float, nargs=4, metavar=("N", "W", "S", "E"))
    ap.add_argument("--pad", type=float, default=None, help="deg round the course (default max(1, 25%% of extent))")
    ap.add_argument("--start", required=True, help="race start date, YYYY-MM-DD (the year is ignored)")
    ap.add_argument("--days", type=int, required=True, help="longest race to allow for, days")
    ap.add_argument("--years", default="2006-2025")
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--minimal", action="store_true", help="wind + t2m + sst only")
    ap.add_argument("--land-res", type=float, default=0.01)
    ap.add_argument("--write", action="store_true")
    a = ap.parse_args()

    area = a.area or (gpx_box(a.gpx, a.pad) if a.gpx else None)
    if not area:
        raise SystemExit("give --gpx or --area")
    y0, _, y1 = a.years.partition("-")
    years = list(range(int(y0), int(y1 or y0) + 1))
    start = dt.date.fromisoformat(a.start)
    varset = MINIMAL if a.minimal else {v[2] for v in VARS}
    nlat = round((area[0] - area[2]) / 0.25) + 1
    nlon = round((area[3] - area[1]) / 0.25) + 1
    hours = 24 * (a.days + 2)
    mb = nlat * nlon * hours * len(varset) * 4 / 1e6
    print(f"area N{area[0]} W{area[1]} S{area[2]} E{area[3]}: {nlat}x{nlon} cells, "
          f"{hours} h/yr, {len(varset)} fields -> {mb:.0f} MB/yr, {mb * len(years) / 1e3:.2f} GB for {len(years)} years")

    out = a.out.expanduser()
    era = out / "era5"
    todo = [w for w in windows(start, a.days, years) if not (era / f"{w[0]}.bin").exists()]
    for y, dates, by_month in todo:
        print(f"  {y}: {dates[0]} .. {dates[-1]}  ({len(by_month)} request{'s' if len(by_month) > 1 else ''})")
    if not a.write:
        print("dry run -- add --write to fetch")
        return
    era.mkdir(parents=True, exist_ok=True)
    (out / "fetch.json").write_text(json.dumps({"area": area, "start": a.start, "days": a.days, "years": years,
                                                 "vars": sorted(varset)}, indent=1))
    if not (out / "land.bin").exists():
        write_land(out, area, a.land_res)
    c = cds_client()
    for y, _, by_month in todo:
        with tempfile.TemporaryDirectory() as td:
            files = fetch_year(c, y, by_month, area, varset, Path(td))
            write_year(files, era, y, varset)
        print(f"  {y}: written")


if __name__ == "__main__":
    main()
