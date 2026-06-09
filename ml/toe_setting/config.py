"""
SSA · Northstar 7X twin-rudder toe-setting tool — central configuration.

This is the ONE file you edit when the naval architect replies. Everything that
the physics calculator, data loader and Bayesian regression need comes from
here, so the rest of the code never hard-codes a number.

Anything marked `# TODO(architect)` is a placeholder. The defaults are
physically reasonable for a NACA 0012-ish rudder so the whole pipeline runs and
self-tests pass today, but DO NOT trust the numerical toe outputs until the real
values are dropped in. The structure of the answer is correct now; the
calibration is not.

Conventions (all angles in DEGREES at this layer; radians only inside physics):
  leeway   λ  — angle between the boat's heading and its track through the water,
                positive = bow points to windward of the track (boat crabs to
                leeward). The water therefore meets a centreline-aligned foil at
                angle λ.
  helm     h  — steering deflection of BOTH rudders together (they are linked),
                positive = bear-away helm. Use the median over a leg, never an
                instantaneous value.
  toe      θ  — the FIXED differential between the two rudders, positive = toe-in
                (leading edges toward centreline). Split symmetrically:
                    leeward rudder set angle  = +θ/2
                    windward rudder set angle = −θ/2
  AoA         — angle of attack of the water on a rudder.
  side        — 'lee' (leeward, loaded) or 'wind' (windward, wants ~0 load).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List


# ─────────────────────────────────────────────────────────────────────────────
# 1. Hydrodynamic target — from the architect.
# ─────────────────────────────────────────────────────────────────────────────
@dataclass(frozen=True)
class Target:
    # The architect's brief: ~2° on the leeward rudder, ~0° on the windward.
    aoa_lee_deg: float = 2.0       # TODO(architect): confirm.
    aoa_wind_deg: float = 0.0      # TODO(architect): confirm.

    # Downwind the "2/0" rule may not hold (low heel, both foils immersed).
    # Ask the architect for a separate downwind target; until then we reuse 2/0
    # but flag downwind cells as low-confidence in the output.
    aoa_lee_deg_downwind: float = 2.0   # TODO(architect): is downwind different?
    aoa_wind_deg_downwind: float = 0.0  # TODO(architect)

    # How far the achieved windward AoA may drift from target before we warn the
    # coach that the 2/0 target is geometrically infeasible at that operating
    # point (i.e. the common-mode is wrong, not the toe).
    wind_feasibility_tol_deg: float = 0.75


# ─────────────────────────────────────────────────────────────────────────────
# 2. Rudder section + geometry — from the architect's drawings / CFD / tank test.
#    ASK FOR THE CFD or TANK-TEST BRIEF. It gives the lift-curve slope directly
#    and removes the single biggest source of guesswork below.
# ─────────────────────────────────────────────────────────────────────────────
@dataclass(frozen=True)
class Rudder:
    section: str = "NACA 0012"     # TODO(architect): actual section.

    # Lift-curve slope ∂CL/∂α, per RADIAN. The thin-aerofoil ideal is 2π ≈ 6.28;
    # a finite, low-aspect-ratio surface in water is lower. If the architect
    # gives a number, paste it here and set `lift_slope_from_geometry = False`.
    lift_slope_per_rad: float = 4.0    # TODO(architect): from CFD/tank if available.
    lift_slope_from_geometry: bool = True  # if True, derive from aspect ratio below.

    # Planform — for the finite-wing slope estimate and for load magnitude.
    area_m2: float = 0.55          # TODO(architect): one rudder's planform area.
    span_m: float = 1.30           # TODO(architect): immersed span (draft of foil).

    # Shaft cant (rake from vertical) and sweep. Cant rotates the lift vector and
    # couples heel into effective AoA; sweep reduces the effective slope. Leave 0
    # until the architect confirms — the calculator handles non-zero values.
    cant_deg: float = 0.0          # TODO(architect): shaft cant from vertical.
    sweep_deg: float = 0.0         # TODO(architect): quarter-chord sweep.

    # Section zero-lift drag and induced-drag handling are only used for the
    # (secondary) load/drag estimate, not for the toe solve.
    cd0: float = 0.008             # profile drag coefficient, rough.

    @property
    def aspect_ratio(self) -> float:
        # Geometric AR of one rudder. Effective AR ~2x if it pierces the surface
        # cleanly (image effect); we use geometric here and let the architect's
        # slope override it.
        return (self.span_m ** 2) / self.area_m2


# ─────────────────────────────────────────────────────────────────────────────
# 3. Flow environment — how leeway becomes inflow at the rudder.
# ─────────────────────────────────────────────────────────────────────────────
@dataclass(frozen=True)
class Flow:
    # Keel/canard ahead of the rudders straightens the flow, so the rudder sees
    # LESS than the full leeway angle. ORC and every yacht VPP apply a
    # flow-straightening factor. 1.0 = rudder sees full leeway; 0.0 = fully
    # straightened. Calibrate this in Block A against the architect's VPP.
    flow_straightening: float = 0.65   # TODO(calibrate in Block A, days 1–4).

    # Water density (kg/m³). Salt ~1025, fresh ~1000. Set to your venue.
    rho: float = 1025.0

    # If the log's boat speed is in knots, convert to m/s for the load model.
    bsp_is_knots: bool = True

    # Leeway inference (used ONLY when Channels.leeway_is_measured is False).
    # Crude VPP-style proxy: leeway_deg ≈ k · heel_deg / bsp_kt². It captures the
    # right shape (more leeway when pressed and slow) but the constant is a guess.
    # Replace with a measured channel or the architect's leeway curve ASAP — a
    # wrong leeway feeds straight into the common-mode and biases every toe.
    leeway_infer_k: float = 25.0   # TODO(calibrate/measure): inference constant.
    leeway_min_bsp_kt: float = 2.0  # guard against divide-by-near-zero at low speed.


# ─────────────────────────────────────────────────────────────────────────────
# 4. Windward-rudder ventilation model — the "load on and off" problem.
#    This is physics, not a broken sensor: the windward foil partially ventilates
#    as the boat heels, so its load cycles. We model the EXPECTED knockdown so the
#    predicted windward load is comparable to the duty-cycle statistic the loader
#    computes from the raw signal.
# ─────────────────────────────────────────────────────────────────────────────
@dataclass(frozen=True)
class Ventilation:
    heel_onset_deg: float = 12.0   # below this heel, windward foil stays wetted.
    heel_full_deg: float = 22.0    # at/above this heel, windward foil ~fully ventilated.
    # Duty-cycle load threshold (Newtons): a sample counts as "loaded" above this.
    load_threshold_n: float = 200.0
    duty_window_s: float = 60.0    # window for the duty-cycle statistic.


# ─────────────────────────────────────────────────────────────────────────────
# 5. Operating-envelope bins. Keep these COARSE — 22 days is little data.
# ─────────────────────────────────────────────────────────────────────────────
@dataclass(frozen=True)
class Bins:
    # TWS bins (knots). Edges are inclusive-low, exclusive-high.
    tws_edges_kt: List[float] = field(default_factory=lambda: [6, 10, 14, 18, 24])
    # TWA bins (deg). We collapse port/starboard by using |TWA|.
    # Modes: upwind (≲70), reach (70–130), downwind (≳130). The card is built
    # per mode because the target/feasibility differ.
    twa_edges_deg: List[float] = field(default_factory=lambda: [30, 70, 130, 180])
    # Sea-state is hidden from telemetry — it comes from the debrief tag on each
    # leg. Allowed tags; anything else is bucketed as 'unknown'.
    sea_state_tags: List[str] = field(default_factory=lambda: ["flat", "moderate", "lumpy"])

    def mode_for_twa(self, abs_twa: float) -> str:
        if abs_twa < self.twa_edges_deg[1]:
            return "upwind"
        if abs_twa < self.twa_edges_deg[2]:
            return "reach"
        return "downwind"


# ─────────────────────────────────────────────────────────────────────────────
# 6. Architect's recommended STARTING toe per mode (deg, +ve = toe-in).
#    This is the Bayesian prior mean. Strong prior because we only have 22 days.
# ─────────────────────────────────────────────────────────────────────────────
@dataclass(frozen=True)
class Prior:
    toe_upwind_deg: float = 2.0      # TODO(architect): starting toe upwind.
    toe_reach_deg: float = 1.5       # TODO(architect): starting toe reaching.
    toe_downwind_deg: float = 1.0    # TODO(architect): starting toe downwind.

    # Prior standard deviation on the cell toe (deg). SMALL = trust the architect,
    # let data move it only with strong evidence. 0.3° is deliberately tight.
    prior_sd_deg: float = 0.30       # TODO(tune): how far you'll let data pull it.

    def mean_for_mode(self, mode: str) -> float:
        return {
            "upwind": self.toe_upwind_deg,
            "reach": self.toe_reach_deg,
            "downwind": self.toe_downwind_deg,
        }[mode]


# ─────────────────────────────────────────────────────────────────────────────
# 7. Telemetry channel mapping — names are TBD for the new 7X sensors.
#    The log lands in `sessions.log_data.rows[*]` as JSON. Existing 72/7X channels
#    today are: utc, lat, lon, tws, twa, bsp, sog, heel, vmg, vsTargPct, rudder.
#    Leeway + per-rudder load + the toe-of-record are NEW. When the logger emits
#    them, set the right-hand string to whatever key it writes. Leave as-is and
#    the loader will treat a missing channel as "not present" rather than crash.
# ─────────────────────────────────────────────────────────────────────────────
@dataclass(frozen=True)
class Channels:
    # Existing — confirmed present in the SSA log_data.rows shape.
    utc_ms: str = "utc"
    tws: str = "tws"
    twa: str = "twa"
    bsp: str = "bsp"
    heel: str = "heel"
    helm: str = "rudder"            # the steering/rudder angle channel.
    vmg: str = "vmg"
    vs_targ_pct: str = "vsTargPct"

    # New 7X channels — TODO(logger): set to the actual emitted keys.
    leeway: str = "leeway"                  # measured or inferred leeway angle.
    rudder_load_lee: str = "rudder_load_lee"    # leeward rudder load cell (N).
    rudder_load_wind: str = "rudder_load_wind"  # windward rudder load cell (N).
    toe_of_record: str = "toe_deg"          # the toe actually set for the leg.

    # If leeway is NOT a channel, the loader infers it (see Flow / loader docs).
    leeway_is_measured: bool = False        # TODO(logger): True once a sensor exists.


@dataclass(frozen=True)
class Config:
    target: Target = field(default_factory=Target)
    rudder: Rudder = field(default_factory=Rudder)
    flow: Flow = field(default_factory=Flow)
    vent: Ventilation = field(default_factory=Ventilation)
    bins: Bins = field(default_factory=Bins)
    prior: Prior = field(default_factory=Prior)
    chan: Channels = field(default_factory=Channels)

    # ── data source ──────────────────────────────────────────────────────────
    # The loader reads the daily log + event uploads from the SSA store. Two
    # paths, in priority order:
    #   1. Supabase REST (RLS-scoped to the active membership's boat) when
    #      SSA_SUPABASE_URL + a token are set in the environment.
    #   2. Local JSON exports in `local_data_dir` (offline; nothing leaves the
    #      Mac). One file per session: <date>.json holding {log_data, xml_data}.
    local_data_dir: str = "./data/7x_sessions"
    boat_name_filter: str = "Northstar7X"   # only pull the 7X's sessions.

    def kt_to_ms(self, v: float) -> float:
        return v * 0.514444 if self.flow.bsp_is_knots else v


# A ready-to-use default instance. Import this everywhere:  from config import CFG
CFG = Config()
