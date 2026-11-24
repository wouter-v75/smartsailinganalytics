---
title: "Weather-routing climatology tool — design, research and first build"
date: 24 November 2026
---

# Weather-routing climatology tool

**What it answers.** For a race course (GPX), a boat (Expedition polar) and a start
date and local time: how long does the race take in each of the last 20 years'
weather, routed optimally — the spread (min, max, mean, median, 1σ) and where the
hours are spent (a TWA × TWS table, 5° × 2 kn, 30–160° × 0–30 kn).

**Status, 24 Nov 2026.** The engine, the ERA5 fetcher and the command-line runner
are built and tested (18 tests, synthetic wind with known answers). It has not yet
been run on real ERA5 — the fetch needs the CDS key and runs on the laptop. A web
tab (upload GPX + polar, see the results) is the next step once a real course
has been checked; section 9 says what it needs.

## 1. How to run it

```bash
cd /Users/wouterverbraak/Code/ssa && python3 -m venv .venv && .venv/bin/pip install -r scripts/routing/requirements.txt
```

```bash
cd /Users/wouterverbraak/Code/ssa && .venv/bin/python scripts/routing/era5_fetch.py --gpx ~/Downloads/course.gpx --start 2026-10-17 --days 6 --window 15 --years 2006-2025 --out ~/routing/msr --write
```

```bash
cd /Users/wouterverbraak/Code/ssa && npx vite-node scripts/route-climatology.ts -- --data ~/routing/msr --gpx ~/Downloads/course.gpx --polar ~/Downloads/boat.pol --start "2026-10-17 11:00" --mast 35 --window 15 --every 48 --convergence
```

The fetch is dry-run without `--write` and prints the box, the cell count and the
size. `--days` is the longest race to allow for; a year whose route has not
finished when the wind runs out is reported as failed, never as a time.
`--window 15` on both commands starts the race every `--every 48` hours from 15
days before the date to 15 days after: 16 starts a year, ~320 over twenty years
(§7). Homebrew's Python has no `pip` and refuses global installs (PEP 668), hence
the venv; `.venv/` is gitignored. Results
land in `~/routing/msr/results`: `report.html`, `summary.json`, `elapsed.csv`,
`table-iso-pct.csv`, `table-grid-pct.csv` (and `-hours`), `routes.geojson`.

| option | default | meaning |
|---|---|---|
| `--mast` | 10 | height (m) the polar's TWS is defined at |
| `--lift` | `power` (`none` at 10 m) | how ERA5 is brought to that height (§5.3) |
| `--tack` / `--gybe` | 60 / 45 s | time lost per manoeuvre |
| `--day-factor` / `--night-factor` | 0.95 / 0.90 | share of the polar sailed in daylight / darkness (§4) |
| `--dark-below` | −0.833° | sun altitude below which it is dark (sunset; −6 = civil dusk) |
| `--radius` | 0.25 nm | mark rounding radius |
| `--step` | 30 min | isochrone time step |
| `--sector-nm` | 0.5 nm | isochrone pruning resolution (§3.4) |
| `--window` / `--every` | 0 d / 48 h | extra starts either side of the date, and their spacing |
| `--cell` / `--stencil` | 2 nm / 32 | grid lattice spacing and directions |
| `--max-nodes` | 400,000 | grid lattice cap; an ocean leg needs a coarser `--cell` or more (Transpac: `--cell 4 --max-nodes 1500000`) |
| `--method` | both | `iso`, `grid` or both |
| `--convergence` | off | re-route the first year finer and report the change |

## 2. Pipeline

| stage | code | what it does |
|---|---|---|
| course | `src/lib/routing/course.ts` | GPX `<rte>`, else `<wpt>`, else a short `<trk>`; first point start, last finish, every point between a mark in order |
| polar | `src/lib/routing/polar.ts` | Expedition or grid text → a dense 0.5 kn × 1° table, PCHIP in TWA, linear in TWS |
| wind | `scripts/routing/era5_fetch.py` | ERA5 hourly 0.25°, one CDS request per (year, month), the course box padded max(1°, 25 %) |
| land | same | a 0.01° (~0.6 nm) land raster from the 1 km GLOBE-derived `global_land_mask` |
| lift | `src/lib/routing/windField.ts` | ERA5 10 m + 100 m → the polar's height |
| route | `isochrone.ts`, `gridRouter.ts`, `motion.ts` | both methods, leg by leg, exact arrival |
| results | `climatology.ts`, `scripts/route-climatology.ts` | statistics, bootstrap interval, TWA × TWS table, report |

