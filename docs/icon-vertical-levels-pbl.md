# ICON 1 km — refining the vertical grid below 100 m (for windweight / rig profile)

**Status:** design note · 2026-06-26 · box-side change · feeds `windweight-spec.md` §4.1
**Goal:** more *native* model levels in the lowest ~100 m so the rig profile (0–34 m) and the boundary-layer shear are resolved, not extrapolated — while keeping the grid numerically sound for our 1 km / dt=6 s offline nest.

> All numbers below that describe the *current* run come from our own prior box findings (see memory `offline-nest-driving-fields`, `manual-icon-run-omp`). The exact live `num_lev` / `stretch_fac` / `max_lay_thckn` live in the box namelist — **confirm on the box** before editing.

---

## 1. Read-back — what we already established

1. **Current near-surface grid.** `min_lay_thckn = 10.5 m`, so the **lowest mass (full) level is ≈ 5.25 m** (the `z_ifc` check confirmed it). With ~**63 levels** and the standard stretch, only ~5–6 full levels fall below 100 m, and the rig band (0–34 m) gets roughly three (≈5, 16, 28 m). That is the coarse sampling the windweight profile term is fighting.
2. **A vertical-CFL incident set our timestep.** A +18 h run that reached **afternoon convection (17:00 local)** hit **tracer vertical CFL = 1.18 (>1)** at 63 levels / `dtime = 10 s`. The culprit was the **resolved convective updraft (`w`), not the level count**. Fix deployed: **`dtime 10 → 6 s`** (CFL ≈ 0.71). The earlier "+12 h proven baseline" never saw the afternoon peak — **so any grid change must be tested on a full-day (+18 h) run that reaches afternoon convection**, not a midday short run.
3. **An 80-level "AROME upgrade" namelist exists but is UNTESTED** — flagged to promote later only with `dtime ≤ 6 s` + a manual test. This is the natural starting point for the refinement.
4. **Do NOT chase AROME's 5 m first level.** ICON has no SURFEX canopy / roughness-sublayer scheme (Masson & Seity 2009 give SURFEX 6 prognostic canopy levels for exactly this). ICON's Monin-Obukhov surface layer **assumes the lowest level sits above the roughness sublayer**; ICON-D2 operationally uses a ~10 m lowest level and DWD deliberately avoids over-concentrating mass near the ground. **Our 5.25 m first full level is already at the aggressive end** — refine the *spacing through 0–100 m*, don't push the *first* level lower.
5. **The 1 km nest is an offline one-way nest** driven by **ICON-EU (74 levels)** via `init_mode = 7`, which vertically remaps the parent onto the nest grid (needs `z_ifc`/HHL in the parent `-M` stream). **Changing the nest's vertical grid = re-run parent then nest** (no `--skip-parent`); manual runs use the `OMP_NUM_THREADS=1` rule.

---

## 2. Constraint (i) — the levels must *fit* the ICON grid

You do **not** hand-place arbitrary heights. ICON's **SLEVE** generator (`sleve_nml`) builds a **smooth, monotonic, stretched** half-level set from a few knobs, with `top_height` fixed:

| Namelist knob (`sleve_nml`) | Meaning | Lever for "more levels < 100 m" |
|---|---|---|
| `min_lay_thckn` | geometric thickness of the **lowest layer** (m); ≤0.01 ⇒ all equal | keep ≈ **10.5–20 m** (first full level ~5–10 m); **do not lower** (finding 4) |
| `max_lay_thckn` (+ `htop_thcknlimit`) | cap on layer thickness below a height | **lower it** (e.g. ~400–600 m) so growth stays gentle and levels stay low |
| `stretch_fac` | >1 thickens layers toward the top | **reduce it** to bias resolution downward |
| `top_height` | model top (m ASL) | keep fixed (domain depth unchanged) |
| `flat_height`, `decay_scale_1/2`, `decay_exp` | terrain-following decay | leave at DWD defaults |
| `num_lev` (`run_nml`) | total level count | **raise to ~80–90** to fund the extra low levels without thinning aloft |

So the recipe is **raise `num_lev` and shape the low-level stretch** (smaller `stretch_fac`, moderate `max_lay_thckn`) so the new levels land in the PBL rather than the stratosphere. An explicit half-level table (`vct_a`) is the alternative, but it must stay smooth/monotonic — the namelist route is safer.

