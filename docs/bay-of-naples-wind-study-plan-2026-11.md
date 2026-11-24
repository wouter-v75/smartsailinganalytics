# Bay of Naples — 30 m wind study for a maxi regatta, 29 June – 3 July

*Study plan · 23 Nov 2026 · **event 2027** · status: decisions taken, downloads ready to start*

## 1. What the study has to answer

The regatta window is **29 Jun – 3 Jul**; the study window is **30 May – 2 Aug** (30 days either side), so
the race week sits in the middle of its own seasonal context. The quantity is **wind at 30 m over the
sea** — speed, direction, gust — hourly, **inside the racing window 11:00–17:00 local (09–15 UTC) only**. Nothing outside those hours
is downloaded or reported; it is a design decision, not a filter applied at the end.

The questions, in the order a navigator and a race committee would ask them:

| # | Question | Statistic delivered |
|---|---|---|
| Q1 | What will a race afternoon look like? | Hourly P10 / P50 / P90 of 30 m TWS, hourly wind roses, mean veer through the afternoon |
| Q2 | Will we race? | P(TWS inside the class limits) by hour; P(≥ N race-able hours) per day; P(all five days race-able) |
| Q3 | When does the breeze fill, from where, and how hard? | Onset-time distribution, onset direction, peak strength, late-afternoon veer — on sea-breeze days only |
| Q4 | What can override it, and how often? | Frequency of each weather regime in the window (sea breeze, Maestrale/NW, Tramontana/Grecale, Scirocco, heat-dome-suppressed) and the afternoon wind under each |
| Q5 | Is race week different from the rest of the window, and from May? | Pentad-by-pentad climatology 30 May → 2 Aug, and May vs window side by side |
| Q6 | Where on the course is it stronger? | Spatial pattern across the bay — Bocca Piccola / off Sorrento vs mid-bay vs Posillipo |
| Q7 | How gusty and shifty? | Gust factor at 30 m, 10–30 min direction σ |
| Q8 | How much do we trust the forecasts in this window? | Skill of raw and MOS-corrected models in June–July 2025/26 against the study's truth |
| Q9 | How sure are we of all of the above? | Every number with an interannual spread and a bootstrap interval; a stated transfer error for the May→July step |

## 2. The central difficulty, stated up front

**Our only instrumented truth at 30 m is from May, and the target is late June – early July.**
Northstar 72's 445 masthead bins (2024, 2025, 2026) run 12–28 May; the earliest day of the study window
is 30 May. Not one bin falls inside it. The wind-energy literature is blunt about seasonally offset
measurement campaigns — a short summer campaign is the *worst* basis for a long-term correction, and
variance biases above 15 % are common (Sheridan et al. 2025; Basse et al. 2021). So the study is built
so that May data **calibrates a regime-conditioned correction**, and the long reanalysis supplies **how
often each regime occurs in late June**. The transfer error is then *measured*, not assumed (§5.4).

What we already know points both ways. The race officer for AC38 groups "mid-May to mid-June" as the
ideal 10–15 kn window from 200–210°, filling 12:30–14:30 and veering to 220–240° (Cosentino, Yachting
World). Physically July differs from May in three ways that matter at 30 m: the sea is ~25 °C instead
of ~18 °C, so the marine layer is far less stable and the 10→30 m shear smaller; heat-dome subsidence is
more frequent and caps the breeze (−8 to −10 % breeze speed in such episodes, Bedoya-Valestt et al.
2026); and there are fewer synoptic interruptions.

### A first pilot result (Capri LIQC, 2010–2025, 11–17 h local)

Run while scoping this plan, from NOAA ISD:

| Period | n | P50 | P90 | mean | SW 190–260° | N–NE |
|---|---|---|---|---|---|---|
| 10–28 May (the N72 days) | 3078 | 4.1 kn | 8.0 | 4.2 | 39 % | 12 % |
| 30 May – 2 Aug | 10269 | 2.9 | 7.0 | 3.7 | 44 % | 5 % |
| 29 Jun – 3 Jul | 803 | 2.9 | 7.0 | 3.6 | 47 % | 4 % |