## 3. The isochrone method, as built

The method is due to James (1957), made practical by Hagiwara (1989). Take the set of points
reachable at time *t*. Push each point along a fan of headings for one step. The
union of those moves is what is reachable at *t + Δt*. Thin it to its outer edge (the isochrone) and
repeat.

### 3.1 Fan and integration

- **Fan:** every 5° within ±140° of the bearing to the mark, plus the four exact VMG
  headings at the local TWS (up and down, each tack) and the bearing itself. The
  VMG headings matter. Without them the beat is sailed at the nearest 5°, which
  costs time on every beat.
- **Turning limit:** no heading may turn more than 140° from the heading that
  reached the point. This is OpenCPN's *MaxSearchAngle* and it stops the front
  doubling back on itself.
- **Integration:** a midpoint (RK2) step. Take the speed from the wind at the start,
  move half a step, read the wind THERE and THEN, then take the full step on that speed. A
  manoeuvre is charged as time not sailed in the step (OpenCPN, LuckGrib), using
  the sign of TWA, + = starboard tack.
- **Land:** a step is refused if any sample along it is land. Samples are taken every half
  cell of the 0.6 nm raster.

### 3.2 The last-isochrone problem

This is the part that decides whether the numbers can be compared. It has three
faces.

**1. Quantisation.** The mark is reached *between* two isochrones. A router that
reports the time of the first isochrone containing the mark is late by between 0
and Δt, about Δt/2 on average, and always in the same direction. It is also late
**per mark**, so a three-leg course carries three of these errors. On the synthetic
benchmark (§3.6):

| wind case | exact | naive, 30 min step | naive, 60 min step |
|---|---|---|---|
| 0 | 55.30 h | 56.00 h (+1.3 %) | 56.00 h (+1.3 %) |
| 1 | 55.75 h | 56.50 h (+1.3 %) | 57.00 h (+2.2 %) |
| 2 | 52.25 h | 54.00 h (+3.3 %) | 55.00 h (+5.3 %) |
| 3 | 50.13 h | 51.00 h (+1.7 %) | 53.00 h (+5.7 %) |

That is the size of the differences between years that the study exists to measure.

**2. Pruning throws away the winner.** The front is thinned by sector, keeping in
each sector the point furthest from the leg's origin. Far from the origin a sector
is miles wide, and the point it keeps is the furthest one, not the one nearest
the mark. So a naive router can discard the very point that would have finished
first.

**3. Overshoot and folding.** Once part of the front is past the mark, its sectors
keep growing outward and the front folds back.

**The fix, as built.** This is OpenCPN's method (read from its source), with two
additions.

- **From every expanded point, at every step, before pruning,** `approach()` solves
  the exact time into the mark's circle. In uniform wind the fastest path to a
  point is either straight or two legs with one manoeuvre (the convex hull of the
  polar). Two legs win exactly when the mark lies inside the VMG angle, and then
  the time is d·cos θ / VMG whatever the split, so it is closed-form.
  - The straight case is then integrated in sub-steps of at most 5 min,
    re-aiming at the mark, so a shift during the approach is felt.
  - Candidates up to two steps away are accepted. OpenCPN accepts one, and the
    research flags that as able to reject every point when the front is sparse.
- **The search stops only when the front's own time passes the best arrival.**
  No later point can improve on that arrival.
- **Second-half sectors (Hagiwara).** Once any point is within half the leg of
  the mark, sectors are taken from the MARK and the point kept is the one nearest
  it. That keeps the front from collapsing to a point as it closes.