**Driving-model fit.** `init_mode = 7` interpolates the 74-level ICON-EU parent onto a *finer* child grid without trouble. The parent's ~10 m lowest level limits how much *new* near-surface detail the IC/BC carry, but the nest then **develops its own PBL structure via its turbulence scheme** over the integration — so the extra interior levels still pay off for the forecast (it's the interior, not the nudged lateral rim, that the race sees).

---

## 3. Constraint (ii) — computationally sound vs terrain, horizontal grid, timestep

- **Smoothness (the main soundness rule).** Keep the **adjacent-layer thickness ratio modest (≈1.1–1.25)** with no abrupt jumps. Sharp `dz` steps inject truncation error / vertical noise into advection and the pressure-gradient term. The SLEVE generator keeps this smooth *unless* you force a pathological `max_lay_thckn`/`stretch_fac` — verify the generated `z_ifc` thickness ratios after the change.
- **Timestep / CFL — vertical resolution is essentially *free* here.** ICON is **HEVI (horizontally-explicit, vertically-implicit)**: vertical acoustic and gravity-wave propagation is solved **implicitly**, so **thin near-surface layers do NOT tighten the acoustic CFL**. The binding limit is the **horizontal** explicit dynamics, i.e. `dtime` is set by **Δx (1 km)** — our proven-safe value is **6 s**. The one explicit *vertical* limit is **vertical advection CFL = w·dt/dz**; near the surface `w` is tiny so refining 0–100 m costs nothing, while the mid-troposphere convective updrafts are what bit us — hence **keep `dtime ≤ 6 s` and re-verify max vertical CFL < 1 on a full-day convective run** (finding 2).
- **Terrain matching.** Over water (terrain ≈ 0) the SLEVE terrain decay leaves levels flat — moot for the race area. Over **coastal/steep terrain**, thin near-surface layers + steep slopes can over-deform the coordinate; keep `decay_scale_*`/`decay_exp` and `flat_height` at defaults, rely on the existing topography smoothing to keep slopes within the SLEVE limit, and check the steepest coastal cells.
- **Cost.** ~80–90 levels vs 63 is **+30–40 % grid cells** on top of the already-halved `dtime` → meaningful wall-clock on the 8-core box (`OMP=1`, ranks = cores−1). Treat as an **experiment first**, not a silent production flip.

---

## 4. Concrete proposal for the lowest 100 m

**Current (approx, 63 lev / `min_lay_thckn` 10.5):** full levels ≈ 5, 16, 28, 42, 58, 78, 100 m → ~3 in the rig band.

**Target ("PBL-refined"):** ~**8–10 full levels below 100 m**, e.g. full levels near **5(/10), 15, 25, 35, 47, 60, 75, 92, 110 m** — layer thicknesses ~10–11 m near the surface growing at ratio ≈1.15. The rig (0–34 m) then gets **~4 levels** with one near the **34 m masthead**, and the windweight integral is sampled, not extrapolated.

**How:** start from the prepared 80-level config; **raise `num_lev` to ~80–90**, **reduce `stretch_fac`**, **cap `max_lay_thckn` ≈ 400–600 m**, **keep `min_lay_thckn` 10.5** (or raise toward ~20 for a cleaner ~10 m first level). Then publish matching diagnostic heights (`h_levels += 5,15,25,34`) so the app sees the refined column.

### 4a. Level-count options & cost (reconstructed — confirm vs box `z_ifc`)

**Current full (mass) levels below 300 m** (`min_lay_thckn` 10.5, ~63 lev, stretch ratio ≈1.3):
≈ **5, 17, 33, 53, 80, 115, 160, 218, 294 m** → **9 below 300 m, 5 below 100 m, 3 in the rig band (0–34 m)**.

| Option | Stretch (low) | Full levels < 100 m | < 100 m heights (≈ m) | in rig 0–34 m | total `num_lev` | nest wall-clock vs **current 6 s baseline** | 2 km parent re-run? |
|---|---|---|---|---|---|---|---|
| **Current** | ratio ≈1.30 | **5** | 5, 17, 33, 53, 80 | 3 | ~63 | — | — |
| **Intermediate** | ratio ≈1.12 | **7** | 5, 16, 29, 43, 58, 76, 96 | 4 | ~78–80 | **+25–30 %** | **No** |
| **Max (PBL-resolving)** | ~const 10–11 m to ~110 m | **9–10** | 5, 15, 25, 35, 46, 58, 71, 85, 99 (+11) | 5 | ~88–92 | **+40–45 %** | **No** |