Two things follow, both provisional. **The window is more sea-breeze-dominated than May** (SW up from
39 % to 44–47 %, N–NE down from 12 % to 4–5 %) and **it is lighter** (median and P90 each down
about a knot, mean −12 %). And **Capri's anemometer reads far below the masthead**: a 4 kn afternoon median against
N72's 9.8 kn mean says the station (269 m, on the island) is sheltered or in the lee for the breeze. It
is useful for *direction, timing and regime*, and useless for *speed*. That one number already rules out
the obvious shortcut of correcting the reanalysis to Capri.

## 3. Data sources

### 3.1 Truth at 30 m — Northstar 72 masthead (in hand)

- 445 ten-minute vector-averaged bins, `obs_sorrento.csv` in *wind-verification*, built from the
  perf logs in `logs/sorrento/` with the event files. Masthead **32 m** (corrected from the files'
  default 30 m in `mos-med-refit.ts`). **Ground** wind (`GW_speed`/`GW_Dirn`), magnetic → true via
  the event file's `<magvar>`.
- Coverage: 19 days, 08–15 UTC (10–17 local), positions 40.64 N 14.37 E ± a few km — the bay north of
  Sorrento. 35 bins reach 16 kn; max 22 kn.
- **One bad bin to drop**: 2024-05-22 08:20 UTC reads 34.76 N −5.13 E (a lost fix).
- Re-extract at **2-minute** resolution for the gust factor and shift statistics (Q7) — the 10-min
  bins average them away. The raw 1 Hz logs are on disk.
- No air or sea temperature channel in the log, so stability comes from the reanalysis.

### 3.2 Long-term backbone — reanalysis

| Product | Why | Use |
|---|---|---|
| **CERRA height levels** (C3S, 5.5 km) | The only open, long, still-updated product that stores wind **at exactly 30 m** (levels 15/30/50/75/100… m). Best of the European reanalyses on the French Med coast (bias within ±10 %, diurnal bias ~−0.5 m/s, Patra et al. 2025). Grid fine enough to put several cells inside the bay | **Backbone, 1985 → latest available.** Hourly series from the 3-hourly analyses plus the +1 h and +2 h forecast steps; never leads beyond +6 h. 15 and 50 m too, for the shear |
| **ERA5** (0.25°), model level **136 = 30.96 m**, plus 10/100 m and 850/700 hPa | Longest, most homogeneous; drives the regime classification; the yardstick for CERRA's added value | Regime classifier input (gradient wind, 850 hPa temperature), cross-check of interannual variability and trend |
| MERIDA HRES (RSE, WRF on ERA5, 4 km, 1986 →, 10/100 m) | Independent finer model for the spatial pattern (Q6) | Optional, needs registration |
| Parthenope WRF archive (since 2006, ~1 km over the Gulf) | The only kilometre-scale hindcast of the bay itself — resolves Capri, the Lattari ridge and Bocca Piccola | Optional, by request; best tool for Q6 if granted |

Rejected, with reasons, so they are not re-litigated: **COSMO-REA6** (ends 2019; gets the Med summer
daytime cycle wrong), **SPHERA** (ends 2020; no published wind fields), **NEWA** (no 30 m level),
**Global Wind Atlas** (no time series), **CMEMS L4 winds** (a 10 m stress-equivalent wind and ERA5
underneath — inside the bay it is interpolated from offshore), **Open-Meteo's CERRA** (stops June 2021
and carries only 10/100 m).

### 3.3 Stations

