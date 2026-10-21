# San Juan Islands — SSA-Race domain setup

**Status:** build note + research · 21 Oct 2026 · domains `san_juan_islands_2km` / `_1km`
**Brief:** clone the Cowes/Solent pair onto 48.5627 N, 122.8946 W; same initialisation, physics,
resolution and size; same integration into SSA.

Everything below that states a fact about ExtPar or DWD was **read from the source or measured
against the live service**, not assumed — two of the existing configs carry comments that turn out
to be wrong, and the whole point of this note is not to inherit them.

---

## 1. What is built

| | `san_juan_islands_2km` | `san_juan_islands_1km` |
|---|---|---|
| ICON grid | R19B07, ~2.05 km | R19B08, ~1.02 km |
| Centre | 48.5627 N, −122.8946 E | same |
| Half-width | 0.90 lat × **1.15** lon | 0.45 lat × **0.43** lon |
| Footprint | ~169 × 200 km | ~63 × 100 km |
| Namelist | **byte-identical to `solent_2km`** once the name is normalised | **byte-identical to `solent_1km`** |

The lon half-widths are *not* Cowes' 1.20/0.45. A degree of longitude is longer at 48.56 N than at
50.76 N, so matching the **ground footprint** — which is what "same size" means for a weather
domain — needs ×cos(50.76)/cos(48.56) = 0.9555.

The namelists being byte-identical is the point: the physics, the 63/76-level SLEVE vertical grids,
the timestep and the nudging zones are the ones Cowes runs, not a re-derivation of them.

**The pin is not Seattle.** 48.5627 N / 122.8946 W is in the San Juan Islands, ~120 km north of the
city. The 2 km domain's southern edge is 47.6627 N; Seattle city is at 47.6062 N, i.e. **6 km
outside it** before the relaxation zone is counted. `sanJuanVenue.test.ts` pins that so nothing
later claims the venue covers the city.

---

## 2. The Zonda JSON — paste these

Both files are on the box, each with the issue title and body already written:

```bash
ssh regatta 'sudo cat /opt/regatta-nwp/domains/san_juan_islands_2km/grid/ZONDA_ISSUE_san_juan_islands_2km.md'
ssh regatta 'sudo cat /opt/regatta-nwp/domains/san_juan_islands_1km/grid/ZONDA_ISSUE_san_juan_islands_1km.md'
```

Each goes into a new issue at `github.com/C2SM/zonda-request` (template `data_request.md`). The
2 km request body is:

```json
{
  "zonda": { "request_name": "san_juan_islands_2km", "backend_tag": "v2.1",
             "icontools_tag": "latest", "extpar_tag": "latest" },
  "globals": { "keep_basegrid_files": false, "grid_root": 19, "grid_level": 7,
               "icorotation": 0, "icopole_lat": 90, "icopole_lon": 0,
               "centre": 215, "subcentre": 0 },
  "domains": [{
    "domain_id": 1,
    "icontools": { "parent_id": 0, "region_type": 3,
                   "center_lat": 48.5627, "center_lon": -122.8946,
                   "hwidth_lat": 0.9, "hwidth_lon": 1.15,
                   "lrotate": false, "pole_lat": 90, "pole_lon": -180 },
    "extpar": { "use_array_cache": false, "iaot_type": 1, "ilu_type": 1, "ialb_type": 1,
                "isoil_type": 3, "itopo_type": 3, "it_cl_type": 1, "iera_type": 1,
                "iemiss_type": 1, "lradtopo": false, "enable_cdnc": false,
                "enable_edgar": false, "radtopo_radius": 40000, "nhori": 24,
                "enable_art": false, "l_terra_urb": false,
                "l_use_corine": false, "infill_corine": false,
                "ilookup_table_lu": 1, "tcorr_lapse_rate": 0.0065, "tcorr_offset": 0 },
    "extpar_plots": [{ "variable_name": "topography_c" }]
  }]
}
```

The 1 km request is the same with `grid_level: 8`, `hwidth_lat: 0.45`, `hwidth_lon: 0.43`.

**One deliberate change from the Cowes recipe: `l_use_corine` and `infill_corine` are `false`.**
CORINE is European and has no data over Washington State. ExtPar's own consistency check
(`mo_landuse_routines.f90`) only accepts CORINE as an overlay on GLOBCOVER, so with `ilu_type = 1`
land use falls back cleanly to GLOBCOVER 2009 alone (~300 m, global). Left `true` it would at best
be ignored and at worst produce empty land use — which sets **roughness**, and therefore the whole
surface layer.

---

## 3. Terrain — the research, and why the answer is still MERIT

### What the options actually are

From `src/mo_topo_data.f90` in `C2SM/extpar` — not from the config comments, which disagree with
each other:

| `itopo_type` | Constant | Dataset | Resolution | Coverage |
|---|---|---|---|---|
| 1 | `topo_gl` | GLOBE | ~1 km | global |
| 2 | `topo_aster` | ASTER GDEM | ~30 m | 83 N–83 S |
| 3 | `topo_merit` | MERIT | ~90 m | 90 N–60 S |