Tested: on a beam reach in steady wind, where the answer is distance / polar speed,
the router is within 0.2 % at 20, 30 and 60 min steps, and 15 against 90 min agree to
under a minute. The naive rule on the same reach is late by up to one step and
lands exactly on an isochrone, as it must.

### 3.3 Marks: leg by leg, and why that is exact

A sailing boat can always slow down, so arriving earlier at a point is never worse
than arriving later. This is the FIFO property. Every route passes through a point
mark, so the optimal route through it arrives at the earliest possible time, and
the rest of the race starts from there. **The earliest arrival at mark k IS the
start of leg k + 1**, and routing leg by leg loses nothing. The tack side on
arrival is carried over, so the rounding manoeuvre is charged.

This matters because the best-known commercial router does *not* do it well:

- Expedition's manual: *"Isochronal routing may only optimise the first leg"*,
  *"fewer marks … yield better results"*, and port/starboard rounding is not
  available for isochrones.
- qtVlm routes one destination at a time; gates are done by hand ("pivot" routings).
- OpenCPN optimises start → end only.

**Where leg-by-leg stops being exact, and what to do then:**

| case | why | remedy |
|---|---|---|
| a gate (a line) | where you cross it matters to the next leg | hand the whole set of crossings to the next leg, each with its time, heading and tack. Fronts indexed by leg do this naturally |
| a large rounding radius | as for a gate, on a circle | the same |
| a rounding side ("leave Stromboli to port") | an approach from the wrong side is not a rounding | reject crossings of the mark-to-next-mark bisector on the wrong side |

None of these is in the first build. GPX waypoints named `gate` or `via` are
recognised and stored, but are routed as points.

### 3.4 What the answer converges on: pruning, not the time step

Measured on a 330 nm, three-leg synthetic course in shifting wind (wind case 2):

| sector width | 10 min | 20 min | 30 min | 60 min |
|---|---|---|---|---|
| 1° fixed | 52.40 h | 52.35 h | 52.25 h | 52.16 h |
| 0.25° fixed | 52.20 h | 52.13 h | 52.12 h | 52.13 h |

With 1° sectors the answer got *worse* as the step was refined. More steps mean
more prunes, and each prune loses a little. On the 110 nm first leg the loss was 2 %.
At 0.25° every step from 10 to 60 min agrees within 0.15 %.

The default is therefore set in **miles at the front**: 0.5 nm at half the leg
length. On this course it gives 52.13 h, within 0.03 % of 0.25°, at half the
cost (2.3 s per route against 4.6 s). The `--convergence` flag re-routes the first
year at half step, half sector and a 2.5° fan, and reports the change. Read that
number before reading the results.

### 3.5 The grid method

The sea round each leg is a lattice, 2 nm by default, aligned so the leg's start
is a node. Nodes are joined by a 32-direction stencil. An edge's cost is the time
to sail it starting at the time the search reaches it, so the graph is
time-dependent. Dijkstra on (node, tack side) gives earliest arrivals and lets
manoeuvres be charged. The last edge has its own last-isochrone problem, solved
the same way: `approach()` from every settled node near the mark.

Expedition keeps a grid router for studies, *"where it was important to compare
similar simulations"*. It is deterministic and exhaustive over its lattice, but
it can only sail the stencil's directions. On the same course and wind:

| lattice | elapsed | vs converged isochrone |
|---|---|---|
| 2 nm, 16 directions | 52.80 h | +1.3 % |
| 2 nm, 32 directions | 52.41 h | +0.6 % |
| 1 nm, 48 directions | 52.28 h | +0.3 % |
| 0.5 nm, 48 directions | 52.28 h | +0.3 % |

The grid converges, independently, to within 0.3 % of the isochrone. That is the
best available evidence that both are right. The residual is the stencil's
angular step at the beat (~14° at 48 directions), which no lattice spacing
removes. The grid is 8× faster (0.28 s against 2.3 s).

Running both is the point. They err in different ways, so their difference on the
same wind is a direct measure of how much of an answer is method rather than
weather.

Two honest limits apply to both methods:

- **No waiting.** Neither models heaving-to for a breeze that fills in later. Sailing
  is FIFO only if waiting is allowed, so in a calm that fills in, both can miss a
  "wait" route.
- **No current and no waves.** See section 8.

### 3.6 The benchmark

All of section 3 was measured on the same benchmark:

- **Polar:** a 50-footer, Expedition format.
- **Course:** start → mark → mark → finish, 330 nm.
- **Wind:** a synthetic field veering 60° over 30 h, with a pressure gradient
  across the course and a 9-hour pulse in strength.
- **Variation:** four phases of that field (wind cases 0–3).

The tests in `src/lib/__tests__/routing.test.ts` pin the analytic cases (reach,
beat, island, multi-leg, the naive bias).

## 4. The polar

| choice | why |
|---|---|
| PCHIP (monotone cubic) in TWA | Straight lines kink at every tabulated angle, so the beat angle snaps to a row of the file. A natural spline overshoots, inventing speed at the top of a reaching curve. PCHIP is smooth and never leaves the range of its neighbours. |
| linear in TWS | What Expedition, qtVlm and OpenCPN do |
| below the lowest TWS row: proportional to 0 at 0 kn | Expedition's behaviour |
| above the highest row: held | Extrapolating a polar's slope upward invents speed where a crew reefs. LuckGrib clamps too. |
| below the lowest tabulated TWA: no-go | The router tacks at the beat angle instead (LuckGrib warns that a polar falling to 0 at TWA 0 lets routes use absurd angles) |
| tack 60 s, gybe 45 s | Defaults for a 40–50 ft boat. A maxi wants 90–120 s. |

**The polar's height is the single largest setting.** Expedition's manual: most
designers' polars are scaled to a 10 m wind. A polar built from a boat's own
masthead instruments is at the masthead. 10 m → 32 m is +9 % in neutral air and
+20–30 % on a stable morning (`windProfile.ts`). Getting `--mast` wrong is a
larger error than anything in section 3.

**Day and night.** A crew sails less of its polar in the dark: nobody can see
the sails or the waves, the helm steers to instruments, and half the crew is
below. The routers therefore sail **95 % of the polar in daylight and 90 % in
darkness** by default (`--day-factor`, `--night-factor`; both 1 routes the raw
polar). Darkness is decided by the sun's altitude **at the boat's position and
time** (`daylight.ts`, the Astronomical Almanac's low-precision solar position,
~0.01° — far finer than a 30 min step), not by the clock at the start line: on
Transpac the boat sails five time zones west, so each night falls later than
the one before. The default boundary is sunset/sunrise (−0.833°); `--dark-below
-6` moves it to civil twilight. The factor scales SPEED only: the VMG angles and
the no-go edge are the polar's shape, which a uniform factor does not move. It is
applied inside the propagation (`advance`, the grid's `traverse`, and the exact
arrival), so a route can trade a longer daylight leg against a shorter night
one. The report states the set-up and the share of sailing time spent in the
dark.

## 5. The wind

### 5.1 Source

The source is **ERA5** single levels (C3S): 0.25°, hourly, 1940 to date, about 5 days'
latency, final after 2–3 months. The fetcher takes 14 fields. The router needs
four of them (10 m and 100 m u/v). The rest feed the boundary-layer step and cost
little:

- t2m, SST, d2m, sp: air-sea stability and virtual temperature
- BLH
- friction velocity
- sensible heat flux
- Charnock: ERA5's wave-coupled roughness
- the NEUTRAL 10 m wind: its difference from the real 10 m wind is the model's own
  stability flag

Sizes: a 10° × 10° box is 1,681 cells. 20 years of a 6-day window is 3,840 hours.
The four wind fields are about 105 MB and all fourteen about 360 MB as float32.

**The CDS bills per item**, which is a variable × a timestep, and cropping with `area`
does not reduce it. One request per year-month is about 2,700 items, well inside
the cap.

