# Analytics tab — automated performance charts (plan, 2026-09)

Goal: generate the KND SailingPerf WebReport charts and tables automatically in the
SSA Analytics tab, from the log + event (XML) files we already upload. No scraping —
KND builds its report from the same two files.

Validation day: **2026-09-11 Races 5&6** (Northstar 76), already loaded in SSA.
KND reference: `kndwebreport.azurewebsites.net/Reports/View?idProject=56&idRegatta=504&idRaceReport=1643`.

## What KND shows (catalogued 2026-09-14)

| KND tab | Content | SSA step |
|---|---|---|
| Upwind X-Y Plots (15) | One dot per 30 s phase vs TWS, Port/Stbd + trend per tack: BSP, \|SOG\|, \|TWA\|, \|AWA\|, \|HEEL\|, TRIM, \|FORESTAY\|, RUDDER, JibTack, Vang, Cunningham, Mainsheet, BSPpol% (vs TWS and vs \|TWA\|), VMG%. Overlays: polar target (`upPolar`), season curves (`upbsp-25`, `upbsp-26`) | 1–4, 6 |
| Downwind X-Y Plots (16) | Same set downwind + UpDfclt%, LwDfclt% | 1–4, 6 |
| Performance Graphs | BSP vs TWA per TWS band (20/22/24 kn), Port/Stbd vs polar | 5 |
| Polar | VPP polar curves (tws18–24) | 5 |
| Wind Plot | TWD + TWS vs time | exists (LineChart) |
| Loads | V1_WWD / V1_LWD vs TWS + stats table by mode/sail/tack | 7 |
| Upwind / Downwind Report | Tables: by sail+tack, TWS-band matched Port vs Stbd, VMG by TWA band, VMG by heel band + headlines | 7, 9 |
| AI POI / Tack Gybe | Tack & gybe table: time to 95 % BSP, distance lost (wind/GPS), max rotation, BSP before/after, turn angle vs target | 8 |
| Main / Jib Lidar | CA/DR/TW at 25/50/75 % vs log targets (`T_MN_*`, `T_JIB_*`) | 10 |
| Race Chart / Starts | Track replay, starts from −300 s | out of scope (GPSTrackMap/timeline) |

## Acceptance numbers (from the KND 11 Sep report, no download needed)

Phases: 139 of 30 s, 12:18–14:56 → Upwind 89 (Port 50 / Stbd 39), Downwind 49 (Port 27 / Stbd 22), Reaching 1.

| Mode · Tack | n | TWS | BSP | TWA | AWA | %Pol | VMG% | Heel | Trim | Rud | Fsty (t) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Up · Port (J4_A) | 50 | 23.1 | 11.88 | 39.7 | 26.4 | 98.2 | 96.0 | 21.9 | −0.8 | −0.7 | 16.16 |
| Up · Stbd (J4_A) | 39 | 23.7 | 11.73 | 39.1 | 26.4 | 98.0 | 95.5 | 22.4 | −0.8 | 0.6 | 16.20 |
| Down · Port (A2+B/J4_A) | 27 | 23.1 | 21.47 | 146.2 | 80.1 | 97.6 | 95.4 | 13.7 | 0.0 | 3.1 | 7.75 |
| Down · Stbd (A2+B/J4_A) | 22 | 23.6 | 21.47 | 146.2 | 82.3 | 96.5 | 94.5 | 10.8 | 0.2 | 2.8 | 7.59 |

Tolerance: ±0.05 kn BSP, ±0.2 kn TWS, ±0.5° angles, ±0.5 pt percentages, exact phase counts.
Per-phase check (optional, needs approval to download): `Phase report_Northstar 76_20260911.xlsx`.

## What SSA already has

- `logData.rows` — flat rows with bsp, sog, twa, awa, tws, heel, trim, forestay, fstyPin, rudder,
  jibTackLoad, vang, cunninghamLoad, mainsheetLoad, upDflctPct, lwDflctPct, vsPerfPct, vsTargPct,
  vmg, targVmg, v1p/v1s … (`src/lib/flatLogParse.ts:31`).
