"""
Synthetic session generator — for self-tests and for trying the pipeline before
real 7X sweep data exists. Produces JSON files in the same shape the SSA store
holds (`{log_data: {rows:[...]}, xml_data: {tackJibes:[...]}}`), with the new
7X channels included, plus a known ground-truth so tests can check recovery.

NOT for production. Real data comes from the daily SSA uploads.
"""

from __future__ import annotations

import json
import os
from typing import List

import numpy as np

from config import CFG, Config


def make_session(date: str, cfg: Config = CFG, seed: int = 0,
                 n_legs: int = 8, samples_per_leg: int = 400,
                 hz: float = 1.0) -> dict:
    """Build one session with several legs across conditions.

    Ground truth: each leg has a true common-mode; leeway/helm are generated to
    match it (via the same physics the loader inverts), so per_leg_optimal_toe
    should recover a sensible toe. Channels: tws, twa, bsp, heel, rudder(helm),
    vmg, vsTargPct, leeway, rudder_load_lee, rudder_load_wind, toe_deg.
    """
    rng = np.random.default_rng(seed)
    rows: List[dict] = []
    marks: List[dict] = []
    t = 1_700_000_000_000  # arbitrary epoch ms
    dt = int(1000 / hz)

    twa_choices = [40, 50, 90, 110, 150, 165]
    tws_choices = [8, 12, 16, 20]

    for leg in range(n_legs):
        twa = rng.choice(twa_choices) * rng.choice([1, -1])
        tws = float(rng.choice(tws_choices)) + rng.normal(0, 0.5)
        bsp = 6 + 0.4 * abs(tws) + rng.normal(0, 0.3)
        heel = np.clip(abs(twa) < 70 and (2 + 0.8 * tws) or (5 + 0.3 * tws), 0, 30)
        # true leeway/helm for this leg
        true_leeway = (4.0 if abs(twa) < 70 else 1.5) + rng.normal(0, 0.3)
        true_helm = rng.normal(1.5 if abs(twa) < 70 else 2.5, 0.3)
        toe_set = 2.0 + rng.normal(0, 0.1)

        for _ in range(samples_per_leg):
            heel_i = heel + rng.normal(0, 1.0)
            leeway_i = true_leeway + rng.normal(0, 0.4)
            helm_i = true_helm + rng.normal(0, 0.8)
            bsp_i = bsp + rng.normal(0, 0.2)
            # synthetic load cells (leeward smooth; windward ventilates w/ heel)
            load_lee = max(0.0, 800 + 60 * leeway_i + rng.normal(0, 50))
            vent_on = heel_i < cfg.vent.heel_full_deg and rng.random() < max(
                0.0, (cfg.vent.heel_full_deg - heel_i) / cfg.vent.heel_full_deg)
            load_wind = (300 + rng.normal(0, 80)) if vent_on else rng.normal(0, 40)

            rows.append({
                "utc": t,
                "tws": round(float(tws + rng.normal(0, 0.3)), 2),
                "twa": round(float(twa + rng.normal(0, 1.5)), 2),
                "bsp": round(float(bsp_i), 2),
                "heel": round(float(heel_i), 2),
                "rudder": round(float(helm_i), 2),
                "vmg": round(float(bsp_i * np.cos(np.radians(twa))), 2),
                "vsTargPct": round(float(98 + rng.normal(0, 2)), 1),
                "leeway": round(float(leeway_i), 2),
                "rudder_load_lee": round(float(load_lee), 1),
                "rudder_load_wind": round(float(load_wind), 1),
                "toe_deg": round(float(toe_set), 2),
            })
            t += dt
        # tack/gybe marker between legs
        marks.append({"utc": t, "isTack": bool(abs(twa) < 90), "isValid": True,
                      "label": f"leg{leg}"})
        t += 60_000  # 60s gap

    return {
        "date": date,
        "log_data": {"rows": rows},
        "xml_data": {"meta": {"boat": "Northstar7X"}, "tackJibes": marks},
        # sea-state tags would come from debrief; assign round-robin for realism.
        "sea_state": {f"{date}::leg{i}": ["flat", "moderate", "lumpy"][i % 3]
                      for i in range(n_legs + 1)},
    }


def write_synthetic(out_dir: str, n_days: int = 6, cfg: Config = CFG) -> int:
    os.makedirs(out_dir, exist_ok=True)
    for d in range(n_days):
        date = f"2026-06-{10 + d:02d}"
        s = make_session(date, cfg, seed=100 + d)
        with open(os.path.join(out_dir, f"{date}.json"), "w") as f:
            json.dump(s, f)
    return n_days


if __name__ == "__main__":
    n = write_synthetic(CFG.local_data_dir)
    print(f"Wrote {n} synthetic session(s) → {CFG.local_data_dir}")
