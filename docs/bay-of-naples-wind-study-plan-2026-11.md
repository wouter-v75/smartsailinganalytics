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
| **CERRA height levels** (C3S, 5.5 km) | The only open, long, still-updated product that stores wind **at exactly 30 m** (levels 15/30/50/75/100… m). Best of the European reanalyses on the French Med coast (bias within ±10 %, diurnal bias ~−0.5 m/s, Patra et al. 2025). Grid fine enough to put several cells inside the bay | **Backbone, 2006 → latest available** (the last twenty summers; decided 24 Nov 2026). Hourly series from the 3-hourly analyses plus the +1 h and +2 h forecast steps; never leads beyond +6 h. 15 and 50 m too, for the shear |
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

### 3.5 On-site knowledge (Wouter) — an input with its own uncertainty

The models' known failure is exactly the regime the regatta is most likely to get, so experienced local
observation is a data source here, not colour. It is recorded as numbers with ranges, before the
CERRA spatial composite is looked at, so the comparison in §5.4 is honest:

Answered 24 Nov 2026 (Wouter, from racing and coaching on site). Sorrento is the reference zone.

| # | Question | Answer | Range / confidence | Against the N72 May data |
|---|---|---|---|---|
| S1 | Onset, peak, fade | Fills **11:30–12:00**, typically **30–60 min earlier than the models**; lasts until **~18:00** | firm | Agrees: at 11 local the masthead reads 6.4 kn against CERRA's 2.6; CERRA fades from 16 h while the masthead is still building. 18:00 is past the racing data, so not testable on N72 |
| S2 | Peak at masthead | A good sea breeze reaches **15–18 kn** | firm | Agrees: sea-breeze daily peaks 14–22 kn in 10-min bins (hourly means to 17.4) |
| S3 | Strongest zone | Strongest **deeper into the bay**: bottom of the bay (Castellammare – Torre Annunziata) = **Sorrento + 2 kn**; Naples = **Sorrento + 1–2 kn** | bottom firm; Naples **less sure** | Not testable from N72 (one zone). Becomes the prior for the zone factors in §5.4.4 |
| S4 | Direction | Set by the **morning gradient**. SE morning gradient: starts **160°**, veers to **250°**. NW morning gradient: starts **210°**, goes to **280–290°** | firm | Mixed on the 19 May days, but those are race windows only (first and last hour of racing), not onset-to-peak. Tested on the stations' full days instead (§5.3) |
| S5 | July vs May | **Not sure it is stronger — it may be LIGHTER**: a bigger chance of an inversion, and hot seawater | open, and the reason for the study | First look below: the drivers pull both ways |
| S6 | Killers | **Strong E–SE** gradient; an **inversion** layer | firm | 850 hPa is above the lid, so the proxy available (T850 − SST) does not separate the days. ERA5 1000/925 hPa (06–15 UTC) added to the fetch for this |
| S7 | Local features | **Capri** casts a big shadow in **SE–SSW**, which does **not** reach Naples. **Vesuvius** shadow in **NE–ESE** | firm | Becomes a direction-conditioned zone factor; CERRA's 5.5 km grid resolves Capri's wake only coarsely, Vesuvius better |

**S5, first look (2024–26 reanalysis, weak-gradient days, 850 hPa < 10 kn, 14:00 local).** Both of
the mechanisms are there, pulling against each other:

