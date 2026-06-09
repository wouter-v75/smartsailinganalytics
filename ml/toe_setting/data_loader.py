"""
Data loader: SSA store → per-leg → per-cell tables for the toe-setting fit.

Source of truth is the daily log + event upload that lands in the SSA store as
`sessions.log_data` (the logfile, parsed to `{rows: [...]}`) and
`sessions.xml_data` (the event/marker file, with `tackJibes`, `meta`, ...).

Read path, in priority order (both honour the v3 tenant isolation):
  1. Supabase REST — set in the environment:
        SSA_SUPABASE_URL   = https://<project>.supabase.co
        SSA_SUPABASE_TOKEN = a logged-in user's access token (JWT)  [RLS-scoped]
        SSA_BOAT_ID        = the Northstar 7X boat uuid
        SSA_TEAM_ID        = the team uuid
     This hits PostgREST with the user's JWT, so Row-Level Security returns only
     the sessions that membership is allowed to see — same scoping as the app.
  2. Local JSON export — `Config.local_data_dir/<date>.json`, each holding
        {"date": "...", "log_data": {...}, "xml_data": {...},
         "sea_state": {"<leg_id>": "flat"|"moderate"|"lumpy", ...}}
     Nothing leaves the Mac. Use the companion `export_sessions.py` to populate
     it from the scoped API once, then iterate offline.

Nothing here uploads anything. The model and its inputs stay local.
"""

from __future__ import annotations

import glob
import json
import os
from typing import Dict, List, Optional

import numpy as np
import pandas as pd

from config import Config, CFG
from physics import per_leg_optimal_toe_deg