**The time is the queue, not the download.** Measured on the Transpac fetch
(46 days a year over 91 × 199 cells, three monthly requests a year): each request
waited 4–6 min in the CDS queue and downloaded in 1–2 min, so one request at a
time was ~27 min a year and ~9 h for twenty. The fetcher now keeps `--parallel 6`
requests in the queue at once and writes each year the moment its last month is
in. The CDS caps how many of one account's jobs RUN at a time, and another study
on the same key competes for those slots, so the gain is a few times, not six.
A year's `.bin` is written under another name and renamed, so a run killed
mid-write never leaves a truncated year that the next run would skip.

**The cloud copies are a trap from a laptop.** Google's ARCO-ERA5 Zarr is chunked
one global field per hour, so a small box costs a full field per hour read:
70–150 GB of reads for one study.

### 5.2 Sampling

- **Direction** comes from u/v, bilinear in space and linear in time. Never blend
  degrees: 350° and 10° average to 180° as numbers.
- **Speed** is blended as a scalar, and the components are rescaled to it. A u/v blend
  across a shift *understates* the wind: two 10 kn winds 90° apart average to
  7.1 kn, which would put a false hole in every front. LuckGrib preserves magnitude
  the same way.

### 5.3 To the masthead

ERA5 publishes 10 m *and* 100 m wind, so a 20–35 m masthead lies BETWEEN them.
The lift is an interpolation of the model's own shear, not an extrapolation.

| `--lift` | what | use |
|---|---|---|
| `power` (default) | log-linear in height between 10 and 100 m. Direction from the same blend, so the veer with height is kept | the model's own stability, at no cost |
| `mo` | Monin–Obukhov from the 10 m wind and t2m − SST, Charnock roughness (`windProfile.ts`) | first test of §6 |
| `neutral` | neutral log law from 10 m | the low-biased reference: about −9 % on average, −16 % on a light stable morning |
| `none` | 10 m as is | a polar defined at 10 m |

## 6. Next step: a better wind in the lowest 100 m

**The diagnosis is not that the interpolation formula is wrong, but that ERA5's
shear and strength are.** Because the masthead lies between ERA5's own levels,
interpolation is not the problem. The research found three known faults, all of
which bite a sailing climatology.

**1. Stable air is over-mixed on purpose.** ECMWF enhances diffusion in stable
conditions because reducing it degrades synoptic cyclones and 2 m temperature
(Sandu et al. 2013). The cost is:

- too little shear;
- stable layers too deep;
- low-level jets too weak or too high (Kalverla et al. 2019);
- veer underestimated, with a quarter of cases more than 24° off at Baltic coastal
  lidars (Hallgren et al.). For routing the veer matters as much as the speed: it
  is the TWA difference between 10 m and the masthead.

This is warm air over a cold sea: a spring Mediterranean, or flow off a heated coast.

**2. Strong wind reads low** from about 10 m/s, nearly 10 % low at the top of the range.
Gandoin & Garza (2024) trace it to ERA5's Charnock running too high in strong
wind. ERA5 is IFS Cy41r2, and the later fixes (Charnock floor and high-wind
reduction, Cy47r1) are not in it.

**3. At the coast**, a 31 km grid smears the land-sea boundary and the first one or
two cells offshore are mixed. Sea breezes are poorly resolved; no direct study of
ERA5's Mediterranean sea-breeze cycle was found.

### 6.1 Stage 1: physics post-processing (days)

1. **Two-level stability fit.** Solve for the Obukhov length L* that makes the MO
   profile pass through BOTH ERA5's 10 m and 100 m wind (Optis, Monahan & Bosveld
   2014: a "bulk" L from two heights beats a surface-flux L for extrapolation),
   then read U at the masthead.
   - Use Beljaars–Holtslag stable functions (already in `windProfile.ts`) and
     Grachev/SHEBA past ζ = 1.
   - Where the two winds are within 0.5 m/s, fall back to `power`.
   - On its own this mostly reproduces ERA5's shear. Its value is that L* becomes a
     stability variable for steps 2 and 4.
2. **Strong-wind correction at source** (Gandoin & Garza 2024):
   - cap ERA5's own Charnock (`chnk`, fetched) at 0.018;
   - hold the 100 m wind and re-invert the profile for u* and z₀;
   - regenerate U(10) and U(mast).
   - It is validated to 25 m/s and not for tropical cyclones. Read the corrigendum
     first.
