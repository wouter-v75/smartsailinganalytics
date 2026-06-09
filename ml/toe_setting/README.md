# Northstar 7X — twin-rudder toe-setting tool (Phase 0)

A physics-first decision-support tool to produce a **toe-setting card**
(recommended toe ± credible interval per condition) for the 7X work-up, in time
for **Block A, day 1**. Runs on a Mac in seconds, no GPU, no cloud, no vendor
ever sees the data.

This is the "Phase 0" deliverable from the SSA ML plan — the physics calculator
+ data loader + a small Bayesian regression. It is **not** the broad
performance-settings model (LightGBM + kNN); that's Phase 2 in the research
report. Toe setting is a geometry problem with a hydrodynamic target, so it sits
at the physics-first end of the spectrum.

## Why physics-first
The architect's brief is ~2° angle of attack on the leeward rudder, ~0° on the
windward. Given the measured operating point, the AoA on each rudder is an
analytic function of the toe:

```
AoA_lee  = common + toe/2
AoA_wind = common - toe/2
common   = flow_straightening · leeway + helm
```

So the toe controls only the **split** between the rudders. Two facts fall out:

- The equal-weight balanced toe is just the target spread (**2°** for the 2/0
  brief), independent of conditions — a strong sanity anchor.
- Whether you actually hit 2°/0° depends on the **common-mode** (leeway + helm),
  which the toe can't change. The tool flags cells where 2/0 is geometrically
  infeasible — those are trim/heel problems, not toe problems.

The only learning is a Bayesian nudge to the toe per (mode × wind-speed) cell,
anchored by a **strong prior** on the architect's recommendation, because 22
days is little data.

## Files
| File | What it is |
|---|---|
| `config.py` | **The one file you edit.** All architect-supplied numbers + channel-name mapping. Everything marked `TODO(architect)` is a placeholder. |
| `physics.py` | NumPy calculator: toe + heel + leeway + helm → AoA & load per rudder; inverts for the target toe; feasibility flags. |
| `data_loader.py` | Reads daily SSA log+event uploads (RLS-scoped Supabase REST or local JSON), segments legs, bins by (mode, TWS, sea-state), per-cell medians, robust windward duty-cycle stat. |
| `bayes_toe.py` | Closed-form Normal–Normal per-cell posterior → toe card ± credible interval + partial-dependence. Optional PyMC hierarchical upgrade. |
| `toe_setting_phase0.ipynb` | The three-cell notebook tying it together. |
| `export_sessions.py` | One-off: pull the 7X sessions to local JSON for offline work. |
| `make_synthetic.py` | Synthetic data so the pipeline runs before real sweeps exist. Dev only. |
| `selftest.py` | `python selftest.py` — physics identities, loader, Bayesian behaviour. |
| `build_notebook.py` | Regenerates the .ipynb from source (keeps it diffable). |

## Quick start
```bash
cd ml/toe_setting
pip install -r requirements.txt
python selftest.py          # should print ALL TESTS PASSED
jupyter lab toe_setting_phase0.ipynb
```
With no real data, the notebook synthesises a few days so it runs end-to-end.

## Connecting real data
The data lands in the SSA store from the daily log + event upload
(`sessions.log_data` = parsed logfile rows, `sessions.xml_data` = event markers).
Two read paths, both respecting v3 tenant isolation:

**Live (RLS-scoped):** set in your shell, then run the notebook —
```bash
export SSA_SUPABASE_URL=https://<project>.supabase.co
export SSA_SUPABASE_ANON_KEY=<anon key from .env.local>
export SSA_SUPABASE_TOKEN=<a logged-in 7X member's access token / JWT>
export SSA_BOAT_ID=<northstar 7x boat uuid>
export SSA_TEAM_ID=<team uuid>
```
The loader queries PostgREST under the user's JWT, so RLS returns only the
sessions that membership may see — same scoping as the app.

**Offline:** `python export_sessions.py` writes one JSON per session to
`data/7x_sessions/`, then unset the env vars and everything runs from disk.
Nothing leaves the Mac.

## What MUST be filled in before trusting the numbers
The structure and logic are correct today; the **calibration is not**. Ask the
architect for, and paste into `config.py`:

1. **Rudder section** (`Rudder.section`) — NACA 0012 or other.
2. **Lift-curve slope** ∂CL/∂α (`Rudder.lift_slope_per_rad`, set
   `lift_slope_from_geometry=False`). Best source: the architect's **CFD study
   or tank-test brief** — ask for it; it removes the biggest guess.
3. **Geometry** — `area_m2`, `span_m`, `cant_deg`, `sweep_deg`.
4. **Starting toe per mode** (`Prior.toe_*_deg`) — the prior means.
5. **Downwind target** — confirm whether 2°/0° holds downwind or differs
   (`Target.*_downwind`). Downwind is the harder case and cells are flagged
   low-confidence until this is settled.

Then, in the field:

6. **Block A (days 1–4):** calibrate `Flow.flow_straightening` against the VPP
   using `physics.calibrate_flow_straightening`, and check per-cell medians vs
   VPP before doing any sweeps.
7. **Leeway:** replace the crude proxy with the measured channel as soon as a
   sensor exists — set `Channels.leeway_is_measured=True` and the channel name.
   A wrong leeway biases the common-mode and therefore every toe.
8. **New 7X channel names** (`Channels.leeway / rudder_load_lee /
   rudder_load_wind / toe_of_record`) — set to whatever the logger actually
   emits.

## The windward "load on and off" problem
That's physics (partial ventilation as the boat heels), not a broken sensor. The
loader uses a **duty-cycle** statistic (fraction of a 60 s window above a load
threshold) instead of a raw mean — monotonic in real loading and smooth across
the ventilation cycles. Dock-calibrate the load cells before relying on either
the duty cycle or the leeward load.

## Card legend
`2.10±0.18` → toe 2.10°, half-CI 0.18°.
`*` → low confidence (downwind, or <3 legs in the cell).
`!` → 2°/0° geometrically infeasible at this cell's operating point — fix
trim/heel (common-mode), not toe.
