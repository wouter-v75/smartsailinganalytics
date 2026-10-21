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

### Verified 21 Oct: ICON global IS affordable, if we stop retaining it

The 150 GB figure assumed we take everything and keep it. Checked against the live server, neither
has to be true. There is no server-side subsetting (no filter service, and zero regular-lat-lon
files anywhere in the global tree — both checked), but DWD already splits every field by
**variable x level x step**, and that split *is* the subsetting API:

| Lever | Saving | Why it is safe |
|---|---|---|
| **Steps** | **~56%** | The nest runs +18 h (that is what `solent_1km` does), not +42 h. 19 hourly BC steps instead of 43. |
| **Levels** | ~30% | The LAM top is `top_height = 21000`. ICON global's top is 75 km, so every level above 21 km is fetched and discarded. The exact cut is readable from the HHL files. |
| **Variables** | ~20%, optional | `qr`/`qs` could be dropped at the cost of a little spin-up. Riskiest of the three; take it last. |

**But the real unlock is not a lever, it is the order of operations.** The pipeline currently
fetches everything, *then* preprocesses. Stream it instead — per file: download, decompress, remap
onto the LAM box, append, delete:

```
  for each (var, level, step):  GET -> bunzip2 -> cdo remap -> append -> rm
```

Peak disk becomes a handful of 3.5 MB files plus the remapped output, and the remapped output for a
170 x 200 km box at 13 km is trivially small. **Disk stops being the constraint at all** — the
50 GB free becomes irrelevant, and the only question left is transfer TIME.

Which is measurable, and already measured: this box pulls **ICON-EU's 20 GB in 10 minutes**, i.e.
~2 GB/min. So:

| | volume | transferred in |
|---|---|---|
| Naive (everything, +42 h) | ~150 GB | ~75 min |
| **+18 h only** | **~66 GB** | **~33 min** |
| +18 h and levels trimmed | ~46 GB | ~23 min |

A 03:15 start finishing the fetch by ~03:50 is inside the existing morning window. One-off cost: the
remap weights, computed once from the 937 MB R03B07 grid description and reused thereafter.

**So option A is no longer "needs more disk".** It is "restructure the fetch to stream, and trim to
the lead we actually run" — which is work, but ordinary work, on the chain we already have.

The one thing that cannot be recovered is the SPATIAL waste: each GRIB message is a single global
field, so we download the planet to use a 170 x 200 km box. HRRR avoids this with `.idx` byte
ranges; DWD publishes none, and the `.bz2` is whole-file compressed so HTTP ranges do not help
either. That is the price of staying on ICON, and at ~33 min it is affordable.

### So, three options

| | Driving data | Volume | Keeps the ICON chain? | Risk |
|---|---|---|---|---|
| **A** | ICON global, +18 h, **streamed** | ~66 GB transferred, **<1 GB on disk** | yes | icosahedral remap work; ~33 min fetch |
| **B** | HRRR → our 1 km | ~12 GB | yes, but a NEW init path | HRRR→ICON initialisation is non-standard |
| **C** | **None — use HRRR via Open-Meteo, which already works** | 0 | n/a | none |

**A is now genuinely viable** — the disk objection is gone and the fetch fits the window. It keeps
one model family, one preprocessing chain and the EU-sovereignty policy intact, which B does not.

**Start with C anyway.** SSA already ingests HRRR, so there are 3 km forecasts for this venue *today* with
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

## 4b. Which ICON global run, to be ready by 09:30 local

**Measured, not estimated.** ICON global publication times off the live server (Last-Modified),
and the compute off Cowes' own August runs — `solent_2km`/`solent_1km` ran 1-8 Aug and San Juan is
the same footprint, resolution and namelist, so nothing has to be scaled.

| | measured |
|---|---|
| ICON global step 000 published | **cycle + 2h41** (00z 02:41:07, 12z 14:40:34) |
| ICON global complete to +24 h | **cycle + 3h14** (00z 03:13:37, 12z 15:14:56) |
| IC/BC preprocess | **3m 27s** (Cowes, 3 days, +/-2s) |
| `solent_2km` +42 h, 7 ranks | **38m 10s** (38:02 / 38:14 on the other two days) |
| nest IC/BC | **10s** |
| `solent_1km` +18 h, 7 ranks | **45m 13s** (44:57 / 45:28) |