There is **no Copernicus GLO-30 option in ExtPar.** `domains/riviera_2km/extpar/extpar_riviera_2km.config`
comments `itopo_type = 3` as "Copernicus / GLO-30 class DEM"; the Solent config comments the same
value as "MERIT/REMA (~90 m)". The Solent one is right. Worth correcting in the Riviera config so
it stops misleading the next reader — flagged, not changed, since it does not alter behaviour.

### Why not ASTER, given "high-res terrain is important"

Because at these grid spacings the DEM is not the limiting factor:

- A **1 km** ICON cell averages roughly **120 MERIT pixels**; a 2 km cell about 500. MERIT at 90 m
  already oversamples the target grid by two orders of magnitude. Going to 30 m multiplies the
  sample count, not the information the model can hold.
- **ASTER is nominally finer but measurably dirtier.** Validation work on GDEM reports residual
  cloud patterns, stripe artefacts and lake anomalies, with vertical accuracy around 15 m against
  ~6 m for SRTM-class data; GDEM2 reduced voids "at the cost of some added noise". ASTER is also a
  *surface* model — canopy included. MERIT exists specifically because those errors were removed:
  speckle, stripes, absolute bias and tree-height bias.
- That noise is not harmless here. The DEM feeds the **sub-grid orography statistics** the SSO drag
  scheme uses, and the SSA 2 km domains run SSO **on**. Noise inflates the sub-grid standard
  deviation and so the drag — a fake terrain signal, not a sharper one.

**So: `itopo_type = 3` (MERIT) on both, matching Cowes.** ASTER is the right lever for a 500 m nest,
which is already this project's written convention ("ASTER 30 m reserved for 500 m nests").

### What *does* limit terrain fidelity here, and it is worth knowing

The San Juans are the harder case Cowes is not. Mount Constitution on Orcas is **734 m** against the
Isle of Wight's 241 m, and the islands are small and fragmented — Shaw is ~20 km². At 1 km spacing a
whole island is a handful of cells, and the differential heating of those islands is precisely what
drives the local sea breeze. The constraint is **grid spacing and the land–sea mask**, not the DEM.
If the forecast turns out to miss the island-scale breeze, the fix is a **500 m nest with ASTER**,
not a finer DEM at 1 km.

One further lever, flagged rather than taken: **`lradtopo` is `false`** in the Cowes recipe and so
here. It switches on topographic shading (horizon/skyview; `nhori = 24` and `radtopo_radius = 40000`
are already set). On steep islands shading changes the differential heating that drives the breeze,
so it is a real candidate — but it changes physics relative to Cowes, so it should be an A/B, not a
silent default.

---

## 4. Initialisation — the blocker, measured

**Cowes' initialisation cannot be reused.** The box is driven by ICON-EU:

```
ICON-EU grid (read from the live GRIB): lon −23.50 .. 62.50,  lat 29.50 .. 70.50
San Juan Islands:                       lon −122.89           → 99.4° west of the western edge
```

