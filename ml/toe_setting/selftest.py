"""Self-tests. Run: python selftest.py  (exit 0 = all pass)."""

from __future__ import annotations

import sys
import tempfile

import numpy as np

from config import CFG
import physics as phys
import data_loader as dl
import bayes_toe as bt
import make_synthetic as syn


def approx(a, b, tol=1e-6):
    return abs(float(a) - float(b)) <= tol


def test_physics_identities():
    # balanced toe == target spread, independent of operating point.
    for leeway, helm in [(4.0, 1.5), (0.5, 3.0), (8.0, -1.0)]:
        sol = phys.solve_toe(leeway, helm, CFG, mode="upwind")
        assert approx(sol.toe_balanced_deg,
                      CFG.target.aoa_lee_deg - CFG.target.aoa_wind_deg, 1e-9), \
            "balanced toe should equal the AoA target spread"
    # lee-priority solve round-trips: applying that toe yields AoA_lee == target.
    leeway, helm = 4.0, 1.5
    sol = phys.solve_toe(leeway, helm, CFG, mode="upwind")
    aoa_lee = phys.rudder_aoa_deg(leeway, helm, sol.toe_lee_priority_deg, "lee", CFG)
    assert approx(aoa_lee, CFG.target.aoa_lee_deg, 1e-6), "lee-priority must hit lee target"
    # wind-zero solve round-trips.
    aoa_wind = phys.rudder_aoa_deg(leeway, helm, sol.toe_wind_zero_deg, "wind", CFG)
    assert approx(aoa_wind, CFG.target.aoa_wind_deg, 1e-6), "wind-zero must hit wind target"
    # AoA split equals toe.
    aoa_l = phys.rudder_aoa_deg(leeway, helm, 2.0, "lee", CFG)
    aoa_w = phys.rudder_aoa_deg(leeway, helm, 2.0, "wind", CFG)
    assert approx(aoa_l - aoa_w, 2.0), "AoA_lee - AoA_wind must equal toe"
    # feasibility flag fires when common-mode is wrong.
    bad = phys.solve_toe(20.0, 10.0, CFG, mode="upwind")  # huge common-mode
    assert not bad.windward_feasible, "should flag infeasible 2/0 at large common-mode"
    print("  ✓ physics identities")


def test_lift_slope_positive():
    a = phys.lift_slope_per_rad(CFG)
    assert 1.0 < a < 7.0, f"lift slope out of physical range: {a}"
    # load is positive for positive AoA and grows with speed².
    l1 = phys.rudder_load_n(4, 1.5, 2.0, 8, 10, "lee", CFG)
    l2 = phys.rudder_load_n(4, 1.5, 2.0, 16, 10, "lee", CFG)
    assert l2 > l1 > 0, "leeward load should rise with boat speed"
    print("  ✓ lift slope + load monotonicity")


def test_loader_and_binning():
    with tempfile.TemporaryDirectory() as d:
        cfg = CFG.__class__(local_data_dir=d)
        syn.write_synthetic(d, n_days=4, cfg=cfg)
        sessions = dl.load_sessions(cfg)
        assert len(sessions) == 4, "should load 4 synthetic sessions"
        legs = dl.per_leg_table(sessions, cfg)
        assert not legs.empty, "should produce legs"
        assert legs["mode"].isin(["upwind", "reach", "downwind"]).all()
        assert legs["sea_state"].isin(cfg.bins.sea_state_tags + ["unknown"]).all()
        # duty cycle is a fraction.
        dvals = legs["wind_duty"].dropna()
        assert ((dvals >= 0) & (dvals <= 1)).all(), "duty cycle must be in [0,1]"
        # windward duty should be lower in high-heel (upwind) than low-heel legs.
        print(f"  ✓ loader: {len(sessions)} sessions → {len(legs)} legs, "
              f"modes={sorted(legs['mode'].unique())}")
        return cfg, legs


def test_bayes_prior_and_data(cfg, legs):
    # 1) With NO data, posterior == prior exactly, per mode.
    empty = legs.iloc[0:0]
    fit0 = bt.fit_conjugate(empty, cfg)
    for _, r in fit0.table.iterrows():
        assert r["shrunk_to_prior"], "empty cell must be prior-only"
        assert approx(r["toe_deg"], cfg.prior.mean_for_mode(r["mode"]), 1e-6), \
            "no data → posterior mean == prior mean"
    # 2) With strong, consistent fake evidence the posterior moves toward data.
    import pandas as pd
    fake = pd.DataFrame([{
        "leg_id": f"L{i}", "date": "x", "mode": "upwind", "tws_bin": "10-14kt",
        "tws_med": 12, "twa_med": 45, "sea_state": "flat", "n": 300,
        "heel_med": 12, "helm_med": 1.5, "leeway_med": 4.0, "bsp_med": 8,
        "load_lee_med": 800, "wind_duty": 0.2, "toe_set_med": 2.0,
        "optimal_toe_obs": 3.5, "cell": "upwind|10-14kt",
    } for i in range(40)])
    fit1 = bt.fit_conjugate(fake, cfg)
    cell = fit1.table[(fit1.table["mode"] == "upwind") &
                      (fit1.table["tws_bin"] == "10-14kt")].iloc[0]
    prior = cfg.prior.toe_upwind_deg
    assert prior < cell["toe_deg"] < 3.5, \
        f"posterior {cell['toe_deg']} should sit between prior {prior} and data 3.5"
    assert cell["ci_hi"] > cell["toe_deg"] > cell["ci_lo"], "CI must bracket mean"
    assert cell["toe_sd"] < cfg.prior.prior_sd_deg, "data should shrink uncertainty"
    # 3) card + partial dependence shapes.
    fitR = bt.fit_conjugate(legs, cfg)
    card = bt.toe_card(fitR, cfg)
    assert card.shape[0] >= 1 and card.shape[1] >= 1, "card should be non-empty"
    pd_ = bt.partial_dependence(legs, fitR, cfg)
    assert {"mode", "tws_mid", "toe_deg"}.issubset(pd_.columns)
    print("  ✓ bayes: prior-only collapse, data shrinkage, card + partial-dependence")


if __name__ == "__main__":
    print("Running self-tests…")
    test_physics_identities()
    test_lift_slope_positive()
    cfg, legs = test_loader_and_binning()
    test_bayes_prior_and_data(cfg, legs)
    print("ALL TESTS PASSED ✅")
    sys.exit(0)