Chain for San Juan is the **Sardinia split**, not a short parent run: phase A of the 2 km to
`SPLITLEAD`, then the 1 km nest, then the 2 km TAIL afterwards. Porto Cervo on 12 Sept:

```
  03:29:10  phase A (+22 h of 42)
  04:05:58  phase A finished — nest can start
  04:06:11  2 km PUBLISHED EARLY at +22 h (full outlook follows)
  05:03:43  1 km nest delivered (+18 h)
```

`SPLITLEAD = 22`, and the 22 is deliberate: the comment in `daily_pipeline.sh` records that the nest
needs +21 h, so 20 aborts it with "LATBC file not found" *after* the parent has already run. BC must
also reach ~2 h beyond that, because ICON's async latbc prefetcher reads ahead — so **BCLEAD 24**,
25 steps, not 22.

That is the correction to my first pass: I had the parent at +21 h with no margin and BC at 22
steps, which is the configuration that was already proven to break.

### The level cut, measured

ICON global half-level heights, read off the published HHL files (`grib_get -p average`):

| half-level | height | |
|---|---|---|
| 1 | 75,000 m | model top |
| 30 | 37,159 m | |
| 40 | 27,998 m | |
| **45** | **24,170 m** | **the cut** |
| 50 | 20,795 m | first level *below* the 21 km LAM top |
| 60 | 15,638 m | |
| 121 | 236 m | surface |

Spacing near the cut is **675 m per level**, so level 49 is ~21,470 m — the first above the LAM's
`top_height = 21000`. Cutting there would leave under 500 m of headroom, which is not enough for the
vertical remap onto the LAM column.

**Cut at full level 45: keep 45..120, drop 1..44.** That is **76 of 120 levels (63.3 %), a 36.7 %
saving**, with **3,170 m of headroom** above the LAM top. Model-level files are ~97 % of the fetch
(10 variables x 120 levels against ~19 single/soil files per step), so the saving applies to
essentially the whole volume: **87.2 GB -> 55.2 GB, 43.6 min -> 27.6 min**.

At 27.6 min the fetch finishes at T+3:09, which is *before* DWD finishes publishing +24 h at T+3:14
— so the trim moves the fetch from download-bound to **publication-bound**, and no further trimming
of levels buys anything at all.

```
  T+2:41  step 000 lands -> streaming fetch starts (overlaps publication)
  T+3:14  fetch done    (25 BC steps, levels 45-120, ~55 GB; now PUBLICATION-bound, not download)
  T+3:18  IC/BC built   (+3m27)
  T+3:38  2 km phase A  (+22 h = 22/42 of Cowes' 38m10 = +20m)
  T+3:38  2 km published early  (+15s)
  T+3:38  nest IC/BC    (+10s)
  T+4:23  1 km nest     (+45m13)
  T+4:24  1 km PUBLISHED  <-- the number that matters
          ... 2 km phase B (+22->42 h) runs after this, off the critical path
```

**1 km ready at cycle + 4h24** (4h35 untrimmed). Converted to the venue:

| Cycle | Ready UTC | PDT (UTC−7) | PST (UTC−8) |
|---|---|---|---|
| 00z | 04:29 | 21:29 *prev day* | 20:29 *prev day* |
| 06z | 10:29 | 03:29 | 02:29 |
| **12z** | **16:24** | **09:24** | **08:24** |
| 18z | 22:24 | 15:24 | 14:24 |

**PDT vs PST** is simply US daylight saving: **PDT = UTC−7**, in force from the second Sunday in
March to the first Sunday in November; **PST = UTC−8** the rest of the year. The 1 km is ready at a
fixed 16:24 UTC either way — it is the *local* clock that moves, so the summer season is the harder
one by an hour. Round the County, the second weekend of November, falls just after the switch and so
runs in PST.