- `xmlData.phases` — `{utc, endUtc, mode}` with sailingmode 1/2 up, 4/8 down, 16/32 reach
  (`src/lib/xmlEventParse.js:76`); `sailsUpEvents`, `tackJibes`, `raceGuns`.
- `activeSailsAt` (`src/lib/scanEnrich.ts:24`), polar parse/interp (`src/lib/polarCalc.js`).
- Hand-built SVG `XYPlot` (`SmartSailingAnalytics_UI.jsx:3967`), `SpeedPolar`, `TackChart`;
  existing "Upwind analysis" section plots raw samples, not phase means (`:4900`).

## Steps

### Step 0 — Confirm the phase source and channel mapping (half a day)
1. Load the 11 Sep session in the dev server; count `xmlData.phases` and their durations/modes.
   Expect 139 × 30 s split 89/49/1. If they match, KND's phases *are* the event-file phases and
   we use them directly. If not, fall back to fixed 30 s bins classified by TWA sign/band.
2. Settle the mode→tack mapping against KND (mode 1 = Stbd upwind, 2 = Port upwind per the
   comment at `:4906`; confirm with the Port 50 / Stbd 39 counts).
3. Map every KND channel to an SSA key and check it has data in the 11 Sep log:
   BSP→bsp, SOG→sog, TWA→twa, AWA→awa, HEEL→heel, TRIM→trim, RUDDER→rudder,
   JibTack→jibTackLoad, Vang→vang, Cunningham→cunninghamLoad, Mainsheet→mainsheetLoad,
   UpDfclt%/LwDfclt%→upDflctPct/lwDflctPct, BSPpol%→vsPerfPct, VMG%→vmg/targVmg (verify),
   **FORESTAY→ fstyPin or forestay?** (KND shows tonnes, 16.2 t → likely `fstyPin`),
   **V1_WWD/V1_LWD → v1p/v1s swapped by tack?** (verify). List any column not parsed yet.
4. Save a trimmed 11 Sep fixture (phases + the columns above, 1 Hz) for tests, outside git if large.

### Step 1 — Phase aggregation library `src/lib/phaseStats.ts` (1–2 days)
- `computePhaseStats(rows, phases, sailsUpEvents, opts) → PhaseStat[]`
  `{utc, endUtc, mode:'up'|'down'|'reach', tack:'port'|'stbd', sails, n, mean:{[key]:number|null}}`.
- Channel registry (`key, label, unit, abs, circular, modes`) — one place that drives charts,
  tables and tests. `|x|` channels (TWA, AWA, HEEL, SOG, FORESTAY) averaged as magnitudes;
  TWD/HDG circular.
- Sample hygiene: plausibility caps per channel, min 5 valid samples per phase, skip log gaps.
- Vitest: synthetic unit tests + **acceptance test against the table above** using the fixture.