3. **Check against the model's own 31 m wind.** ERA5 model level 136 is about 31 m: the
   model's prognostic wind at a masthead. Pull it for two or three years through
   the CDS (model levels are tape-backed and slow) and measure how far `power` and
   step 1 are from it.
4. **Flag what cannot be fixed by post-processing.** Mark the hours that are stable
   with air − SST > 2 K. There ERA5's shear and jets are known to be wrong. Carry a
   spread, for example masthead shear × 1.0–1.5, so the elapsed-time statistics
   show how much of the answer rests on those hours.

### 6.2 Stage 2: better source data (weeks)

1. **Use a regional reanalysis with height levels where one exists**, rather than
   running a model:
   - CERRA (Europe, 5.5 km): wind at 15, 30, 50, 75, 100 m. Already fetched for the
     Naples study; use forecast steps +4 to +6 h, which read less low than the
     analysis. Its end date needs checking (a C3S poster says August 2023).
   - NORA3 (Nordic, 3 km): 10, 20, 50, 100 m.
   - BARRA2 (Australia, 4.4 / 12 km): heights to confirm.

   For the Med, Fastnet and North Sea this is most of the gain. **One caution from
   the Naples work:** CERRA's distribution was closer than ERA5's at Sorrento, but
   its per-regatta bias swung −0.6 / −3.5 / +2.0 kn, so ERA5 + correction scored
   better held out. The router should be able to take EITHER source.
2. **MOS against open truth.** Quantile-map the 10 m speed by direction sector and
   stability class against scatterometer (CMEMS `WIND_GLO_PHY_L4_MY_012_006`:
   hourly, 0.125°, to be checked before use) and against coastal stations.
   - The MOS machinery and its tail bars (`src/lib/mosFit`) already exist.
   - Expect 5–15 % rmse reduction where truth exists.
   - Truth at 30 m is thin: a few masts and lidars; buoys are at 3–4 m.
   - Boats' own logs are NOT used: no boat data shared.
3. **WRF only where nothing else will do:** sea-breeze-dominated coastal legs (Sicily,
   Capo Passero, the Fastnet Rock, Bass Strait).
   - Run at 3 km, ERA5-driven, with OSTIA SST and MYNN or YSU, plus a QNSE
     sensitivity run.
   - No PBL scheme wins everywhere. Low-level-jet frequency differed more than 3×
     between schemes at North and Baltic Sea lidars, so treat the scheme spread
     as uncertainty.
   - Cost: about 20 runs of 5 days per race, CPU-days on a cloud cluster.
4. **Skip wave coupling.** ERA5's `chnk` already encodes the sea state, and the
   published gains are small and case-dependent.

## 7. Results, as reported

- **Elapsed time:** min, max, mean, median, 1σ (sample) over every route, plus 90 %
  bootstrap intervals on the median and the mean. Twenty years is a small sample of
  a climate, its tails most of all, and the interval says how much of a difference
  between two studies is the sample.
- **Several starts a year.** `--window 15 --every 48` routes 16 starts a year at the
  same local clock time, which is how these studies are usually run: twenty single
  starts are twenty samples, and a window round the date multiplies that without
  leaving the season. The starts inside one year are **not** independent — a
  regime can sit over the course for a fortnight — so the interval resamples whole
  YEARS (a block bootstrap, `bootstrapBlocks`), not routes. Resampling 320 routes
  one by one would treat them as 320 independent draws and give an interval
  several times too narrow (the test pins it at more than 2× on a year-correlated
  set). The report also breaks the result down **by start offset**, so a trend
  through the window (the Pacific High strengthening into July, say) shows rather
  than being averaged away.
- **Time on each point of sail:** upwind (< 70°), reaching (70–120°), downwind (> 120°),
  and on starboard.