| Station | Height / exposure | Record | Role |
|---|---|---|---|
| **Capri LIQC 16294** | 269 m (NOAA), on the island; sheltered for speed (pilot) | 1973 →, **gap ~1990–2004**, hourly from ~2005 | Regime and onset-timing witness; direction; NOT speed |
| **Ponza LIQZ 16280** | 185 m island, open Tyrrhenian, 100 km W | 1965 → | Upwind gradient-wind reference for the regime classifier |
| **Napoli Capodichino LIRN 16289** | 10 m over land, inland basin | 1951 →; **station-id change 1998** | Sea-breeze arrival at the coast (timing only) |
| **Capo Posillipo** (ISMAR-CNR) | 27 m mast on a 108 m headland (≈135 m ASL), open to SW | Dec 2013 →, 30-min mean + gust, PANGAEA CC-BY | The best documented near-course station; second calibration target for the transfer test |
| **ISPRA RMN Napoli** (port mole) | ~10 m (to confirm), harbour, sheltered N–E | 1998 → | Sector-screened check of SW breeze strength at sea level |
| Parthenope network (Ischia S. Domenico, Procida, Sant'Agata dei Due Golfi, Posillipo buoy, Marina di Stabia) | Mixed; metadata not published | 2000s → | Ring around the course; by request |
| Grazzanise, Salerno, Palinuro | Land / other side of the peninsula | Long | Homogeneity and regime context only |

Height rule: **no station is lifted to 30 m by a log law.** The elevated ones sit near the top of a
200–500 m-deep breeze layer and the land ones carry a roughness change on top of the height change.
Each enters through a regression per regime and sector against CERRA, never as a profile.

### 3.4 Forecast archives and SSA's MOS (in hand)

- Open-Meteo historical forecasts: **ICON-2I from 13 Apr 2025**, ICON-EU and ARPEGE from Nov 2022,
  IFS 9 km from 2017 — read on the **sea cell** (`cell_selection=sea`) exactly as the app reads them.
- The shipped Sorrento specs (`src/components/weather/mos/mos_sorrento.json`, refitted 28 Oct 2026):
  ECMWF diurnal 4.60→3.34 kn, ICON-EU sector 4.82→3.52, ARPEGE and ICON-2I raw. They were fitted on
  May at 10–17 h and have **never been tested outside May**.

## 4. Spatial and temporal frame

- **Course areas**: to be named by the organiser (open question 1). Until then, three boxes: *Sorrento*
  (the N72 box, 40.60–40.70 N, 14.30–14.45 E), *mid-bay* (40.70–40.78 N, 14.18–14.32 E) and
  *Posillipo/Naples* (40.78–40.83 N, 14.18–14.28 E). Every reanalysis cell is chosen by **land–sea mask
  fraction = 0**, not by distance — the same lesson as `cell_selection=sea`. At ERA5's 0.25° the nearest
  points to the course are on Posillipo and Vesuvius; only sea points are used and that limitation is
  reported.
- **Clocks**: everything is held in UTC; the logs' time column is venue-local (CEST, +2) and is
  converted on the way in. Reported in local time.
- **Years**: climatology **1991–2025** (35 summers, WMO-normal-like), plus a **recent 2011–2025**
  version, plus CERRA's whole 1985 → record for the trend.

## 5. Method

### 5.1 Data preparation and QC

1. Download with `scripts/naples-study/cds_fetch.py` (§8a), **10 May – 2 Aug, 1985–2026, 09–15 UTC
   only**:
   - **CERRA** wind speed + direction at 15/30/50 m: analyses 09/12/15 UTC plus the +1/+2 h forecasts
     from 09 and 12 (10, 11, 13, 14 UTC). **Measured on the CDS: CERRA has no area or point option**,
     so every field arrives for all of Europe. The script requests one month of one product at a time,
     crops to the bay box on arrival and deletes the full file: ~150,000 fields, **measured at
     2.3 MB each in GRIB** (5.3 MB in NetCDF, same values bit for bit, so GRIB it is), ~345 GB
     passing through, ~2 GB on disk at any moment, a few MB kept — 154 cells over the bay. The CDS catalogue lists
     CERRA **through 31 Aug 2026**, so the 2025 and 2026 summers are in.
   - **ERA5** single levels (10/100 m wind, gust, 2 m T and dewpoint, SST, BLH, MSLP, cloud) and
     850/700 hPa u, v, T — these DO crop server-side (`area`), so they are small and fast. ERA5's
     31 m model level would need MARS tape retrieval; the 10/100 m pair is used instead.
   - The CERRA land–sea mask and orography once, to keep sea cells only.
2. Stations: decode ISD/METAR, QC (spikes, stuck values — the same frozen-channel test SSA uses on
   logs — calms coded as 999), homogeneity checks at the known breaks (Capri ~1990–2004, LIRN 1998).
3. N72: drop the bad bin, add the 2-minute re-extraction, keep the regatta and day labels for blocking.

### 5.2 Validate the reanalysis at 30 m against the masthead

Pair N72's bins with CERRA 30 m (time-interpolated from the analysis and the +1/+2 h steps, and
separately at analysis times only, to see whether the forecast steps add error) and ERA5 L136.