**Use the 12z.** The 1 km lands **09:24 PDT / 08:24 PST**, off an analysis 4.5 h old at the briefing.
Untrimmed it is 09:35 / 08:35, which is also inside the deadline — so the trim is margin, not a
rescue. Further slack if ever needed: a **+15 h nest** (45m13 → 37m40) gives 09:16 PDT.

The parent cannot be shortened below +22 h without breaking the nest, as above.

Note this is the mirror image of the Med. At Porto Cervo the venue is UTC+2 and only the 00z is
ever ready in time; here, being 7-8 h west means the **12z finishes during the local morning**.
That is a structural advantage of a western venue, not a tuning win.

Two numbers in that chain are NOT measured and should be treated as the risk: the ~77 GB fetch
volume is ICON-EU's measured 2 GB/min applied to an estimated size, and the 3m27 preprocess is a
regular-lat-lon remap — icosahedral may be slower. Both inflate the same slack the PDT case lacks.

The 2-day outlook costs nothing against the deadline, because phase B is already off the critical
path — and the 2 km is published early at +22 h, so there is a usable product on screen at T+3:38
(08:38 PDT / 07:38 PST) while the 1 km is still integrating.

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

## 5b. SST — the machinery is fine, the product is the question

`preprocess_cdo.sh::prep_sst_lam` is already **source-agnostic**, and deliberately so: the header
records that *"units + variable name were the two things that bit us on the Med, so both are now
DETECTED, not assumed."* It auto-detects the variable
(`analysed_sst | thetao | sst | sea_surface_temperature | sosstsst | tos`), auto-detects the units
(field max < 100 ⇒ degC ⇒ +273.15), takes `seltimestep,1 -sellevidx,1` so a multi-step hourly
product with a depth axis works, and renames to a canonical `analysed_sst`.

**So a Pacific product is mostly a dataset-id change, not new code.** The one line that must survive
is already flagged in the source:

```
  # Land-masked source -> bilinear remap leaves MISSING at near-coast LAM sea cells;
  # swap_sst's ifthenelse would then write NaN into t_g -> RRTM abort.
  # THIS WAS THE KEY MED FIX -- do NOT remove.
  cdo ... remapbil,"${GRIDFILE}" ... ; cdo ... setmisstonn ...
```

A coastline as convoluted as the San Juans will produce *more* near-coast missing cells than the
Med, not fewer, so `setmisstonn` matters more here.

**Choosing the product.** Two realistic candidates, and the trade is not the obvious one:

| | resolution | sensors | sovereignty |
|---|---|---|---|
| OSTIA (CMEMS) | 0.05° ≈ 5.5 km | **blends IR + microwave** | UKMO — and the README explicitly prefers *"CMEMS Med L4 (Mercator Ocean, FR), **not** OSTIA (UK Met Office)"* |
| MUR (GHRSST) | 0.01° ≈ 1 km | IR-led | NASA/JPL, US |

The San Juan channels are **2–5 km wide**, so 5.5 km barely resolves them and 1 km does. But the
Pacific Northwest is cloudy, and IR-derived detail only exists in clear skies — microwave sees
through cloud but only at ~25 km. MUR's extra detail is therefore least available exactly when the
sky is overcast, which here is often.

**Before paying for resolution, test the premise.** The Med needs ~1 km SST because the lever there
is a *sharp coastal SST front*. The Salish Sea is strongly tidally mixed and close to isothermal
year-round — the sea-breeze forcing is the large, stable land-sea contrast, not a gradient within
the water. If that holds, 5.5 km is ample and the whole question evaporates. That is a cheap thing
to check against buoy data and worth doing first.

Whichever is chosen, confirm the dataset-id with `copernicusmarine describe` before wiring it — the
existing script demands exactly that discipline, because a product id and a dataset id are not the
same string.

## 5c. The icosahedral grid — four concrete hazards

The good news first: **the codebase already knows how to do this.** `preprocess_nest.sh` remaps ICON
(unstructured parent) onto ICON (unstructured inner) and already passes `-setgrid` with the parent
grid. The ICON-global path is therefore much closer to the NEST path than to `preprocess_cdo.sh`,
whose header says plainly that it takes *"regular-lat-lon GRIB2 fields"*.