- **The TWA × TWS table:** mean hours per race and % of sailing time.
  - |TWA| in 5° bins from 30 to 160°, TWS in 2 kn bins from 0 to 30 kn.
  - There is an under and an over bin on each axis, so no hour silently drops out:
    a 28° beat and a 170° run are still time sailed.
  - TWS is the wind at the polar's height.
- **Per year:** mean, min and max over that year's starts; per route in `elapsed.csv`:
  local and UTC start, elapsed time, time per leg, sailed distance, tacks and gybes.
- **Routes** as GeoJSON and on the report's chart.

A route that does not finish inside the fetched window is counted as failed and
reported separately. It is never turned into a number. Each route may run for as
long as its year's data lasts — the isochrone router's own default cap is 240 h,
which on a 2,200 nm ocean course would fail exactly the slow starts and bias the
mean fast, so the runner lifts it to the data's end.

**Memory on an ocean leg.** The isochrone router used to keep every candidate it
generated, including the ~95 % the pruning discards. On a 330 nm course that is
harmless; on Transpac it was ~35 million nodes and the heap ran out before the
first route finished. Only the surviving front and the best arrival can ever be
walked back from, so the rest is dropped after each step.

## 8. Limitations of the first build

- **Points, not gates;** no rounding side (§3.3).
- **No current and no wave penalty.** OpenCPN's treatment is the model: wind over the
  water = wind − current; velocity over ground = polar + current; heading
  iterated so COG points at the target. CMEMS currents would slot into `advance()`.
- **No waiting** in a calm that fills (§3.5).
- **ERA5's strong-wind and stable-layer biases** (§6) are inherited, not corrected.
- **Runtime.** A 2,200 nm leg is ~20 s per route for the isochrone and ~12 s for a
  4 nm grid; 320 starts with both methods is ~3 h. `--method iso` halves it.

## 9. The web tab, when it comes

The engine is pure TypeScript with no Node dependency, so it can run in the
browser. The fetch cannot: the CDS queue takes minutes to hours and needs a key.
The tab therefore needs a job: upload GPX + polar + start, then a server-side
fetch (cached per box and window, so a second boat on the same course costs
nothing), then routing, then results in the existing report shape. Section 1's
commands are that job, by hand.

## References

- Hagiwara, H. (1989). *Weather routing of (sail-assisted) motor vessels.* TU Delft. Described via Chen et al. (2023), Chalmers: research.chalmers.se/publication/540171
- OpenCPN weather_routing_pi, `RouteMap.cpp`, `RouteMapOverlay.cpp`, `Polar.cpp`: github.com/seandepagnier/weather_routing_pi
- Expedition manual: expeditionmarine.com/downloads/documents/Expedition.pdf
- qtVlm routing: wiki.v-l-m.org/index.php/Routing_with_qtVlm
- LuckGrib, interpolation and polars: luckgrib.com/tutorials/2015/12/05/interp-wind.html; routing.luckgrib.com/intro/polars.html
- Adrena, routings on historical GRIBs: adrena-software.com/en/weather-routings-on-historical-gribs/
- Wei & Zhou (2012), 3D dynamic programming for weather routing, TransNav
- Mannarini et al. (2020, 2024), VISIR graph routing: gmd.copernicus.org/articles/17/4355/2024/
- Hersbach et al. (2020), The ERA5 global reanalysis, QJRMS
- Gandoin & Garza (2024), ERA5 strong-wind underestimation and Charnock: wes.copernicus.org/articles/9/1727/2024/
- Sandu et al. (2013), Why is it so difficult to represent stably stratified conditions in NWP models? JAMES
- Kalverla et al. (2019), low-level jets in ERA5: wes.copernicus.org/articles/4/193/2019/
- Optis, Monahan & Bosveld (2014), moving beyond Monin–Obukhov for stable profiles
- Gryning et al. (2007), extended wind profile above the surface layer, BLM
- Hallgren et al. (2024), ML correction of ERA5 hub-height wind: wes.copernicus.org/articles/9/821/2024/
- GMD 18, 4499 (2025), WRF PBL schemes and low-level jets offshore
- CERRA height levels: cds.climate.copernicus.eu/datasets/reanalysis-cerra-height-levels
