"""Build toe_setting_phase0.ipynb from source cells (keeps the notebook in git-
diffable form). Run: python build_notebook.py"""

import nbformat as nbf

nb = nbf.v4.new_notebook()
cells = []

cells.append(nbf.v4.new_markdown_cell(r"""# Northstar 7X — twin-rudder toe-setting (Phase 0)

**Goal.** Produce a *toe-setting card* — recommended toe ± credible interval for
each (mode × wind-speed) cell — for the 7X work-up, in time for **Block A, day 1**.

**Why physics-first.** Toe is a geometry problem with a hydrodynamic target. The
architect's brief is ~2° AoA on the leeward rudder, ~0° on the windward. Given
measured **heel / leeway / helm**, the angle of attack on each rudder is an
analytic function of the toe — no ML needed to compute it. The only learning is a
small Bayesian regression that nudges the toe per cell, anchored by a *strong*
prior on the architect's recommendation (22 training days is little data).

This notebook is three cells:
1. **Physics calculator** — toe + heel + leeway + helm → AoA & load per rudder; invert for the target toe.
2. **Data loader** — pull the daily SSA log+event uploads (RLS-scoped), bin by (mode, TWS, sea-state), per-cell medians.
3. **Bayesian regression** — closed-form per-cell posterior → the toe card ± credible interval + partial-dependence plot.

> ⚠️ **Calibration before trust.** Every architect-supplied number lives in
> `config.py` and is a *placeholder* until the architect replies. The shapes and
> logic are correct now; the absolute toe values are **not** until you paste in
> the real section, lift-curve slope, geometry and starting toe. See the README.
"""))

# ── Cell 1: physics ──────────────────────────────────────────────────────────
cells.append(nbf.v4.new_markdown_cell("## Cell 1 — Physics calculator"))
cells.append(nbf.v4.new_code_cell(r"""import numpy as np
from config import CFG
import physics as phys

print(f"Rudder section (placeholder): {CFG.rudder.section}")
print(f"Lift-curve slope ∂CL/∂α used: {phys.lift_slope_per_rad(CFG):.3f} /rad "
      f"({'geometry estimate' if CFG.rudder.lift_slope_from_geometry else 'architect value'})")
print(f"AoA target: leeward {CFG.target.aoa_lee_deg}°, windward {CFG.target.aoa_wind_deg}°\n")

# Example operating point (use per-cell MEDIANS in practice, never instantaneous):
leeway, helm, bsp, heel = 4.0, 1.5, 8.0, 12.0   # deg, deg, kt, deg
sol = phys.solve_toe(leeway, helm, CFG, mode="upwind")

print(f"Operating point: leeway={leeway}°, helm={helm}°, bsp={bsp}kt, heel={heel}°")
print(f"  common-mode AoA (both rudders share): {sol.common_mode_deg:.2f}°")
print(f"  toe to hit leeward target (2°):   {sol.toe_lee_priority_deg:+.2f}°")
print(f"  toe to zero the windward (0°):     {sol.toe_wind_zero_deg:+.2f}°")
print(f"  balanced toe (= target spread):    {sol.toe_balanced_deg:+.2f}°")
print(f"  at balanced toe → AoA lee {sol.aoa_lee_at_balanced:.2f}°, "
      f"AoA wind {sol.aoa_wind_at_balanced:.2f}°")
print(f"  windward 2/0 feasible here? {sol.windward_feasible}")
print(f"  note: {sol.note}")

# Per-rudder loads at the lee-priority toe (compare against the load cells):
toe = sol.toe_lee_priority_deg
for side in ("lee", "wind"):
    L = float(phys.rudder_load_n(leeway, helm, toe, bsp, heel, side, CFG))
    A = float(phys.rudder_aoa_deg(leeway, helm, toe, side, CFG))
    print(f"  {side:4s} rudder @ toe {toe:+.2f}°: AoA {A:5.2f}°, expected load {L:7.0f} N")
"""))

# ── Cell 2: data loader ──────────────────────────────────────────────────────
cells.append(nbf.v4.new_markdown_cell(r"""## Cell 2 — Data loader

Reads the daily log + event uploads from the SSA store. If `SSA_SUPABASE_URL` +
`SSA_SUPABASE_TOKEN` are set in the environment it pulls live via PostgREST under
your JWT (RLS-scoped to the 7X — same tenant isolation as the app); otherwise it
reads local JSON exports from `CFG.local_data_dir` (offline, nothing leaves the
Mac). Run `export_sessions.py` once to populate the local cache.

With no real data yet, we fall back to a **synthetic** day-set so the pipeline
runs end-to-end today. Delete that block once real sweeps land."""))
cells.append(nbf.v4.new_code_cell(r"""import os
import data_loader as dl

# --- DEV ONLY: synthesise data if the cache is empty. Remove for real use. -----
have_real = bool(os.environ.get("SSA_SUPABASE_URL")) or (
    os.path.isdir(CFG.local_data_dir) and any(f.endswith(".json") for f in os.listdir(CFG.local_data_dir))
    if os.path.isdir(CFG.local_data_dir) else False)
if not have_real:
    import make_synthetic as syn
    n = syn.write_synthetic(CFG.local_data_dir, n_days=6)
    print(f"[dev] wrote {n} synthetic sessions to {CFG.local_data_dir}")
# ------------------------------------------------------------------------------

sessions = dl.load_sessions(CFG)
print(f"Loaded {len(sessions)} session(s).")

legs = dl.per_leg_table(sessions, CFG)
print(f"Steady-state legs: {len(legs)}")
display(legs[["date","mode","tws_bin","tws_med","twa_med","sea_state","n",
              "heel_med","helm_med","leeway_med","wind_duty","optimal_toe_obs"]].head(12))

print("\nPer-cell operating envelope (Block A sanity check vs VPP):")
display(dl.per_cell_medians(legs))
"""))