- Bias, rmse, correlation; by hour, by sector (SW-W / N-NE / E-S — the bands already used), by speed bin.
- The **tail bars** from `src/lib/mosFit` (keep ≥ 90 % of strong-wind hits, top-bin error within 2 kn)
  — a reanalysis that cannot produce the 16 kn afternoons cannot be the backbone of Q2.
- Diurnal composite: does CERRA fill the breeze at 12:30–14:30 or late?
- Vertical: CERRA's own 15/30/50 m shear on the N72 days vs the same in late June — the reanalysis's
  estimate of how much stability changes the 30 m wind between the seasons.

**Gate**: if CERRA's 30 m afternoon bias on sea-breeze days is not stable across the three regattas
(leave-one-regatta-out), the backbone is ERA5 + correction instead, and the plan says so in the report.

#### Result of the gate — 24 Nov 2026 (`scripts/naples-study/validate_n72.py`)

75 masthead hours (≥ 3 ten-minute bins within ±30 min of a model hour), 19 days, three May regattas,
both models at the boat's position and lifted to N72's real **32 m** masthead.

| at 32 m, kn | bias | rmse | r (hourly) | r (daily) | share 6–25 kn | share ≥ 12 kn |
|---|---|---|---|---|---|---|
| N72 masthead | — | — | — | — | 85 % | 24 % |
| CERRA raw | −1.15 | 4.46 | 0.29 | 0.22 | 75 % | 25 % |
| ERA5 raw | −2.80 | 4.44 | 0.47 | 0.50 | 57 % | 11 % |

Raw, CERRA's *distribution* is the closer one. But the gate asks whether a correction **transfers to a
regatta it was not fitted on**, and only ERA5's does:

| held-out rmse, kn (fit on 2 regattas, score the 3rd) | raw | + bias | a·x + b | quantile map |
|---|---|---|---|---|
| CERRA | 4.46 | 4.96 | 4.04 | 4.93 |
| ERA5 | 4.44 | **3.61** | 3.27 | 3.85 |

CERRA's bias by regatta is −0.6, −3.5 and **+2.0** kn (2026: 13–16 kn on 25–26 May against 6–8
measured), so a correction learned on two years makes the third worse. ERA5's is −2.2, −3.8 and −2.0.

**Decision: the 30 m backbone is ERA5 + a bias (or quantile-mapped) correction, not CERRA.** `a·x+b`
has the lowest rmse and is NOT used: it is the shrinkage the Med MOS audit warns about — held out, it
puts **0 %** of 2024's and 2026's hours at ≥ 12 kn against 31 % and 17 % measured. CERRA stays in the
study for what ERA5 cannot do at 0.25°: **relative** differences across the bay (Sorrento vs mid-bay vs
Posillipo), applied as ratios to the corrected ERA5 series, and as a second opinion on regime timing.

Also settled:
- **CERRA `wind_direction` is already true north.** Raw offset vs the masthead's true TWD is −2.2° and
  −2.6° in 2024 and 2025; adding the 4.8° grid rotation makes it −13.6° overall. `gridrot` is not applied.
- **The obs clock is UTC.** A lag sweep leans slightly towards the model 1–2 h early (r 0.29 → 0.44 for
  CERRA, 0.47 → 0.50 for ERA5), but the event files carry +2 h, the 2024 log reads 10:09 local before a
  10:51 local first phase, and n falls from 75 to 54 across the sweep — not a clock error.
- **Neither model makes the strong afternoons**: of 18 hours ≥ 12 kn at the masthead, CERRA has 8 and
  ERA5 6, and both are ~5 kn low above 14 kn. The tail is the weakest part of the study and §5.4 must
  carry the bias by speed bin, not one number.
- **2026 directions disagree by ~34° with BOTH models**, mostly on 26 May (obs 220°, models 277–289°).
  Both agreeing suggests the boat; unresolved, and worth a look at that day's raw log.