**Why "No" on the 2 km parent.** Adding levels to the **1 km nest only** changes the *inner* `sleve_nml`; the 2 km parent's on-disk `_ml` + `z_ifc` stream is untouched, and `preprocess_nest` simply **re-remaps it onto the nest's new levels** (`init_mode = 7`). So you re-run **only the 1 km nest pipeline** (preprocess_nest + nest), *not* the parent. (The earlier "must re-run the parent" rule was specifically about changing the parent **`-M` variable roster**, which we are not doing.) The trade-off: the near-surface *initial/boundary* detail is still set by the 2 km parent's resolution at remap time — the nest then grows its own PBL structure via its turbulence scheme over the run, which is where the extra levels pay off.
- **If you also want finer IC/BC near the surface**, refine the **2 km parent's** grid too — *then* yes, re-run the 2 km parent (add roughly **+25–40 % of the parent's** runtime, parent being coarser/cheaper but larger-area). Not required for a first cut; recommended only if calibration shows the nest's near-surface state is IC-limited.

**Cost basis.** ICON cost is ~**linear in `num_lev`** (each level = one more horizontal slab per dynamics/physics step; the vertical-implicit tridiagonal solve is linear too). **`dtime` stays 6 s** — HEVI means the added near-surface layers don't tighten the acoustic CFL, and near-surface `w` is small so vertical-advection CFL is unaffected (the convective-updraft CFL that set 6 s is mid-troposphere and unchanged). So the wall-clock delta is essentially just the level-count ratio, on top of the 1.67× we already pay from the 10→6 s fix. Memory of box throughput (`OMP=1`, ranks = cores−1) applies; verify the actual minutes on a +18 h test.

### Promotion checklist (box)
1. Edit `sleve_nml` (`num_lev`, `stretch_fac`, `max_lay_thckn`) + confirm `min_lay_thckn`.
2. Keep **`dtime = 6 s`** (or lower if a test shows CFL pressure).
3. **Re-run parent** (z_ifc/HHL in the `-M` stream) **then** the nest — no `--skip-parent`; `OMP=1` manual rule.
4. **Full-day (+18 h) test through afternoon convection**; grep the log for **max vertical tracer CFL < 1**.
5. Check generated `z_ifc` thickness ratios (≤~1.25) and steepest coastal cells.
6. Add `5,15,25,34 m` to `h_levels`; verify the published profile + the windweight integral.
7. Note the wall-clock delta; decide prod vs experiment-only.

---

## 5. Step-by-step rollout — intermediate config (7 levels < 100 m, ~80 total)

**Scope:** refine the **1 km nest only** (`la_spezia_1km`, then the other venues). **No 2 km parent re-run.** Target: ~7 full levels below 100 m, ~78–80 `num_lev`, first full level ≈5–10 m, `dtime` stays 6 s. Do everything on a **branch / test cycle** first, never straight into `cron_daily`.

### Step 0 — Snapshot the current state (read-only)
- Record the live nest namelist values that aren't in the repo: `num_lev`, `sleve_nml` (`min_lay_thckn`, `max_lay_thckn`, `stretch_fac`, `top_height`, `flat_height`, `htop_thcknlimit`), `dtime`, `ndyn_substeps`.
- Dump the **actual** current vertical grid to replace the reconstructed numbers in §4a:
  `cdo -s -selname,z_ifc <nest_ml_output>.nc` → list half-level heights for the lowest ~20; confirm levels < 100 m and the first mass level.
- Record current **wall-clock** for the standard +18 h nest run (baseline for the cost delta).
- `git tag` / copy the current `run_icon.sh` + nest namelist as the rollback point.

### Step 1 — Design the target grid offline (no full model run)
- Goal distribution: full levels ≈ **5, 16, 29, 43, 58, 76, 96 m** then smooth stretch to `top_height`; thickness ratio ≤ ~1.15 low down.
- Candidate `sleve_nml` (tune from the Step 0 values): `min_lay_thckn = 10.5` (keep), `max_lay_thckn` **lowered** (start ~500 m, was higher), `stretch_fac` **reduced** (start ~0.9× current), `num_lev` **raised to ~80** so the slower low-level growth still reaches the same `top_height`. Leave `flat_height`, `decay_*` at defaults.
- **Preview the generated grid without a forecast:** run ICON **init-only** (a near-zero-length run, or the dedicated vertical-grid/`vct` generation) so it writes `z_ifc`, then dump the half levels. **Iterate `num_lev` / `max_lay_thckn` / `stretch_fac` here** until: (a) ~7 levels < 100 m, (b) first full level ≈5–10 m, (c) adjacent-thickness ratio ≤ ~1.25 everywhere (no jumps), (d) it still spans `top_height` monotonically. This loop is cheap — do it before any real run.