# ── Cell 3: bayes ────────────────────────────────────────────────────────────
cells.append(nbf.v4.new_markdown_cell(r"""## Cell 3 — Bayesian regression → toe card

Closed-form Normal–Normal posterior per cell: strong prior on the architect's
recommended toe, moved only by real evidence. Output is **toe ± 95% credible
interval** per (mode × TWS) cell — plus a partial-dependence plot of toe vs wind.

Card legend: `*` = low confidence (downwind, or <3 legs); `!` = the 2°/0° target
is geometrically infeasible at that cell's operating point (a trim/heel issue,
not a toe issue)."""))
cells.append(nbf.v4.new_code_cell(r"""import bayes_toe as bt
import matplotlib.pyplot as plt

fit = bt.fit_conjugate(legs, CFG)
print(f"Pooled observation SD: {fit.obs_sd_pooled:.3f}°\n")

print("Toe card — value ± half-CI (°):")
display(bt.toe_card_labeled(fit, CFG))

print("\nFull per-cell posterior:")
display(fit.table[["mode","tws_bin","n_legs","prior_toe","toe_deg","toe_sd",
                   "ci_lo","ci_hi","low_confidence","windward_feasible"]])

# Partial-dependence: toe vs TWS, per mode, with credible band.
pdp = bt.partial_dependence(legs, fit, CFG)
fig, ax = plt.subplots(figsize=(8, 5))
for mode, g in pdp.groupby("mode"):
    g = g.sort_values("tws_mid")
    ax.plot(g["tws_mid"], g["toe_deg"], marker="o", label=mode)
    ax.fill_between(g["tws_mid"], g["ci_lo"], g["ci_hi"], alpha=0.15)
ax.set_xlabel("TWS (kt, bin midpoint)"); ax.set_ylabel("recommended toe (°)")
ax.set_title("Recommended toe vs wind speed (95% credible band)")
ax.legend(); ax.grid(alpha=0.3)
plt.tight_layout(); plt.show()
"""))

# ── Cell 4: export the card ──────────────────────────────────────────────────
cells.append(nbf.v4.new_markdown_cell(r"""## Cell 4 — Export the toe-setting card

The coach/helm-facing deliverable: a glanceable card as **HTML** (good on a
tablet on the dock; prints cleanly) and **PDF** (for pinning up). Read-only — the
engineer runs this notebook, the crew only ever sees the card.

Flip `calibrated=True` once the architect's numbers are in `config.py` and Block A
calibration is done; until then every card is stamped **PROVISIONAL**."""))
cells.append(nbf.v4.new_code_cell(r"""import datetime
import export_card as ec

today = datetime.date.today().isoformat()
html_path, pdf_path = ec.write_cards(
    fit, CFG, date=today, out_dir="cards",
    calibrated=False,          # ← set True after architect inputs + Block A calibration
    boat="Northstar 7X",
)
print("wrote:", html_path, "and", pdf_path)

# Preview the HTML inline.
from IPython.display import IFrame, display
display(IFrame(src=html_path, width="100%", height=420))
"""))

cells.append(nbf.v4.new_markdown_cell(r"""---
### Before you trust the numbers
1. Paste the architect's **section, ∂CL/∂α, area/span/cant, and starting toe per
   mode** into `config.py` (search `TODO(architect)`).
2. In **Block A (days 1–4)** calibrate `Flow.flow_straightening` against the VPP
   using `physics.calibrate_flow_straightening`, and replace the leeway proxy
   with the measured channel (set `Channels.leeway_is_measured = True` and the
   channel name) as soon as the sensor exists.
3. Re-run. The card updates; cells with `!` need a trim/heel fix, not a toe change.
"""))

nb["cells"] = cells
nb["metadata"] = {"language_info": {"name": "python"},
                  "kernelspec": {"name": "python3", "display_name": "Python 3"}}

with open("toe_setting_phase0.ipynb", "w") as f:
    nbf.write(nb, f)
print("wrote toe_setting_phase0.ipynb")