### Step 2 — Grouping helpers (½ day)
- `groupPhases(stats, by: ['mode','tack','sails','twsBand','twaBand','heelBand'])` → n + means.
- Same acceptance table as a test (this is exactly KND's "by sail combination and tack").

### Step 3 — `PhaseXYPlot` component (1–2 days)
- New file `src/components/analytics/PhaseXYPlot.jsx` (the UI file is ~9 k lines; new analytics
  code goes in `src/components/analytics/`). Hand SVG like `XYPlot`, no new chart dependency.
- Port/Stbd colours + marker shapes, one trend line per tack (quadratic fit, KND-style),
  optional polar target line, optional reference curves (step 6), `n` in the corner.
- Hover: phase time, sails, value. Click: `onSelectUtc` → seek timeline/video (reuse `playUtc`).
- Works at 400 px width (one column) and with < 3 phases ("too few phases").

### Step 4 — "Performance charts" section in `AnalyticsTab` (1–2 days)
- `src/components/analytics/PerfChartsSection.jsx`, rendered under the existing header,
  gated by `canSeeAnalyticsData`.
- Sub-tabs: **Upwind · Downwind · Speed vs TWA · Loads**.
- Filter bar: race (from `raceGuns`) or all day · sail combo · TWS range · tack toggle.
- Small-multiples grid (1/2/3 columns) driven by the channel registry; hide channels with no data.
- Memoise `computePhaseStats` per session; render charts lazily when scrolled into view.
- Once validated, retire the raw-sample "Upwind analysis" scatters (`:4900`).
- Verify in the dev server with the 11 Sep session, side by side with KND.

### Step 5 — Speed vs TWA per TWS band + polar overlay (1 day)
- BSP vs |TWA| per 2 kn TWS band (bands present in the day), Port/Stbd dots, polar curve
  interpolated at band centre via `polarInterp`.
- Dependency: the polar is only in localStorage today (`loadPolarFromLS`). Decide: per-boat polar
  in Supabase (recommended) so charts are the same for every crew member.

### Step 6 — Reference ("season") curves (2–3 days)
- KND's `upbsp-25/26` are per-season curves. Build them from our own history: persist
  `PhaseStat[]` per session (Supabase table, e.g. `session_phase_stats`, EU project, RLS by team),
  then fit binned medians by TWS per channel/mode/season/sail.
- Show as dashed lines; toggle per season. Also the base for multi-day comparison and for the
  AI analyst "run" unit (`docs/ai-analyst-roadmap-2026-07.md`).

### Step 7 — Report tables (1–2 days)
- Upwind/Downwind report: by sail+tack · TWS-band matched Port vs Stbd · VMG by TWA band ·
  VMG by heel band (all from `groupPhases`).
- Loads stats summary: mean/max per mode+sail+tack for the load channels.
- Acceptance: KND 11 Sep Upwind/Downwind report tables.

### Step 8 — Tack & gybe table (2 days)
- Start from `xmlData.tackJibes`, add 1 Hz detection for manoeuvres the export misses
  (KND: 13 tacks / 5 gybes, export caught 4 / 3).
- Metrics: time to 95 % BSP, distance lost vs wind (VMG) and GPS, max rotation rate,
  BSP before/after, turn angle vs target (70° tack / 60° gybe). Reuse `TackChart`'s baseline window.
- Acceptance: KND Tack Gybe tab rows for 11 Sep.

### Step 9 — Automate on upload + written headlines (2 days)
- Compute and store phase stats when a log + XML pair finishes processing; recompute when the
  polar or sail inventory changes. Charts open instantly, no recompute on the phone.
- Headlines ("tacks are level today", "Stbd fuller main") generated from the grouped tables with
  Mistral (existing sovereign AI setup), numbers passed in, never computed by the model.

### Step 10 — Lidar (later, depends on log columns)
- Parse CA/DR/TW 25/50/75 and `T_MN_*` / `T_JIB_*` targets; measured-vs-target tables with KND's
  filters (caps CA 0–20, DR 20–80, TW 0–60; target floors; 1.5×IQR). Acceptance: KND Main/Jib Lidar tabs.

## Order and checkpoints

Steps 0–4 are the first release (≈1 week): phase-averaged Upwind/Downwind grids matching KND.
Checkpoint after step 1 (numbers match) and after step 4 (visual side-by-side).
Steps 5–8 add the remaining KND content; 9–10 make it hands-off.

## Decisions (2026-09-14)

1. KND Phase report downloaded → `fixtures/local/knd-phase-report-2026-09-11.csv` (gitignored, client data).
2. FORESTAY = pin load. Registry reads `fstyPin ?? forestay` (the N76 Sept export's Forestay column is the load, 16 t).
3. Polars stored per boat in Supabase (`polars` table, one active + full version history). Upload lives in Boat → Targets.
4. Retire the raw-sample upwind scatters, but carry their styling and hover behaviour over to the new charts.

## Progress

**Step 0 — done.**
- Event-file phases = KND phases: 139 × 30 s on 11 Sep, identical start times.
- `<sailingmode>` is not tack-specific: 1 = upwind, 2 = reaching, 8 = downwind. Tack = sign of mean TWA (+ = stbd).
  (The old Upwind-analysis comment "1 = stbd up, 2 = port up" is wrong for these files.)
- Cloud log is 6 s between rows (5 per phase) — still reproduces KND's group means.
- KND `Rud` = RUDD_P on stbd tack, −RUDD_S on port tack. `V1_WWD/LWD` = V1 S/P swapped by tack.
- BSPpol% / VMG% come from KND's polar **37m-VPP-76 v1.6**; SSA's active "V1.4 Targets" gives ~96–97 % upwind
  (KND 98) and ~107 % downwind (KND 97) → needs v1.6 uploaded before those two channels can match.

**Step 1 — done.** `src/lib/phaseStats.ts` (`computePhaseStats`, `groupPhases`, `CHANNELS`).
Tests: `phaseStats.test.ts` (synthetic) + `phaseStats.fixture.test.ts` (opt-in, 11 Sep vs KND: phase count,
mode/tack/sails per phase, group means within tolerance). %Pol/VMG% acceptance is a todo pending the v1.6 polar.

**Polar upload — done.** `src/lib/polarFile.ts` (Expedition + grid parser, workbook import, `buildPolarData`,
`polarFromData`), `src/lib/xlsxRead.ts` (dependency-free .xlsx reader), `PATCH /api/teams/[teamId]/polars/[id]`
(activate a version), Boat → Targets: upload form (one row per version in a workbook) + version list.
- "NS76 Polar Development History.xlsx" stored on 2026-09-14: 37m-VPP-76 v1.2 … v1.7 (notes + target sheets),
  **v1.7 active**. Only v1.7 has a valid-from date (the workbook has none for the others).
- Stored polars are read with LINEAR interpolation between grid points (`preparePolar(…, {interp:'linear'})`):
  the natural spline overshoots at upwind angles on the 5° VPP grid (upwind stbd BSPpol% 0.6 pt off KND).
- With v1.6 the 11 Sep BSPpol% / VMG% group means match KND within 0.5 pt (test passes); v1.7 is identical that day.

**Step 2 — done.** `groupPhases(stats, by, { edges })` with keys mode · tack · sailCombo · race · twsBand ·
twaBand · heelBand; KND band labels ("under 21", "21-23", "25 plus"); automatic edges on multiples of 2 kn / 2° /
4° (downwind TWA) across the middle 80 % of the day; `race` from the event-file start guns.
- `bandOf` on KND's own phase values reproduces all six band tables of the 11 Sep reports exactly.
- On our phases, 82–92 % land in the same band as KND. The gap is resolution, not logic: the cloud log has
  5 samples per phase (KND 30), TWA per phase differs by median 0.2–0.3°, so narrow 2°/4° TWA bands shift by up
  to 4–5 phases. Computing phase stats from the full-resolution log at import (step 9) would close it.

**Step 3 — done.** `src/components/analytics/PhaseXYPlot.jsx` + pure helpers `src/lib/phasePlot.ts`
(`phasePoints`, `linearTrend`/`tackTrends`, `plotDomain`, `polarTargetLine`).
- Carries the old XYPlot look and hover: port ▲ #7DD3FC / stbd ● chart colour, legend, grey veil over the other
  tack with the hovered tack redrawn larger with a white outline, dashed reference `yLines` (e.g. 100 %).
- Added: one dotted trend per tack (R² per tack), dashed polar target line (best-VMG BSP or TWA vs TWS),
  per-phase tooltip (venue time, tack, value, sails, samples), click/tap → `onSelectUtc(phase.utc)`,
  ring on the phase containing `activeUtc` (playback).
- Axis labels come from the `CHANNELS` registry. R² per tack sits in the legend (in the plot it collided with dots).

**Step 4 — done.** `src/components/analytics/PerfChartsSection.jsx`, mounted in `AnalyticsTab` as
"Performance charts — 30 s phases"; the raw-sample "Upwind analysis" section is removed.
- Upwind (15 charts) / Downwind (17 charts) grids in KND order; channels without ≥3 phases are hidden.
- Filters: race (named from the start guns: "Race 5", "Race 6"), sail combination (when >1), tack.
- BSPpol% / VMG% and the polar target line use the boat's ACTIVE polar (fetched per open); without one the
  log's own PolBsp% is shown and VMG% is hidden, with a warning chip.
- Click a dot → `jumpToUtc`: opens the clip covering that moment (as the GPS track does — the clip starts at its
  beginning; seeking inside a clip would need player work), otherwise zooms the time series to −2/+2.5 min and
  scrolls to it.
- Verified in the dev app on 11 Sep: 89 up (P50/S39) · 49 down (P27/S22) · polar v1.7 · hover tooltip on the
  12:18:59 phase reads BSP 11.03 kn (KND 11.03) · click zoomed the time series to 12:30–12:34.
- Fixed during verification: duplicate React key on the hovered tack's trend line (guard test proven to fail
  without the fix).

**Step 5 — done.** "◎ Speed vs TWA" view in the Performance charts section (KND "Performance Graphs").
- One chart per 2 kn TWS band centred on even speeds (20 kn = 19–21, lower bound inclusive; `twsBands`),
  bands with ≥ 3 phases; BSP vs |TWA| over the whole day (up, reach and down), race/sails/tack filters apply.
- The active polar's curve for the band centre (`polarCurve`, 30–180° or the polar's coverage). Bands outside the
  polar's TWS range get no curve and say "beyond the polar" — v1.7 stops at 24 kn, which is likely why KND's tab
  shows only the 20/22/24 kn charts on 11 Sep.