| | 10–31 May (43 d) | 15 Jun – 31 Jul (94 d) |
|---|---|---|
| SST over the bay | 19.9 °C | 26.6 °C |
| land 2 m T − SST (the breeze's engine) | 2.6 K | **4.4 K** — stronger |
| boundary-layer height | 301 m | **246 m** — a lower lid |
| T850 − SST (stability) | −9.0 K | **−7.8 K** — more stable |
| CERRA 30 m afternoon (13–16 h) off Sorrento | 7.9 kn | **7.3 kn** |

The land heats more than the sea warms, so the thermal contrast is larger in July; but the air above is
warmer relative to the water and the mixed layer shallower, which caps how much of that contrast turns
into wind. The model nets the two to **~0.6 kn lighter** (−0.65, +0.27, −1.44 kn by year). That is a
hint, not an answer: CERRA has no skill on individual sea-breeze days (§5.2), and the inversion
measure here is the boundary-layer height alone. The answer comes from §5.4.3, the stations, which
saw both seasons.

What these change in the method:
- **Two sea-breeze sub-regimes**, keyed on the morning (08 local) gradient direction: *SE-morning* (160 → 250°)
  and *NW-morning* (210 → 280–290°). Each gets its own direction track and its own masthead distribution
  as far as the 12 days allow; with few days per sub-regime the speed distribution may have to stay
  pooled and only the direction split.
- **A kill rule** in the classifier: strong E–SE gradient → no sea breeze; low-level inversion (1000/925 hPa
  lapse at 08–14 local) → suppressed. The rule is calibrated on the station archive, then counted in the
  window's 21 summers: *how many race days a year are lost to it* is one of the most useful single
  numbers the study can give a tactician.
- **Timing**: model onset is shifted **30–60 min earlier** on sea-breeze days, so any timing product is
  built from the masthead and stations and only the regime comes from the model.
- **Zone factors (sea-breeze days) — priors**: Sorrento 0, bottom of the bay **+2 kn (±1)**, Naples
  **+1.5 kn (±1, low confidence)**, Capri-shadow and Vesuvius-shadow sectors as direction-dependent
  reductions. CERRA's composite is then compared with these, not the other way round.

## 4. Spatial and temporal frame

- **Course areas**: to be named by the organiser (open question 1). Until then, three boxes: *Sorrento*
  (the N72 box, 40.60–40.70 N, 14.30–14.45 E), *mid-bay* (40.70–40.78 N, 14.18–14.32 E) and
  *Posillipo/Naples* (40.78–40.83 N, 14.18–14.28 E). Every reanalysis cell is chosen by **land–sea mask
  fraction = 0**, not by distance — the same lesson as `cell_selection=sea`. At ERA5's 0.25° the nearest
  points to the course are on Posillipo and Vesuvius; only sea points are used and that limitation is
  reported.
- **Clocks**: everything is held in UTC; the logs' time column is venue-local (CEST, +2) and is
  converted on the way in. Reported in local time.
- **Years**: climatology **2006–2025** (the last twenty summers; Wouter, 24 Nov 2026: no need to go
  back to 1985), with 2026 alongside as the season the N72 data and the stations also cover. Twenty
  summers is ~60 days of the regatta's own week and ~1,200 window days — enough for regime frequencies
  and percentiles; it is too short for a trend to mean much, so §5.6 reports one only as indicative.

## 5. Method

### 5.1 Data preparation and QC

1. Download with `scripts/naples-study/cds_fetch.py` (§8a), **10 May – 2 Aug, 2006–2026, 09–15 UTC
   only**:
   - **CERRA** wind speed + direction at 15/30/50 m: analyses 09/12/15 UTC plus the +1/+2 h forecasts
     from 09 and 12 (10, 11, 13, 14 UTC). **Measured on the CDS: CERRA has no area or point option**,
     so every field arrives for all of Europe. The script requests **one summer of one product** at a
     time (May–Aug, every day, the days outside the window dropped on arrival), crops to the bay box
     and deletes the full file: ~108,000 fields, **measured at 2.3 MB each in GRIB** (5.3 MB in NetCDF,
     same values bit for bit, so GRIB it is), ~250 GB passing through, ~7 GB per request on disk,
     a few MB kept. Month-by-month requests were tried first and sat **four hours in the CDS queue
     without starting** (24 Nov 2026); the queue, not the transfer, is the cost, and a summer is
     ~3,000 fields against the CDS's 90,000-field request limit. ERA5 stays monthly in its own pool — 154 cells over the bay. The CDS catalogue lists
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

First reading (pooled over all days): ERA5 + a bias correction carries from one regatta to the next and
CERRA does not. `a·x+b` has the lowest rmse and is NOT used — the shrinkage the Med MOS audit warns
about: held out, it puts **0 %** of 2024's and 2026's hours at ≥ 12 kn against 31 % and 17 % measured.

**Split by regime, the picture is sharper — and it is the known one.** Days classified from ERA5's
850 hPa wind over the bay at 14:00 local and the boat's own afternoon direction: **sea-breeze** = 850 hPa
< 10 kn and an onshore 180–290° afternoon (12 days, 50 h); **gradient** = 850 hPa ≥ 12 kn (6 days, 21 h);
one other (20 May 2025, SE).

| | n | masthead | CERRA bias / rmse / r | ERA5 bias / rmse / r |
|---|---|---|---|---|
| gradient days | 21 h | 11.8 kn | −1.2 / 2.65 / **0.73** | −2.2 / 3.25 / **0.79** |
| sea-breeze days | 50 h | 8.8 kn | −0.7 / 4.70 / **0.09** | −2.8 / 4.69 / **0.10** |

Sea-breeze afternoons, mean by local hour — masthead against model, and the ratio:

| local | 11 | 12 | 13 | 14 | 15 | 16 |
|---|---|---|---|---|---|---|
| N72 (kn) | 6.4 | 6.8 | 7.8 | 9.3 | 10.6 | 11.0 |
| CERRA | 2.6 (×2.4) | 6.0 (×1.13) | 8.4 (×0.92) | 9.1 (×1.03) | 10.0 (×1.06) | 8.8 (×1.25) |
| ERA5 | 4.7 (×1.36) | 4.6 (×1.48) | 5.5 (×1.41) | 6.6 (×1.41) | 7.4 (×1.42) | 6.5 (×1.69) |

What that says:
- **On gradient days both reanalyses work** (r 0.73–0.79, held-out rmse 2.6 kn for either once
  bias-corrected). The synoptic wind is what models are good at.
- **On sea-breeze days neither has any hour-to-hour skill (r ≈ 0.1).** No reanalysis knows WHICH
  afternoon fills to 15 kn and which stalls at 6. ERA5 under-does every afternoon by a steady ~40 % —
  the known sea-breeze under-forecast. CERRA gets the 12–15 h mean about right but starts late, fades an
  hour early, and is +2 kn one regatta and −3.5 the next.
- So on a sea-breeze day **the masthead is the wind**, not a correction to a model. The masthead's own
  distribution (p25 / p50 / p75: 13 h 6.8 / 7.8 / 9.0, 14 h 7.5 / 9.8 / 10.9, 15 h 7.5 / 10.7 / 13.4 kn;
  daily peaks 5.5–17.4) is what the climatology is built from.

**Decision (revised 24 Nov 2026): a regime-split backbone.**
- **Regime frequency** — how often the window gets a sea-breeze day, a gradient day, or something else —
  comes from the 21-summer reanalysis (850 hPa wind, MSLP, land–sea contrast). This is the part models
  do well and the part the masthead cannot supply.
- **Gradient days**: CERRA 30 m, bias-corrected (its raw is already the better of the two, and it
  resolves the bay).
- **Sea-breeze days**: the N72 masthead's empirical distribution by local hour, **shifted from May to
  late June** (§5.4) and **spread across the bay** with CERRA's relative pattern AND on-site knowledge (§3.5).
- ERA5 + bias is kept as the cross-check on every number; where it and the regime-split answer disagree
  by more than the stated uncertainty, the report says so.

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

On 2006–2026, each day 30 May – 2 Aug (and May for comparison) gets one label from ERA5 and CERRA, and is
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

### 5.4 Build the 30 m wind per regime (revised 24 Nov 2026 after the 5.2 result)

1. **Classify every day 2006–2026** (§5.3) from ERA5 alone, so the same rule applies to the N72 days and
   to the window. The rule used in 5.2 (850 hPa < 10 kn, onshore afternoon) needs the boat's direction;
   for the archive it becomes 850 hPa speed + direction, MSLP gradient and the land–sea contrast
   (ERA5 land t2m − SST, which ran 4–8 K on the strongest-breeze days and ~0 on gradient days). Checked
   by reproducing the 19 N72 days' labels.
2. **Gradient days → CERRA 30 m with a bias correction**, fitted on the N72 gradient hours (21 so far:
   −0.7 kn in 2024, −1.9 in 2025), one number or one per hour band, tail bar applied. Both seasons'
   synoptic winds are well modelled, so this transfers to July with the least argument.
3. **Sea-breeze days → the masthead's own distribution**, per local hour (11–17), from the 12 N72
   sea-breeze days. Then two adjustments, each stated as a factor with its uncertainty:
   - **May → late June/July — the study's central question, with NO assumed sign.** Two mechanisms
     compete: a larger land–sea contrast in July (+1.8 K on weak days, 2024–26) pushes the breeze up; a
     lower, stronger inversion over 26 °C water (boundary layer 246 m against 301 m) pushes it down,
     and on-site experience suspects the second wins. Measured, not assumed: the ratio of July to May
     sea-breeze-day afternoon wind at **Capo Posillipo and ISPRA Napoli** (both seasons on record), per
     hour, with BOTH covariates beside it — ERA5's land–sea contrast and the 1000/925 hPa inversion — so
     the result says not only *whether* July is lighter but *why*, and how often each wins. The factor
     may come out below 1. Capri, sheltered, contributes timing only.
   - **Across the bay** — see 4. The masthead sampled wherever the course was; the race area is fixed.
4. **Spatial pattern on sea-breeze days.** CERRA is wrong about the day but may be right about the
   SHAPE: the ratio of each zone (Sorrento, mid-bay, Posillipo) to the zone N72 sailed in, on the same
   hour. That ratio is taken from CERRA's sea-breeze composite, then **checked against the on-site
   knowledge in §3.5**, and where the two disagree the site knowledge wins with its stated range,
   because a 5.5 km model is exactly what is known to miss a breeze that lives in the last few km of
   coast. The decision and the numbers are both recorded, so the report shows which source set each zone.
5. **Mix the regimes with the window's frequencies** (step 1) into one 30 m distribution per zone and
   hour — the Q2/Q3 answers — with the uncertainty from (a) the N72 sample (day-bootstrap), (b) the
   May → July factor, (c) the spatial factor, (d) regime-frequency variability between summers.

The rule from before stands: a correction that cannot be shown to hold is not shipped. If the May → July
factor at the stations is not stable between them, the study gives the May masthead distribution with
the station range beside it rather than one invented July number.

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
- Trend: Sen's slope + Mann-Kendall on afternoon 30 m speed and sea-breeze-day frequency, 2006–2025 — indicative only over twenty summers.
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
| CERRA has no area subsetting | ~250 GB through the disk; the CDS queue is the bottleneck | Summer-at-a-time crop-and-delete in `cds_fetch.py`, ERA5 in a separate pool; pilot on 2024–26 done |
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