### Step 2 — Confirm no parent work is needed
- Verify the 2 km parent's `_ml` + `z_ifc` stream for the test date is on disk and complete (the inner IC/BC are remapped from it). No `-M` roster change ⇒ **do not** re-run the parent.

### Step 3 — Apply the change (test config)
- Edit the **nest** `run_icon.sh` / namelist: set the new `num_lev` + `sleve_nml` from Step 1. Keep `dtime = 6`, `OMP_NUM_THREADS=1`, ranks = cores−1, `num_prefetch_proc=1`, `init_latbc_from_fg=.TRUE.` (unchanged).
- Do **not** yet touch `h_levels` (keep output identical so the only variable is the grid).

### Step 4 — Rebuild IC/BC onto the new levels
- Run `preprocess_nest.sh` for the test cycle → it re-remaps the existing parent fields onto the new nest `vct` (`init_mode=7`).
- **Verify the level count propagated:** `cdo -s nlevel -selname,temp <latbc_...>.nc` and the IC file → expect the new `num_lev`. Confirm `z_ifc` present and hydrometeors full-level (the `normalise_tracer_levels` rule still applies upstream).

### Step 5 — Full-day convective test run
- Run the nest **+18 h, reaching afternoon convection (~17:00 local)** — the same window that previously hit CFL 1.18 — manually (`OMP=1`).
- **Acceptance greps on the log:**
  - `grep -iE "CFL" <log>` → **max vertical tracer CFL < 1** (target ≲0.8). If it creeps up, drop `dtime` to 5 s and note the extra cost.
  - no `init`/`latbc` aborts ("LATBC file not found", "nlev mismatch", "parent has no t=0 field").
  - run completes; record **wall-clock** → compute Δ vs Step 0 baseline (expect ~+25–30 %).

### Step 6 — Validate the physics/output
- Dump `z_ifc` from the test output → confirm the **7-levels-<100 m** distribution actually materialised.
- Sanity-check the near-surface wind profile vs the old grid on a calm hour (should be smooth, monotonic, no kinks at the new levels) and on the convective hour (more structure, still smooth).
- Spot-check the **steepest coastal cells** for over-deformed layers (max layer slope sane).

### Step 7 — Wire the finer published profile
- Add **`5, 15, 25, 34 m`** to `h_levels` in `run_icon.sh`; re-run the publish step (`publish_products.sh`) → new `grid.json`.
- Verify the app's vertical-profile / sounding sees the extra rig-band points and the **windweight integral** now samples them (cross-check `windweight-spec.md` §4.1).

### Step 8 — Promote + document
- If acceptance (CFL, stability, cost, profile) passes: fold the namelist + `h_levels` change into `cron_daily` / `run_nest` defaults; roll to the other venues (`porto_cervo`, `riviera`, …) one at a time.
- Update memory (`offline-nest-driving-fields`, `windweight-spec`) with the **confirmed** grid, the measured wall-clock delta, and the final `sleve_nml`.

### Step 9 — Rollback
- If CFL > 1 even at `dtime = 5 s`, instability, or unacceptable runtime: restore the Step 0 namelist/tag and re-run preprocess_nest + nest. (No parent involvement, so rollback is a single-pipeline revert.)

**Critical-path note:** the only steps that consume real compute are Step 1's short init-only previews and Step 5's one +18 h test. Everything before Step 5 is namelist editing + the cheap remap, so the iteration cost is low and fully reversible.

---

### Appendix — why HEVI makes this cheap
Explicit time-stepping of a thin-layer nonhydrostatic model would be throttled by the **vertical acoustic CFL** (sound speed ÷ `dz`), which is brutal for 10 m layers. ICON (like other HEVI cores) solves the **vertical** acoustic/gravity terms **implicitly** and only the **horizontal** terms explicitly, so the timestep is governed by the horizontal grid spacing, **not** by how thin the near-surface layers are. That is precisely why we can add resolution in the lowest 100 m without touching `dtime` — the only watch-item is the explicit **vertical advection** of strong updrafts, which is a `dtime`-and-convection issue, not a near-surface-spacing one.