- `PhaseXYPlot`: `showTrend={false}` for this view, x-axis domain includes the target curve, custom curve label.
- All charts now use round axis ticks (`niceTicks`: 1/2/2.5/5 × 10ⁿ steps) instead of evenly split raw ranges.
- Verified on 11 Sep: bands 20 (14 phases), 22 (46), 24 (56) with curves; 26 (16) and 28 (6) beyond the polar;
  ≥ 85 % of phases in the same wind band as KND (fixture test); tooltip, veil and ticks checked in the dev app.

**Step 6 — done.** (Migration 0060 run 2026-09-14.)
- `supabase/migrations/0060_session_phase_stats.sql`: one row per (boat, date) with the compacted phases
  (`compactPhases`), `stats_version`, `polar_id/name`, `season` (generated year). RLS mirrors `sessions`:
  read = boat access on that date; write = session-writing roles, only for readable dates; delete = coach/tl3/TM.
  Apply via the Supabase SQL editor (the repo's convention — no `supabase db push`).
- `POST /api/teams/:team/boats/:boat/phase-stats/:date[?ifStale=1]` computes server-side from the stored session
  (same `phaseStats` code, ACTIVE polar) and upserts; `ifStale` skips rows already at the current STATS_VERSION +
  polar. `GET …/phase-stats/:date` = summary. `GET …/phase-stats?exclude=date` = season curves (`seasonCurves`:
  median per 1 kn TWS bin, ≥ 4 phases, per season × point of sail × channel), only current-version rows.
  All answer 503 `{ needsMigration: true }` until the table exists (checked in the dev app).
- UI: opening a session stores its own stats (ifStale) then loads curves with that day left out; dashed season
  lines on the X-Y plots clipped to the day's TWS range; one toggle per season; "↻ Rebuild from all sessions"
  stores every session of the boat (skipping current rows).
- `polarCalc.js` lost its `'use client'` line (pure maths; the server route needs it).
- Data today: NS76 has 21 sessions with log + event file, all 2026 (25 Jun – 12 Sep) → one "2026" season
  curve at first. Season = calendar year; the active polar is used for every date (undated polar versions
  can't be matched to a day yet).
- Staleness (`statsAreCurrent`): a stored row is reused only if it has the current STATS_VERSION, the boat's
  active polar, and was computed after `sessions.updated_at` (trigger `sessions_touch` moves it on every
  update) — so a log uploaded later for a day is picked up. Found while checking the rebuild: 6 Sep has an event
  file with 223 phases but no log yet.
- Verified 2026-09-14 in the dev app:
  - 11 Sep stored: 139 phases, 3,284 log rows, polar v1.7; a second `ifStale` POST skipped it. Stored phases
    match an independent Python averaging of the fixture: 139/139, 0 mode/tack/n mismatches, max diff 0.0005.
  - Rebuild stored all 42 NS76 sessions (no failures): 15 with phases. Zero-phase days: 25–26 Jun, 11/14/30 Jul,
    2 Sep (event files without phases), 6 Sep (no log); 12 Jul and 9 Sep have 2 and 1 phases.
  - Curves with 11 Sep left out: 14 sessions, 2,084 phases; API medians equal a Python recomputation from the
    stored rows bin for bin (up and down BSP, counts identical). Season line drawn on all 14 upwind and
    16 downwind channel charts; the season toggle reads "┄ 2026 · 14 sessions".

**Step 7 — done.** "▦ Tables" view in the Performance charts section (KND Upwind Report, Downwind Report, Loads).
- `src/lib/reportTables.ts`: table specs in KND column order on top of `groupPhases` — Upwind: by sails × tack,
  wind-band matched Port vs Stbd, VMG by TWA band, VMG by heel band × tack; Downwind: by sails × tack, VMG by
  TWA band, wind-band matched; Loads: mode × sails × tack with means and maxima. Columns a boat doesn't log are
  dropped; without a polar %Pol comes from the log and VMG% is hidden. "Copy for Excel" = tab-separated.
- `src/components/analytics/ReportTable.jsx`; race / sails / tack filters apply to the tables.
- New channel `bspSog` (BSP/SOG %, mean of per-sample ratios, SOG ≥ 1 kn): 103.5 / 98.5 / 98.3 / 97.1 vs KND
  103.3 / 98.5 / 98.3 / 97.0. Additive, so no STATS_VERSION bump.
- TWS band edges now sit on odd numbers (bands centred on even speeds, as the speed-vs-TWA charts): the automatic
  upwind edges for 11 Sep are 21 · 23 · 25, exactly KND's. KND's TWA / heel edges aren't consistent (downwind
  wind bands use "under 22"), so those stay automatic (middle 80 %, 2°/4° steps).
- Maxima come from the ~6 s cloud log, so short peaks can read low (upwind stbd Fsty max 17.05 vs KND 17.22,
  V1_WWD max 10.03 vs 10.6) — never high; noted under the tables. Step 9 (full-resolution import) removes it.
- Fixture test: both "by sails and tack" tables (all columns incl. max) against KND's 11 Sep report numbers,
  with the v1.6 polar from the workbook. Verified in the dev app: all 8 tables on 11 Sep, no console errors.

**Step 8 — done.** "⟲ Tacks & gybes" view (KND "Points of interest" tack / gybe tables).
- `src/lib/manoeuvres.ts` + `src/components/analytics/ManoeuvreTable.jsx`; click a row → jump; Copy for Excel;
  "also show pre-start, after racing and mark roundings" toggle (greyed, not averaged); race + sails filters apply.
- Source: the event file's `tackJibes`, valid or not — it already lists every manoeuvre (KND's "export caught 4
  of the tacks" counts only the onboard-valid ones). TWA sign flips ≥ 6 kn in the log are the fallback when an
  event file has none.
- Judged = in a race (gun → 20 min before the next gun, or the event file's day stop) and not less than 30 s
  before a mark rounding → exactly KND's 13 racing tacks and 5 racing gybes on 11 Sep, at KND's times.
- Metrics fitted on the 6 s cloud log against KND's rows: BSP before −40…−10 s (±0.04 kn) · time to 95 % = first
  sample after the dip in the first 30 s back at 95 % of before, only after a real dip and unbroken log (±1.5 s) ·
  BSP at +20 s (±0.4 kn) · turn angle = heading −20…−5 → +15…+30 s (±2°) · distance lost = KND's 1 Hz method
  (VMG vs the 30 s before, −20…+60 s), n/a after a short hitch (< 60 s), with a mark rounding in the window or
  across a log gap (KND's 1 Hz tacks: 5 comparable, mean error ≤ 10 m; gybes indicative) · max rotation reads
  low at 6 s steps. No "distance lost over GPS": the cloud log rounds lat/lon to 0.01° (~1 km) — step 9.
- 11 Sep averages, ours vs KND — tacks: 95 % 28 / 28 s, turn 76.6 / 77.5°, BSP after 10.46 / 10.15 kn;
  gybes: 95 % 36 / 37 s, distance lost 85.2 / 85.9 m, turn 57.2 / 57.9°, BSP before 21.75 / 21.79 kn.
- Tests: `manoeuvres.test.ts` (scripted tack with exact answers, context, marks, hitch, gaps, log fallback) and
  `manoeuvres.fixture.test.ts` (KND tack + gybe rows).

**Step 9 — done.** (Migration 0061 run 2026-09-14.)
- A. Full-resolution stats. `supabase/migrations/0061_session_phase_stats_full_res.sql` adds `resolution_s`,
  `manoeuvres`, `headlines`, `headlines_model`, `headlines_at`. STATS_VERSION 2: stored phases carry maxima (`x`).
  - The importing device (full log in IndexedDB) computes phases + tacks/gybes from every row with the active
    polar and POSTs them (`src/lib/phaseStatsUpload.ts`) right after the log + event file reach the cloud
    (hook in the Upload tab's save), and again when it opens the day in Analytics if the stored copy is coarser.
  - `shouldReplace`: a stored row is replaced only when out of date (version, polar, session changed) or by
    clearly finer data — the ~6 s cloud copy never overwrites full-log stats. Replacing clears old headlines.
  - `preferStored`: a device with only the cloud copy draws charts / tables / tacks from the stored full-log
    stats when they have the same polar; a chip says which ("Full log · a row every 1 s" / "Cloud log · …").
  - Past days get full-resolution stats when opened (or re-imported) on the device that imported their logs.
- B. Headlines (`src/lib/headlineFacts.ts`, `POST …/phase-stats/:date/headlines`): Mistral on Scaleway (EU),
  model `SCALEWAY_AI_MODEL` (default mistral-medium-3.5-128b) gets FACTS = the report tables + tack/gybe lists,
  rounded as displayed, and must copy numbers only. `validateHeadlines` drops any sentence carrying a number not
  in FACTS (times and sail / sensor labels excepted). Stored on the row; Headlines card for everyone once
  written, "✦ Write headlines" for AI-enabled roles (`canUseAI`).
- Checked before the migration: the routes answer 503 needsMigration, Analytics keeps working from the local log.
- Verified after the migration (dev app, 2026-09-14):
  - 11 Sep stored at version 2: 139 phases with maxima, 34 manoeuvres (13 judged tacks), resolution 6.03 s
    (server-computed from the cloud copy). Rebuild re-stored all 42 NS76 sessions at version 2; the season
    curves are back (2026 · 14 sessions). Cloud-copy resolutions range 2–6.1 s by session length.
  - Headlines: Mistral (mistral-medium-3.5-128b) on Scaleway, 9–12 s per day, none dropped by the number check.
    Every claim checked against the tables — including row attribution (the number check only proves a number
    exists somewhere in FACTS). Two lessons folded in: (1) the first draft called 4–5-phase bands "best", and even
    with a prompt rule it leaned on a 1-phase heel row → band rows with n < 3 are left out of FACTS
    (`MIN_BAND_PHASES`), the prompt asks for in-table comparisons and n on thin rows; (2) the model returned 9
    headlines against "4 to 8" → counts capped in code (8 headlines, 3 bottom-line points).
  - Final 11 Sep draft reads like KND's: "Under 36 deg TWA gives VMG% 98.1, 42 plus deg gives 91.8",
    "20-22 deg heel Port: 99.3 %Pol, 96.8 VMG%, n 22; Stbd: 99.1 %Pol, 95.5 VMG%, n 16", tack / gybe averages.
  - Not verifiable here: the full-resolution upload path on real data — the original 11 Sep log is not on this
    machine; it runs on the device that imported the logs (unit-tested: `shouldReplace`, `preferStored`,
    `medianInterval`, section tests for stored-vs-local).