1. **ICON GRIB2 carries no horizontal coordinates.** CDO's maintainers are explicit: you must attach
   them with `setgrid` from DWD's grid file before any interpolation operator will work. That is the
   937 MB `icon_grid_0026_R03B07_G.nc`, which has to be staged on the box.
2. **`remapbil` and `remapbic` cannot be used on ICON grids at all** — use `remapdis`, `remapnn` or
   `remapycon`. The current `REMAP_METHOD="gencon"` (conservative) is safe, and the SST `remapbil`
   is safe because its *source* is a regular-lat-lon CMEMS product. **The trap is the comment on
   line 46**, `"remapbil for winds if preferred"` — an invitation to a failure that would not exist
   on the Med.
3. **CDO 2.2.0 is broken on DWD global ICON GRIB2** (an eccodes padding error), fixed in 2.2.1. The
   image currently has **2.1.1, which is safe** — so this is a landmine rather than a blocker: an
   innocent CDO bump to 2.2.0 breaks ICON-global ingestion *specifically*, and nothing else.
   **Pin the version.**
4. **"Reference to source grid not found"** on self-generated weights. DWD's own fix is `selgrid`
   first, then `setgrid` on a sample GRIB2, then `gennn`.

And one that is already a scar here: **weights must be cached per source→target PAIR, not per
cycle.** `preprocess_nest.sh` records that riviera_2km driving two nests collided on a shared
`nest_weights.nc` with *"Size of source grid and weights differ"* — *"single-nest La Spezia never hit
this."* Generating weights from a 2.9 M-cell global source is expensive enough that it must be done
once and reused, which is exactly how that collision happened. DWD also publishes prebuilt weights
and target descriptions for the global grid; use them rather than generating ours.

## 5d. The repeat issues — things this project has already paid for

Every one of these was a day lost somewhere. A new domain re-trips them for free unless they are
checked off deliberately.

| Trap | How it shows | The rule |
|---|---|---|
| An unknown output variable name | ICON **aborts at startup** — the whole cycle, no partial forecast | Prove names on a non-racing day (`smoketest_tke.sh` exists for this) |
| `SPLITLEAD` too short | "LATBC file not found" **after** the parent has already run | 22, not 20 — the nest needs +21 h |
| Partial `.bz2` left behind | `wget -nc` exits 0 without refetching, so the retry can **never** heal it | Delete the partial on any failure |
| `missing_steps` is a RELATIVE test | A whole variable lagging reads as "fetch complete" | Only safe while fetching *after* publication ends |
| Restart file moved out of the run dir | `-C` continuation **silently cold-starts** the tail | Leave `*_restart_*` in place |
| Shared remap weights | "Size of source grid and weights differ" | Cache per parent→inner pair |
| SST units/variable assumed | degC written into `t_g` as Kelvin | Detect both; keep `setmisstonn` |
| Vertical CFL | Afternoon convection trips CFL > 1 at `dtime = 10 s` | `dtime ≤ 6 s`, and test on a **full-day** run that reaches afternoon convection |
| MPI transport | `osc/pt2pt` deadlocks ICON's prefetch RMA at the boundary switch | `--ipc=host --cap-add=SYS_PTRACE --security-opt seccomp=unconfined`, then `MPI_MCA=""` |
| `www/` cycle dirs | ~1 GB accumulating on a 9 GB root disk | The archive sweep in `cron_daily.sh` |
| Grid generated, levels unchecked | A drifted `z_mc` silently changes the whole profile | Dump `z_mc` after grid generation and confirm |

## 6. Checklist

- [x] Domains created, namelists verified byte-identical to Cowes
- [x] Zonda requests written, CORINE disabled with the ExtPar source checked
- [x] App venues registered on both resolutions, test pinned
- [ ] **Decide the driving data** (§4) — gates everything below
- [ ] Submit the two Zonda requests; place `.nc` into `grid/` and `extpar/`
- [ ] Pacific SST product chosen and wired into `fetch_cmems_sst.sh`
- [ ] `NESTS` / `DOMAINS` / `EVENT_VENUE` set in `.env` when the event approaches
- [ ] Confirm `z_mc` after grid generation (the project's standing post-grid check)
