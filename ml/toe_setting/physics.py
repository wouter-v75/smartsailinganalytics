"""
Physics calculator for the Northstar 7X twin-rudder toe setting.

Pure NumPy, no learning. Given the geometry (toe) and the measured operating
point (heel, leeway, helm, boat speed), it computes the angle of attack and the
expected hydrodynamic load on EACH rudder, and inverts that to find the toe that
hits the architect's AoA target.

The whole "physics-first" reframing lives here:

    AoA_lee  = common + θ/2
    AoA_wind = common − θ/2
    where  common = flow_straightening · leeway  +  helm        (the common-mode)
           θ      = toe                                          (the split)

Two consequences worth understanding before you trust the numbers:

  • The toe controls only the SPLIT between the rudders. The equal-weight
    "balanced" toe that puts the two AoA errors on an equal footing is simply
        θ_balanced = AoA_lee_target − AoA_wind_target   (= 2° for the 2/0 brief)
    independent of the operating point. That is a strong sanity anchor.

  • Whether you actually achieve 2°/0° depends on the COMMON-MODE, which the toe
    cannot change — it's set by leeway and helm (i.e. by rig/sail trim and
    heel). If the common-mode isn't ≈1° you can hit 2 on the leeward OR 0 on the
    windward but not both. The calculator surfaces that tension instead of hiding
    it in a single point estimate.

All public angles are in DEGREES. Radians only appear inside the lift model.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Optional

import numpy as np

from config import Config, CFG

DEG = math.pi / 180.0


# ─────────────────────────────────────────────────────────────────────────────
# Lift-curve slope
# ─────────────────────────────────────────────────────────────────────────────
def lift_slope_per_rad(cfg: Config = CFG) -> float:
    """∂CL/∂α in 1/rad. Prefer the architect's number; else a finite-wing estimate.

    Finite-wing (Helmbold/low-AR) approximation:
        a = 2π·AR / (AR + 2)
    This is the lineage of the Whicker & Fehlner (1958) low-aspect-ratio
    control-surface work that every yacht VPP rudder module descends from.
    Sweep reduces the slope by cos(Λ).
    """
    r = cfg.rudder
    if not r.lift_slope_from_geometry:
        return r.lift_slope_per_rad
    ar = r.aspect_ratio
    a = (2.0 * math.pi * ar) / (ar + 2.0)
    a *= math.cos(r.sweep_deg * DEG)
    return a


# ─────────────────────────────────────────────────────────────────────────────
# Common-mode and per-rudder AoA
# ─────────────────────────────────────────────────────────────────────────────
def common_mode_deg(leeway_deg, helm_deg, cfg: Config = CFG):
    """The AoA both rudders share before the toe split. Array-safe."""
    leeway_deg = np.asarray(leeway_deg, dtype=float)
    helm_deg = np.asarray(helm_deg, dtype=float)
    return cfg.flow.flow_straightening * leeway_deg + helm_deg


def rudder_aoa_deg(leeway_deg, helm_deg, toe_deg, side: str, cfg: Config = CFG):
    """AoA on one rudder. side ∈ {'lee','wind'}. Array-safe.

    Toe is split symmetrically: leeward gets +θ/2, windward −θ/2.
    """
    toe_deg = np.asarray(toe_deg, dtype=float)
    common = common_mode_deg(leeway_deg, helm_deg, cfg)
    half = toe_deg / 2.0
    if side == "lee":
        return common + half
    if side == "wind":
        return common - half
    raise ValueError(f"side must be 'lee' or 'wind', got {side!r}")


# ─────────────────────────────────────────────────────────────────────────────
# Loads (secondary — for sanity-checking against the load cells)
# ─────────────────────────────────────────────────────────────────────────────
def _ventilation_factor(heel_deg, cfg: Config = CFG):
    """Expected fraction of full load the windward foil carries vs heel.

    A smooth ramp from `heel_onset_deg` (fully wetted → 1.0) to `heel_full_deg`
    (fully ventilated → 0.0). This is the EXPECTED knockdown; the instantaneous
    signal cycles on/off, which is why the loader uses a duty-cycle statistic
    rather than a raw mean.
    """
    heel_deg = np.asarray(heel_deg, dtype=float)
    v = cfg.vent
    frac = (cfg.vent.heel_full_deg - np.abs(heel_deg)) / (v.heel_full_deg - v.heel_onset_deg)
    return np.clip(frac, 0.0, 1.0)


def rudder_load_n(leeway_deg, helm_deg, toe_deg, bsp, heel_deg, side: str,
                  cfg: Config = CFG):
    """Expected hydrodynamic side load on one rudder, in Newtons. Array-safe.

    L = 0.5 · ρ · V² · A · CL,  CL = a · AoA(rad), in the linear (pre-stall)
    regime. The windward side is multiplied by the ventilation factor so it is
    directly comparable to the loader's duty-cycle-derived windward load.
    """
    aoa = rudder_aoa_deg(leeway_deg, helm_deg, toe_deg, side, cfg)
    a = lift_slope_per_rad(cfg)
    cl = a * (aoa * DEG)
    v_ms = cfg.kt_to_ms(np.asarray(bsp, dtype=float))
    q = 0.5 * cfg.flow.rho * v_ms ** 2
    load = q * cfg.rudder.area_m2 * cl
    if side == "wind":
        load = load * _ventilation_factor(heel_deg, cfg)
    return load


# ─────────────────────────────────────────────────────────────────────────────
# Inverse problem: solve for toe given a target
# ─────────────────────────────────────────────────────────────────────────────
@dataclass
class ToeSolution:
    toe_lee_priority_deg: float   # toe that puts AoA_lee exactly on target.
    toe_wind_zero_deg: float      # toe that puts AoA_wind exactly on target (≈0).
    toe_balanced_deg: float       # equal-weight compromise (= target spread).
    aoa_lee_at_balanced: float    # what the leeward sees at the balanced toe.
    aoa_wind_at_balanced: float   # what the windward sees at the balanced toe.
    common_mode_deg: float        # the operating-point common-mode.
    windward_feasible: bool       # can 2/0 be met within tolerance here?
    note: str


def solve_toe(leeway_deg: float, helm_deg: float, cfg: Config = CFG,
              mode: str = "upwind") -> ToeSolution:
    """Invert the AoA relations for a single operating point (scalars).

    Returns the three candidate toes plus a feasibility verdict. Feed it
    per-cell MEDIAN leeway/helm, never instantaneous samples.
    """
    if mode == "downwind":
        t_lee = cfg.target.aoa_lee_deg_downwind
        t_wind = cfg.target.aoa_wind_deg_downwind
    else:
        t_lee = cfg.target.aoa_lee_deg
        t_wind = cfg.target.aoa_wind_deg

    common = float(common_mode_deg(leeway_deg, helm_deg, cfg))

    # AoA_lee = common + θ/2 = t_lee  →  θ = 2(t_lee − common)
    toe_lee = 2.0 * (t_lee - common)
    # AoA_wind = common − θ/2 = t_wind  →  θ = 2(common − t_wind)
    toe_wind = 2.0 * (common - t_wind)
    # Equal-weight least squares compromise → θ = t_lee − t_wind (see module doc).
    toe_bal = t_lee - t_wind

    aoa_lee_bal = common + toe_bal / 2.0
    aoa_wind_bal = common - toe_bal / 2.0

    feasible = abs(aoa_wind_bal - t_wind) <= cfg.target.wind_feasibility_tol_deg
    if feasible:
        note = "2/0 target reachable at this operating point."
    else:
        excess = aoa_wind_bal - t_wind
        note = (
            f"Common-mode is {common:.2f}° (target ~{(t_lee - t_wind)/2:.2f}° for 2/0). "
            f"Windward will sit at {aoa_wind_bal:.2f}° (Δ{excess:+.2f}°). "
            "Toe alone cannot fix this — it's a trim/heel (common-mode) issue, "
            "not a toe issue."
        )

    return ToeSolution(
        toe_lee_priority_deg=toe_lee,
        toe_wind_zero_deg=toe_wind,
        toe_balanced_deg=toe_bal,
        aoa_lee_at_balanced=aoa_lee_bal,
        aoa_wind_at_balanced=aoa_wind_bal,
        common_mode_deg=common,
        windward_feasible=feasible,
        note=note,
    )


def per_leg_optimal_toe_deg(leeway_deg, helm_deg, cfg: Config = CFG,
                            mode: str = "upwind", objective: str = "lee"):
    """Vectorised per-leg optimal toe — the OBSERVATIONS fed to the Bayesian fit.

    objective:
      'lee'      → toe that lands the leeward rudder on its target AoA (default;
                   the leeward rudder is the one doing the steering work).
      'wind'     → toe that unloads the windward rudder to its target.
      'balanced' → equal-weight compromise (constant per mode).
    """
    if mode == "downwind":
        t_lee = cfg.target.aoa_lee_deg_downwind
        t_wind = cfg.target.aoa_wind_deg_downwind
    else:
        t_lee = cfg.target.aoa_lee_deg
        t_wind = cfg.target.aoa_wind_deg

    common = common_mode_deg(leeway_deg, helm_deg, cfg)
    if objective == "lee":
        return 2.0 * (t_lee - common)
    if objective == "wind":
        return 2.0 * (common - t_wind)
    if objective == "balanced":
        return np.full_like(np.asarray(common, dtype=float), t_lee - t_wind)
    raise ValueError("objective must be 'lee', 'wind' or 'balanced'")


# ─────────────────────────────────────────────────────────────────────────────
# Calibration helper for Block A (days 1–4)
# ─────────────────────────────────────────────────────────────────────────────
def calibrate_flow_straightening(leeway_deg: float, helm_deg: float,
                                  observed_aoa_lee_deg: float,
                                  toe_set_deg: float, cfg: Config = CFG) -> float:
    """Back out flow_straightening from one reference point.

    During Block A you sail the architect's toe and (ideally) get an AoA estimate
    on the leeward rudder from its load cell + the known lift slope. Then:
        observed_aoa_lee = k·leeway + helm + toe/2
        →  k = (observed_aoa_lee − helm − toe/2) / leeway
    Use 1–2 clean reference points, average, and paste the result into
    Flow.flow_straightening before running any sweeps.
    """
    if abs(leeway_deg) < 1e-6:
        raise ValueError("Need non-zero leeway to calibrate flow straightening.")
    return (observed_aoa_lee_deg - helm_deg - toe_set_deg / 2.0) / leeway_deg