Caveat in proportion: three regattas, 75 hours, all in **May**. This answers "which reanalysis carries a
correction from one Sorrento regatta to another", not yet "from May to July" — that is still §5.4's
station-based transfer.

### 5.3 Classify every day by regime

On 1985–2025, each day 30 May – 2 Aug (and May for comparison) gets one label from ERA5 and CERRA, and is
checked against the stations' diurnal turn:

| Regime | Rule (to be tuned on the N72 days and Capri/LIRN) |
|---|---|
| **Pure sea breeze** | 850 hPa wind < ~6 m/s, no front; onshore (SW) turn at the coast between 10 and 15 local after offshore/calm morning (Borne et al. 1998 filter; Azorin-Molina thresholds) |
| Sea breeze on a SW gradient | as above but gradient 6–10 m/s from 180–270° |
| **Maestrale / NW** | 850 hPa ≥ 8 m/s from 270–340° |
| Tramontana / Grecale | gradient from 340–80° that the breeze does not overturn |
| Scirocco / SE | gradient from 100–170° |
| **Heat-dome suppressed** | sea-breeze day with 850 hPa T above the window's 90th percentile (subsidence cap) |
| Unsettled | everything else (troughs, convection) |

Cross-checked with an unsupervised k-means on the hourly CERRA wind at the course (Di Bernardino et al.
2022 method) — two independent labellings that agree are worth more than one tuned one.

### 5.4 Correct the reanalysis to the masthead (MCP, regime-conditioned)

1. Fit **CERRA-30 m → N72** per regime × hour band (11–13, 13–15, 15–17 local) × sector, on May. Forms
   from the same ladder as SSA's MOS (raw → a·x+b → + sector → + diurnal), chosen by leave-one-regatta-out
   CV, **with the tail bar**, and with the slope-pinned-at-1 fallback. A variance-ratio form is tried
   beside OLS because OLS shrinks the variance the race-able question depends on.
2. **Measure the May → July transfer error on data we do have in both seasons.** Fit the same
   CERRA → station relation for Capo Posillipo (2014–2025) and ISPRA Napoli on **May only**, then test it
   on **June–July**. The degradation, per regime, is the transfer error, and it is added to the
   uncertainty of every corrected number. Done on two stations so one sheltered anemometer cannot
   decide it.
3. Apply the per-regime corrections to the window's days and **reweight by the window's regime
   frequencies**, so the correction learned on May's mix is applied to July's mix.
4. Stability term: if 5.2 shows CERRA's 30/15 m ratio differs materially between May and July, the
   correction is fitted on the **15 m** wind and lifted by CERRA's own July shear, so the fitted part
   does not carry May's stratification into July.

If step 2 shows the transfer error exceeds the correction itself, **the study ships CERRA raw with its
validated bias stated** rather than a correction that cannot be shown to hold in July. Saying "no
correction" with the measurement beside it is the same discipline as `not_shipped`.

### 5.5 Climatology products (from the corrected 30 m series)

For the race window, and pentad by pentad across 30 May – 2 Aug:

- Hourly P10/P25/P50/P75/P90 of TWS; hourly wind roses; mean and spread of TWD by hour.
- P(TWS inside limits) by hour; P(≥ 3 race-able hours between 11 and 17) per day; P(≥ 4 of 5 days
  race-able) by Monte-Carlo over whole historical race weeks (preserving day-to-day persistence, not
  independent days).
- On sea-breeze days: onset time, onset direction, peak TWS and its hour, afternoon veer (deg/h).
- Regime frequencies, and the afternoon wind under each.
- Gust factor and 10–30 min direction σ from N72's 2-minute data (the only 30 m gust record), scaled by
  regime; cross-checked with Posillipo's 30-min gusts.
- Spatial: ratio maps across the bay from CERRA (and MERIDA/Parthenope WRF if granted), normalised to the
  Sorrento box so the pattern, not the bias, is shown.
- May vs window comparison panel — what the crew's May experience does and does not carry over.

### 5.6 Uncertainty and trend

- **Block bootstrap by year** (hourly lag-1 autocorrelation ~0.9 means 35 summers of hours are a few
  hundred independent samples, not thousands). Every percentile and probability carries a 90 % interval.
