"""
Bayesian toe regression.

Model (per cell c = mode × TWS-bin):

    θ_c  ~  Normal( μ0(mode), τ0² )           ← strong prior on architect's rec
    y_ci ~  Normal( θ_c, σ_c² )               ← per-leg physics-implied optimal toe

with μ0 the architect's recommended toe for that mode and τ0 = Prior.prior_sd_deg
deliberately tight (22 days is little data — we don't let it run away from the
architect without real evidence).

Because both the prior and likelihood are Normal, the posterior is available in
CLOSED FORM — no sampler, no GPU, exact in microseconds:

    precision_post = 1/τ0² + n/σ_c²
    θ̂_c           = ( μ0/τ0² + Σ y_ci / σ_c² ) / precision_post
    sd_post        = sqrt( 1 / precision_post )

The output per cell is a toe value ± 95% credible interval — what the coach and
helm actually need — not a point estimate.

An optional `fit_pymc` is provided for the hierarchical upgrade (partial-pooling
the observation noise across cells) once sweep data exists; it is not needed for
the Phase-0 deliverable and is import-guarded so this module loads without PyMC.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

import numpy as np
import pandas as pd

from config import Config, CFG
from physics import solve_toe


# ─────────────────────────────────────────────────────────────────────────────
# Closed-form conjugate fit
# ─────────────────────────────────────────────────────────────────────────────
@dataclass
class FitResult:
    table: pd.DataFrame        # one row per cell, with posterior summaries.
    obs_sd_pooled: float       # the pooled observation SD actually used.


def _pooled_obs_sd(legs: pd.DataFrame, default: float = 0.5) -> float:
    """Pooled within-cell SD of the optimal-toe observations.

    Cells with <2 legs contribute nothing; if nothing qualifies we fall back to
    `default` degrees, a deliberately wide-ish noise so sparse cells stay humble.
    """
    parts = []
    for _, g in legs.groupby(["mode", "tws_bin"]):
        if len(g) >= 2:
            parts.append(g["optimal_toe_obs"].to_numpy())
    if not parts:
        return default
    # pooled SD around each cell's own mean.
    ss, dof = 0.0, 0
    for arr in parts:
        ss += np.sum((arr - arr.mean()) ** 2)
        dof += len(arr) - 1
    return float(np.sqrt(ss / dof)) if dof > 0 else default


def fit_conjugate(legs: pd.DataFrame, cfg: Config = CFG,
                  obs_sd: Optional[float] = None,
                  cred: float = 0.95, min_obs_sd: float = 0.05) -> FitResult:
    """Closed-form per-cell posterior. `legs` is the output of per_leg_table().

    `min_obs_sd` floors the observation noise so a degenerate cell (e.g. every
    leg returning an identical optimal toe) can't produce zero variance and an
    overconfident / divide-by-zero posterior.
    """
    z = {0.95: 1.959964, 0.90: 1.644854, 0.99: 2.575829}.get(cred, 1.959964)
    tau0 = cfg.prior.prior_sd_deg
    sd_pool = max(obs_sd if obs_sd is not None else _pooled_obs_sd(legs), min_obs_sd)

    rows = []
    # iterate over the full configured grid so empty cells still appear (prior-only).
    tws_labels = _tws_labels(cfg)
    for mode in ("upwind", "reach", "downwind"):
        mu0 = cfg.prior.mean_for_mode(mode)
        for tws_bin in tws_labels:
            g = legs[(legs["mode"] == mode) & (legs["tws_bin"] == tws_bin)] \
                if not legs.empty else legs
            n = int(len(g))
            # per-cell noise: own SD if enough legs, else pooled.
            if n >= 3 and g["optimal_toe_obs"].std(ddof=1) > 0:
                sigma = max(float(g["optimal_toe_obs"].std(ddof=1)), min_obs_sd)
            else:
                sigma = sd_pool

            prec = 1.0 / tau0 ** 2 + (n / sigma ** 2 if n > 0 else 0.0)
            if n > 0:
                ybar_term = g["optimal_toe_obs"].sum() / sigma ** 2
            else:
                ybar_term = 0.0
            mean_post = (mu0 / tau0 ** 2 + ybar_term) / prec
            sd_post = float(np.sqrt(1.0 / prec))

            # windward feasibility at the cell's median operating point.
            feasible, note = _cell_feasibility(g, cfg, mode)

            rows.append({
                "mode": mode,
                "tws_bin": tws_bin,
                "n_legs": n,
                "prior_toe": mu0,
                "toe_deg": round(mean_post, 3),
                "toe_sd": round(sd_post, 3),
                "ci_lo": round(mean_post - z * sd_post, 3),
                "ci_hi": round(mean_post + z * sd_post, 3),
                "obs_median": round(float(g["optimal_toe_obs"].median()), 3) if n else np.nan,
                "shrunk_to_prior": n == 0,
                "low_confidence": (mode == "downwind") or (n < 3),
                "windward_feasible": feasible,
                "note": note,
            })
    return FitResult(table=pd.DataFrame(rows), obs_sd_pooled=sd_pool)


def _tws_labels(cfg: Config):
    e = cfg.bins.tws_edges_kt
    labels = [f"{e[i]:g}-{e[i+1]:g}kt" for i in range(len(e) - 1)]
    labels.append(f"{e[-1]:g}+kt")
    return labels


def _cell_feasibility(g: pd.DataFrame, cfg: Config, mode: str):
    if g is None or len(g) == 0:
        return True, "no data — prior only."
    sol = solve_toe(float(g["leeway_med"].median()),
                    float(g["helm_med"].median()), cfg, mode=mode)
    return sol.windward_feasible, sol.note


# ─────────────────────────────────────────────────────────────────────────────
# Presentation: the 2D toe card + partial-dependence
# ─────────────────────────────────────────────────────────────────────────────
def toe_card(fit: FitResult, cfg: Config = CFG, value: str = "toe_deg") -> pd.DataFrame:
    """Pivot to the coach-facing 2D table: rows = mode, cols = TWS bin."""
    t = fit.table
    card = t.pivot(index="mode", columns="tws_bin", values=value)
    # order rows and columns sensibly.
    card = card.reindex(index=[m for m in ("upwind", "reach", "downwind") if m in card.index])
    card = card.reindex(columns=[c for c in _tws_labels(cfg) if c in card.columns])
    return card


def toe_card_labeled(fit: FitResult, cfg: Config = CFG) -> pd.DataFrame:
    """Same grid but each cell shows 'toe ±ci' as a string for printing/export."""
    t = fit.table.copy()
    t["label"] = t.apply(
        lambda r: f"{r.toe_deg:.2f}±{(r.ci_hi - r.toe_deg):.2f}"
                  + ("*" if r.low_confidence else "")
                  + ("!" if not r.windward_feasible else ""),
        axis=1,
    )
    card = t.pivot(index="mode", columns="tws_bin", values="label")
    card = card.reindex(index=[m for m in ("upwind", "reach", "downwind") if m in card.index])
    card = card.reindex(columns=[c for c in _tws_labels(cfg) if c in card.columns])
    return card


def partial_dependence(legs: pd.DataFrame, fit: FitResult, cfg: Config = CFG):
    """Data for a partial-dependence plot of recommended toe vs TWS, per mode.

    Returns a long DataFrame (mode, tws_mid, toe_deg, ci_lo, ci_hi) ready for a
    line-with-band plot. Plotting itself stays in the notebook.
    """
    e = cfg.bins.tws_edges_kt
    mids = {f"{e[i]:g}-{e[i+1]:g}kt": (e[i] + e[i + 1]) / 2 for i in range(len(e) - 1)}
    mids[f"{e[-1]:g}+kt"] = e[-1] + 2
    df = fit.table.copy()
    df["tws_mid"] = df["tws_bin"].map(mids)
    return df.sort_values(["mode", "tws_mid"])[
        ["mode", "tws_bin", "tws_mid", "toe_deg", "ci_lo", "ci_hi", "n_legs"]
    ]


# ─────────────────────────────────────────────────────────────────────────────
# Optional hierarchical PyMC fit (upgrade path; not needed for Phase 0)
# ─────────────────────────────────────────────────────────────────────────────
def fit_pymc(legs: pd.DataFrame, cfg: Config = CFG, draws: int = 2000,
             tune: int = 1000, seed: int = 0):
    """Hierarchical version that partial-pools the observation noise across cells.

    Returns (summary_df, idata). Requires `pymc` and `arviz`; raises a clear
    error if they're absent. Use this only once you have real sweep data and want
    pooled uncertainty — the closed-form `fit_conjugate` is the Phase-0 default.
    """
    try:
        import arviz as az
        import pymc as pm
    except ImportError as e:  # pragma: no cover
        raise ImportError(
            "fit_pymc needs `pymc` and `arviz` (pip install pymc arviz). "
            "For Phase 0 use fit_conjugate — it needs neither."
        ) from e

    if legs.empty:
        raise ValueError("No legs to fit. fit_pymc needs sweep data.")

    legs = legs.copy()
    legs["cell"] = legs["mode"] + "|" + legs["tws_bin"]
    cells = sorted(legs["cell"].unique())
    cidx = {c: i for i, c in enumerate(cells)}
    leg_cell = legs["cell"].map(cidx).to_numpy()
    y = legs["optimal_toe_obs"].to_numpy()
    mu0 = np.array([cfg.prior.mean_for_mode(c.split("|")[0]) for c in cells])

    with pm.Model() as model:
        sigma = pm.HalfNormal("sigma", sigma=0.7)               # pooled obs noise
        theta = pm.Normal("theta", mu=mu0, sigma=cfg.prior.prior_sd_deg,
                          shape=len(cells))
        pm.Normal("obs", mu=theta[leg_cell], sigma=sigma, observed=y)
        idata = pm.sample(draws=draws, tune=tune, random_seed=seed,
                          progressbar=False, chains=2)

    post = idata.posterior["theta"].stack(s=("chain", "draw")).values  # (cells, S)
    summary = pd.DataFrame({
        "cell": cells,
        "mode": [c.split("|")[0] for c in cells],
        "tws_bin": [c.split("|")[1] for c in cells],
        "toe_deg": post.mean(axis=1).round(3),
        "ci_lo": np.percentile(post, 2.5, axis=1).round(3),
        "ci_hi": np.percentile(post, 97.5, axis=1).round(3),
        "n_legs": [int((leg_cell == cidx[c]).sum()) for c in cells],
    })
    return summary, idata