The obvious substitute is **ICON global** from the same DWD feed: same model family, same
`init_mode = 7` path, and EU-sourced, which matters because this project has an explicit
sovereignty policy (README: *"Data: DWD, Copernicus, ISRIC, ESA — all European"*, and *"not
AWS/Azure/GCP even in EU regions"*). That policy rules out GFS on its own terms.

But global ICON does not fit this box, and the numbers are not close:

| | ICON-EU | ICON global | ratio |
|---|---|---|---|
| One model-level file (U, step 000) | 914,453 B | **3,537,302 B** | **3.87×** |
| Model levels | 60 | **120** | 2× |
| Published grid | regular lat-lon | **icosahedral only** (0 regular-lat-lon files in the global `u/` directory) | — |
| Daily fetch | 20 GB, 26,693 files | **~150 GB** | ~7.7× |

Against **50 GB free on `/data`** and a fetch that already takes 10 minutes at 16 workers. Roughly
3× over on disk, and ~77 minutes of fetch would eat the morning window on its own. Icosahedral also
means `preprocess_cdo.sh` needs the 937 MB R03B07 grid description plus remap weights — a new
preprocessing path, not a parameter change.

### Verified 21 Oct: ECMWF open data is NOT usable here

Checked rather than assumed, and it fails on one specific thing: **ECMWF open data publishes no
model levels.** It carries 14 pressure levels — 1000, 925, 850, 700, 600, 500, 400, 300, 250, 200,
150, 100, 50, 10 hPa — plus surface/single-level and 4 soil layers. Between the surface and 850 hPa
there are exactly **two** levels. For a venue whose entire forecast problem is the lowest 100 m,
that cannot initialise a convection-permitting LAM. (0.25°, with 0.1° added 20 Oct 2026; CC-BY-4.0;
GRIB2; rolling 12 runs.) It is excellent for POINT forecasts — which is precisely how Open-Meteo
already uses it in SSA — just not as driving data.

### Verified 21 Oct: HRRR is the better US answer, and it reframes the design

| | value |
|---|---|
| Resolution | **3 km, convection-permitting, hourly data assimilation** |
| Covers the venue? | **Yes** — Open-Meteo's `gfs_hrrr` returns 24/24 non-null hours at 48.5627/−122.8946, elevation 0.0 (a water cell) |
| Vertical | **native hybrid levels** (`wrfnat`), i.e. the full PBL structure ECMWF open data lacks |
| Volume | 651 MB/hour; +18 h ≈ **12 GB**, which fits the 50 GB free — and `.idx` files allow byte-range subsetting to cut it much further |
| Cost | free, no key, on AWS NODD |

**The consequence is that the 2 km domain may not be needed at all.** In the Med the 2 km parent
exists because the best public model is 7–13 km. In the US it is not:

```
Med:  ICON-EU 7 km  ->  our 2 km  ->  our 1 km
US:   HRRR 3 km (free, hourly, radar-assimilating)  ------>  our 1 km
```

That removes the 150 GB problem, halves the compute, and starts from better data than we could
produce ourselves at 2 km from a 13 km global model.

**Two honest caveats.** HRRR is NOAA — US-sourced, against the README's EU-sovereignty policy. For a
US venue that is a judgement call rather than a breach, but it is the user's call, not mine. And
NOAA is mid-transition to **RRFS**: the dates in circulation disagree (31 Aug vs early Oct 2026) and
NOAA says HRRR "will remain in operations" while one source says RRFS eventually replaces it with no
date. RRFS is also 3 km over North America, so the successor is equivalent — but the fetch would
need re-pointing.

**The engineering risk in option B is real:** ICON-LAM is normally initialised from ICON or IFS.
HRRR is WRF-ARW on a Lambert grid with hybrid sigma levels, and getting that into `init_mode = 7`
is not a parameter change — it is a new preprocessing path. The alternative, running WRF for this
venue because HRRR *is* WRF and the nesting is native, means a second model stack to maintain, which
cuts against everything else SSA has built.

### So, three options

| | Driving data | Volume | Keeps the ICON chain? | Risk |
|---|---|---|---|---|
| **A** | ICON global, +18 h, more disk | ~65 GB | yes | icosahedral remap work; needs a bigger `/data` |
| **B** | HRRR → our 1 km | ~12 GB | yes, but a NEW init path | HRRR→ICON initialisation is non-standard |
| **C** | **None — use HRRR via Open-Meteo, which already works** | 0 | n/a | none |

**Start with C.** SSA already ingests HRRR, so there are 3 km forecasts for this venue *today* with
no box work at all. The only thing our own nest adds is 1 km island-scale resolution — and whether
that is needed is an empirical question that C answers for free. Build the chain once HRRR has been
shown to miss the island-scale breeze, not before.

**So I have not shipped a `fetch_icon_global.sh`.** Writing a production fetcher that cannot run
here would be worse than saying so. The realistic options, in the order I would consider them:

1. **ECMWF open data IFS 0.25°** — global, regular lat-lon, EU-sourced (so the sovereignty policy
   holds), and perhaps an order of magnitude smaller than global ICON. ICON ingests IFS through its
   own init path. *Needs verifying:* I could not enumerate `data.ecmwf.int` from here, so volume and
   field availability are unconfirmed.
2. **ICON global with a short lead** — +12/+18 h instead of +42 h cuts the volume ~2.3×, to ~65 GB.
   Still over, but a bigger `/data` makes it feasible, and it keeps the model family identical.
3. **More disk.** The cheapest change if ICON global is wanted as-is.

This is the decision that gates everything else: **do not request the grids until the driving data
is settled**, or the grids will arrive with nothing to run on.

---

## 5. Two more gaps the venue inherits

**SST has no Pacific product.** `fetch_cmems_sst.sh` offers `med`, `atl` (IFREMER Atlantic) and
`channel` (AMM15) — all European. This project's own setup doc calls SST *"the single biggest
sea-breeze lever"*, and for an island archipelago whose forecast problem is thermally driven that is
not a detail. A global CMEMS L4 product is needed; the README's sovereignty note explicitly prefers
Mercator/IFREMER over OSTIA, so pick accordingly.

**Tidal currents do not cover it either.** The currents product is AMM15, English Channel only
(`currentsCovered()` gates on that). The San Juans have genuinely strong tidal streams, so this is a
real absence for racing there — a separate piece of work, not a configuration flag.

---

## 6. Checklist

- [x] Domains created, namelists verified byte-identical to Cowes
- [x] Zonda requests written, CORINE disabled with the ExtPar source checked
- [x] App venues registered on both resolutions, test pinned
- [ ] **Decide the driving data** (§4) — gates everything below
- [ ] Submit the two Zonda requests; place `.nc` into `grid/` and `extpar/`
- [ ] Pacific SST product chosen and wired into `fetch_cmems_sst.sh`
- [ ] `NESTS` / `DOMAINS` / `EVENT_VENUE` set in `.env` when the event approaches
- [ ] Confirm `z_mc` after grid generation (the project's standing post-grid check)