- Interannual spread shown explicitly (the pilot already shows Capri's window mean ranging 2.9–5.2 kn, 2013–2025).
- Trend: Sen's slope + Mann-Kendall on afternoon 30 m speed and sea-breeze-day frequency, 1985–2025.
  A published Western-Med decline of up to 10 %/decade (Bedoya-Valestt et al. 2026) makes this a test,
  not a footnote. If significant, the headline is the recent 2011–2025 climatology.
- Total uncertainty = sampling (bootstrap) ⊕ correction CV error ⊕ May→July transfer error (5.4.2).

### 5.7 Forecast skill in the window (Q8)

For June–July 2025 and 2026, score ICON-2I, ICON-EU, ARPEGE and IFS (raw and with the shipped Sorrento
MOS) against the corrected CERRA series and Posillipo. The question is whether the May-fitted MOS should
be **switched off in July** via a seasonal window, as AROME's is at St Tropez. A correction that holds in
May and hurts in July is exactly what the `seasonal` mechanism exists for.

## 6. Deliverables

1. **Study report (PDF)** — the answers to Q1–Q9, figures first, each with its uncertainty, plus the
   May-vs-July panel and the methods appendix.
2. **Two-page race-week brief** for the crew — the typical day, the regime odds, the onset/veer pattern
   and what to watch in the morning forecast to tell which regime it is.
3. **Data products**: hourly corrected 30 m series per course box (CSV), the regime labels per day, and a
   venue climatology JSON the Weather tab can show beside the forecast.
4. **MOS recommendation**: keep / seasonally window / refit the Sorrento specs, with the measurement.
5. Reproducible scripts (dry-run by default, `--write` to emit), in the repo next to `mos-med-refit.ts`.

## 7. Work packages and order

| WP | Content | Depends on | Runs where |
|---|---|---|---|
| 0 | CDS key + licences (§8a) | — | Wouter |
| 1 | Download + QC: CERRA, ERA5, ISD stations, Posillipo (PANGAEA) | 0 | laptop (`cds_fetch.py`) |
| 2 | Reanalysis vs masthead validation + gate (5.2) | 1 | laptop |
| 3 | Regime classification (5.3) | 1 | laptop |
| 4 | Regime-conditioned MCP + transfer test (5.4) | 2, 3 | laptop |
| 5 | Climatology, bootstrap, trend (5.5–5.6) | 4 | laptop |
| 6 | Forecast skill + MOS recommendation (5.7) | 1, 4 | laptop |
| 7 | Report, brief, data products | 5, 6 | here + `docs:pdf` |
| opt | MERIDA / Parthenope WRF / ISPRA spatial layer | deferred: Copernicus first | laptop |

WP1 is the long pole: CDS queue time for ~40 summers of CERRA is days, not hours — **measured on
23 Nov 2026, one CERRA height-level request waited ~1 h 40 min in the queue** where the ERA5 and
CERRA single-level ones ran in minutes. **Pilot first on
2024–2026** — those are also the N72 summers, so the validation gate (5.2) can run on the pilot alone
and decide whether CERRA is the backbone before the other 39 summers are fetched.

## 8. Decisions (taken 23 Nov 2026)

| | Decision |
|---|---|
| Event | **2027**, racing 29 Jun – 3 Jul (Tue–Sat) |
| Wind limits | **6–25 kn** TWS at 30 m; "good racing" 8–20 kn reported alongside |
| Hours | **11:00–17:00 local only** (09–15 UTC), in the download and in every statistic |
| Data | **Copernicus first** (CERRA + ERA5) plus the open stations (NOAA ISD, PANGAEA). Requests to Parthenope, ISPRA and RSE are deferred |
| Height | 30 m; 32/35 m also reported from CERRA's levels at no cost |
| Course areas | **Still open** — the three default boxes in §4 are used until the organiser names them |

### 8a. Setting up the CDS API (once)

1. Sign in at <https://cds.climate.copernicus.eu> — the login itself is on ECMWF's own site,
   `accounts.ecmwf.int`, which the CDS redirects to. Checked working 23 Nov 2026.
2. Accept the licence on each dataset's *Download* tab (bottom, "Terms of use"):
   <https://cds.climate.copernicus.eu/datasets/reanalysis-cerra-height-levels?tab=download>,
   <https://cds.climate.copernicus.eu/datasets/reanalysis-cerra-single-levels?tab=download>,
   <https://cds.climate.copernicus.eu/datasets/reanalysis-era5-single-levels?tab=download>,
   <https://cds.climate.copernicus.eu/datasets/reanalysis-era5-pressure-levels?tab=download>. A request against an
   un-accepted licence fails with a 403 naming it.
3. Copy the **API Token** from <https://cds.climate.copernicus.eu/profile> and store it — typed at a hidden prompt, never into chat:
   `cd /Users/wouterverbraak/Code/ssa && touch .env.local && sed -i '' '/^CDSAPI_/d' .env.local && read -s "k?CDS API key: " && printf '\nCDSAPI_URL=https://cds.climate.copernicus.eu/api\nCDSAPI_KEY=%s\n' "$k" >> .env.local && unset k && echo saved`
   — into the repo's gitignored `.env.local`, which `cds_fetch.py` reads (it falls back to `~/.cdsapirc`).
4. Environment: `python3 -m venv ~/.venvs/naples-study && ~/.venvs/naples-study/bin/pip install -r scripts/naples-study/requirements.txt`
5. Prove it: `~/.venvs/naples-study/bin/python scripts/naples-study/cds_fetch.py check` — one CERRA
   field and one ERA5 hour; it fails loudly on a bad key or a missing licence.

## 9. Risks

| Risk | Effect | Mitigation |
|---|---|---|
| No 30 m truth inside the window | The correction may not transfer | Regime conditioning + measured transfer error (5.4.2); raw-with-bias fallback |
| CERRA too smooth for Capri/peninsula effects | Q6 under-resolved | Parthenope WRF / MERIDA layer; report the limitation plainly |
| CERRA has no area subsetting | ~345 GB through the disk, slow | Month-by-month crop-and-delete in `cds_fetch.py`; pilot on 2024–26 first |
| ~~CERRA `wind_direction` relative to its grid~~ | — | **Closed 24 Nov**: it is true north (5.2 result); `gridrot` is kept in the files but not applied |
| Stations sheltered or elevated | Biased truth | Used only for regime, timing, direction and the transfer test, never lifted to 30 m |
| Western-Med breeze trend | Old summers overstate today | Trend test; recent-15-year headline if significant |
| Heat-dome years cluster | Interannual spread larger than sampling suggests | Year-block bootstrap; regime frequency reported separately |

## Sources

Patra et al. 2025, *Adv. Sci. Res.* 22:69 (ERA5/CERRA/COSMO-REA6 on the French Med coast) ·
CERRA height levels, CDS `reanalysis-cerra-height-levels` · ERA5 L137 level definitions (ECMWF) ·
Sheridan et al. 2025, *Wind Energ. Sci.* 10:1451 (MCP with short/seasonal campaigns) ·
Basse et al. 2021, *WES* 6:1473 · Mifsud et al. 2020, *WES* 5:601 ·
Borne et al. 1998, *Int. J. Climatol.* 18:901 · Azorin-Molina et al. (sea-breeze selection algorithms) ·
Di Bernardino et al. 2022 (Lazio wind clustering) · Bedoya-Valestt et al. 2026, *Sci. Rep.*
(Mediterranean sea-breeze trends) · Saviano et al. 2021, *Remote Sens.* 13:1333 and 2023, 15:2991
(Gulf of Naples HF radar, wind regime) · Cianelli et al. 2013 · Pugliese Carratelli et al. 2004, WIT
Trans. 68 · Cosentino, Yachting World (AC38 Naples conditions) · Tokyo 2020 Enoshima hindcast,
*Climate* 9:80 (2021) · NOAA ISD on AWS Open Data · ISMAR-CNR Capo Posillipo, PANGAEA
doi:10.1594/PANGAEA.896272 · ISPRA mareografico.it.

*Literature figures marked in the research notes as abstract-only were not re-verified against full text;
the pilot table is computed, not quoted.*