# ─────────────────────────────────────────────────────────────────────────────
# 1. Acquire raw sessions
# ─────────────────────────────────────────────────────────────────────────────
def _load_sessions_supabase(cfg: Config) -> List[dict]:
    """Pull the 7X's sessions via PostgREST under the user's JWT (RLS-scoped)."""
    import urllib.parse
    import urllib.request

    base = os.environ["SSA_SUPABASE_URL"].rstrip("/")
    token = os.environ["SSA_SUPABASE_TOKEN"]
    boat_id = os.environ["SSA_BOAT_ID"]
    team_id = os.environ.get("SSA_TEAM_ID")

    q = {
        "select": "date,title,log_data,xml_data,tz_offset_minutes",
        "boat_id": f"eq.{boat_id}",
        "order": "date.asc",
    }
    if team_id:
        q["team_id"] = f"eq.{team_id}"
    url = f"{base}/rest/v1/sessions?{urllib.parse.urlencode(q)}"
    req = urllib.request.Request(
        url,
        headers={
            "apikey": os.environ.get("SSA_SUPABASE_ANON_KEY", token),
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=30) as r:  # noqa: S310 (trusted host)
        rows = json.loads(r.read().decode())
    return rows


def _load_sessions_local(cfg: Config) -> List[dict]:
    out = []
    for path in sorted(glob.glob(os.path.join(cfg.local_data_dir, "*.json"))):
        with open(path) as f:
            out.append(json.load(f))
    return out


def load_sessions(cfg: Config = CFG) -> List[dict]:
    """Return a list of session dicts with at least `log_data` (+ `xml_data`)."""
    if os.environ.get("SSA_SUPABASE_URL") and os.environ.get("SSA_SUPABASE_TOKEN"):
        return _load_sessions_supabase(cfg)
    return _load_sessions_local(cfg)


# ─────────────────────────────────────────────────────────────────────────────
# 2. log_data.rows → canonical DataFrame
# ─────────────────────────────────────────────────────────────────────────────
def _extract_rows(log_data) -> List[dict]:
    """Tolerate the few shapes log_data has worn: {rows:[...]} | [...] | {data:[...]}."""
    if log_data is None:
        return []
    if isinstance(log_data, list):
        return log_data
    for key in ("rows", "data", "log"):
        v = log_data.get(key) if isinstance(log_data, dict) else None
        if isinstance(v, list):
            return v
    return []


def session_to_frame(session: dict, cfg: Config = CFG) -> pd.DataFrame:
    """One session → tidy DataFrame with canonical column names.

    Missing channels become NaN columns rather than raising, so a session logged
    before the 7X load cells were fitted still loads (its load columns are just
    empty).
    """
    rows = _extract_rows(session.get("log_data"))
    df = pd.DataFrame(rows)
    c = cfg.chan

    def col(name: str):
        return df[name] if name in df.columns else pd.Series(np.nan, index=df.index)

    out = pd.DataFrame({
        "utc_ms": col(c.utc_ms),
        "tws": col(c.tws),
        "twa": col(c.twa),
        "bsp": col(c.bsp),
        "heel": col(c.heel),
        "helm": col(c.helm),
        "vmg": col(c.vmg),
        "vs_targ_pct": col(c.vs_targ_pct),
        "load_lee": col(c.rudder_load_lee),
        "load_wind": col(c.rudder_load_wind),
        "toe_set": col(c.toe_of_record),
    })
    out["date"] = session.get("date")

    # Leeway: measured channel or inferred proxy.
    if cfg.chan.leeway_is_measured and c.leeway in df.columns:
        out["leeway"] = df[c.leeway]
    else:
        out["leeway"] = _infer_leeway(out, cfg)

    out["abs_twa"] = out["twa"].abs()
    return out


def _infer_leeway(df: pd.DataFrame, cfg: Config) -> pd.Series:
    """Crude leeway proxy when no sensor exists. See Flow.leeway_infer_k docstring."""
    bsp = df["bsp"].clip(lower=cfg.flow.leeway_min_bsp_kt)
    return cfg.flow.leeway_infer_k * df["heel"].abs() / (bsp ** 2)


# ─────────────────────────────────────────────────────────────────────────────
# 3. Leg segmentation + steady-state filtering
# ─────────────────────────────────────────────────────────────────────────────
def segment_legs(df: pd.DataFrame, session: dict, cfg: Config = CFG,
                 settle_s: float = 30.0) -> pd.DataFrame:
    """Add a `leg_id` column by splitting at tack/gybe markers, then drop the
    `settle_s` seconds after each manoeuvre so only steady-state samples remain.

    Falls back to a single leg per session when no markers are present.
    """
    df = df.sort_values("utc_ms").reset_index(drop=True)
    xml = session.get("xml_data") or {}
    marks = sorted(int(m["utc"]) for m in xml.get("tackJibes", []) if "utc" in m)

    if not marks or df["utc_ms"].isna().all():
        df["leg_id"] = f"{session.get('date','?')}::leg0"
        df["_settling"] = False
        return df

    # leg index = number of markers strictly before each sample's time.
    t = df["utc_ms"].to_numpy()
    leg_idx = np.searchsorted(marks, t, side="right")
    df["leg_id"] = [f"{session.get('date','?')}::leg{int(i)}" for i in leg_idx]

    # mark samples within settle_s after the most recent marker as settling.
    settling = np.zeros(len(df), dtype=bool)
    for m in marks:
        settling |= (t >= m) & (t < m + settle_s * 1000.0)
    df["_settling"] = settling
    return df


# ─────────────────────────────────────────────────────────────────────────────
# 4. Binning
# ─────────────────────────────────────────────────────────────────────────────
def _tws_bin_label(tws: float, cfg: Config) -> Optional[str]:
    e = cfg.bins.tws_edges_kt
    for i in range(len(e) - 1):
        if e[i] <= tws < e[i + 1]:
            return f"{e[i]:g}-{e[i+1]:g}kt"
    if tws >= e[-1]:
        return f"{e[-1]:g}+kt"
    return None  # below the lowest edge → drop (too light to be meaningful).


def _sea_state_for_leg(session: dict, leg_id: str, cfg: Config) -> str:
    tags = (session.get("sea_state") or {})
    tag = tags.get(leg_id) or tags.get(leg_id.split("::")[-1])
    return tag if tag in cfg.bins.sea_state_tags else "unknown"


# ─────────────────────────────────────────────────────────────────────────────
# 5. Robust windward-load duty-cycle statistic
# ─────────────────────────────────────────────────────────────────────────────
def windward_duty_cycle(load_wind: pd.Series, cfg: Config = CFG) -> float:
    """Fraction of samples where the windward load exceeds the threshold.

    This is the robust replacement for a raw mean: the windward foil ventilates
    on and off as the boat heels, so the mean is meaningless but the duty cycle
    (how often it's actually loaded) is monotonic in real loading and smooth.
    """
    s = load_wind.dropna()
    if len(s) == 0:
        return np.nan
    return float((s.abs() > cfg.vent.load_threshold_n).mean())


# ─────────────────────────────────────────────────────────────────────────────
# 6. Per-leg table — the Bayesian observations
# ─────────────────────────────────────────────────────────────────────────────
def per_leg_table(sessions: List[dict], cfg: Config = CFG,
                  min_samples: int = 60) -> pd.DataFrame:
    """One row per steady-state leg: cell coordinates + median conditions +
    the physics-implied optimal toe (the observation the fit consumes).
    """
    records = []
    for s in sessions:
        df = session_to_frame(s, cfg)
        if df.empty:
            continue
        df = segment_legs(df, s, cfg)
        steady = df[~df["_settling"]]
        for leg_id, g in steady.groupby("leg_id"):
            g = g.dropna(subset=["tws", "abs_twa", "heel", "helm"])
            if len(g) < min_samples:
                continue
            tws_med = float(g["tws"].median())
            twa_med = float(g["abs_twa"].median())
            tws_bin = _tws_bin_label(tws_med, cfg)
            if tws_bin is None:
                continue
            mode = cfg.bins.mode_for_twa(twa_med)
            heel_med = float(g["heel"].abs().median())
            helm_med = float(g["helm"].median())
            leeway_med = float(g["leeway"].median())

            opt_toe = float(per_leg_optimal_toe_deg(
                leeway_med, helm_med, cfg, mode=mode, objective="lee"))

            records.append({
                "leg_id": leg_id,
                "date": g["date"].iloc[0],
                "mode": mode,
                "tws_bin": tws_bin,
                "tws_med": tws_med,
                "twa_med": twa_med,
                "sea_state": _sea_state_for_leg(s, leg_id, cfg),
                "n": int(len(g)),
                "heel_med": heel_med,
                "helm_med": helm_med,
                "leeway_med": leeway_med,
                "bsp_med": float(g["bsp"].median()),
                "load_lee_med": float(g["load_lee"].median()) if g["load_lee"].notna().any() else np.nan,
                "wind_duty": windward_duty_cycle(g["load_wind"], cfg),
                "toe_set_med": float(g["toe_set"].median()) if g["toe_set"].notna().any() else np.nan,
                "optimal_toe_obs": opt_toe,
                "cell": f"{mode}|{tws_bin}",
            })
    return pd.DataFrame.from_records(records)


# ─────────────────────────────────────────────────────────────────────────────
# 7. Per-cell medians — the operating-envelope summary for Block A checks
# ─────────────────────────────────────────────────────────────────────────────
def per_cell_medians(legs: pd.DataFrame) -> pd.DataFrame:
    if legs.empty:
        return legs
    agg = legs.groupby(["mode", "tws_bin"]).agg(
        n_legs=("leg_id", "count"),
        heel_med=("heel_med", "median"),
        helm_med=("helm_med", "median"),
        leeway_med=("leeway_med", "median"),
        bsp_med=("bsp_med", "median"),
        load_lee_med=("load_lee_med", "median"),
        wind_duty=("wind_duty", "median"),
        optimal_toe_obs=("optimal_toe_obs", "median"),
        toe_obs_sd=("optimal_toe_obs", "std"),
    ).reset_index()
    return agg
