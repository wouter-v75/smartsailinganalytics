"""
Toe-setting card export — the coach/helm-facing deliverable.

Turns a Bayesian FitResult into a glanceable card:
  • a self-contained HTML file (good on a tablet on the dock; prints cleanly), and
  • a one-page PDF (matplotlib, no extra system deps) for printing / pinning up.

Both are READ-ONLY artifacts. The engineer runs the notebook; the coach and helm
only ever see the card. Until the architect's numbers are calibrated, every card
carries a prominent PROVISIONAL banner so nobody mistakes a placeholder for a
recommendation.

Card semantics per cell:
  toe value (°)        — posterior mean recommended toe.
  ±half-CI             — half the 95% credible interval; small = confident.
  colour               — green: confident & 2/0 feasible · amber: low confidence
                         (downwind or <3 legs) · red: 2/0 infeasible at this
                         operating point (fix trim/heel, not toe) · grey: no
                         data, prior only.
"""

from __future__ import annotations

import datetime as _dt
import html as _html
from typing import Optional

from config import Config, CFG
from bayes_toe import FitResult, _tws_labels

# Colour palette (cell fill, text).
_GREEN = "#bbf7d0"
_AMBER = "#fde68a"
_RED = "#fecaca"
_GREY = "#e5e7eb"
_INK = "#1f2937"


def _cell_state(row) -> str:
    if row["n_legs"] == 0:
        return "prior"
    if not row["windward_feasible"]:
        return "infeasible"
    if row["low_confidence"]:
        return "low"
    return "ok"


_STATE_COLOUR = {"ok": _GREEN, "low": _AMBER, "infeasible": _RED, "prior": _GREY}
_STATE_WORD = {"ok": "confident", "low": "low confidence",
               "infeasible": "2/0 infeasible — trim/heel", "prior": "prior only"}


def _grid(fit: FitResult, cfg: Config):
    """Return (modes, tws_labels, cells[mode][tws] -> dict)."""
    cols = [c for c in _tws_labels(cfg) if c in set(fit.table["tws_bin"])]
    modes = [m for m in ("upwind", "reach", "downwind")
             if m in set(fit.table["mode"])]
    cells = {m: {} for m in modes}
    for _, r in fit.table.iterrows():
        if r["mode"] in cells and r["tws_bin"] in cols:
            cells[r["mode"]][r["tws_bin"]] = {
                "toe": float(r["toe_deg"]),
                "half_ci": float(r["ci_hi"] - r["toe_deg"]),
                "n": int(r["n_legs"]),
                "state": _cell_state(r),
            }
    return modes, cols, cells


# ─────────────────────────────────────────────────────────────────────────────
# HTML
# ─────────────────────────────────────────────────────────────────────────────
def card_to_html(fit: FitResult, cfg: Config = CFG, date: Optional[str] = None,
                 out_path: str = "toe_card.html", calibrated: bool = False,
                 boat: str = "Northstar 7X") -> str:
    """Write a self-contained HTML toe card. Returns the path written."""
    date = date or _dt.date.today().isoformat()
    modes, cols, cells = _grid(fit, cfg)

    def th(s):
        return f'<th>{_html.escape(s)}</th>'

    head_cells = "".join(th(c.replace("kt", " kt")) for c in cols)
    body_rows = ""
    for m in modes:
        tds = ""
        for c in cols:
            cell = cells[m].get(c)
            if not cell:
                tds += f'<td style="background:{_GREY}">—</td>'
                continue
            colour = _STATE_COLOUR[cell["state"]]
            sub = (f'±{cell["half_ci"]:.2f}°' if cell["state"] != "prior"
                   else "prior")
            ntxt = f'n={cell["n"]}' if cell["n"] else "no data"
            tds += (
                f'<td style="background:{colour}">'
                f'<div class="toe">{cell["toe"]:+.2f}°</div>'
                f'<div class="ci">{sub}</div>'
                f'<div class="n">{ntxt}</div></td>'
            )
        body_rows += f'<tr><th class="mode">{m.title()}</th>{tds}</tr>'

    banner = "" if calibrated else (
        '<div class="banner">PROVISIONAL — architect inputs not yet calibrated. '
        'Do not set the boat from these numbers; structure only.</div>'
    )

    legend = (
        f'<span class="key"><i style="background:{_GREEN}"></i>confident</span>'
        f'<span class="key"><i style="background:{_AMBER}"></i>low confidence</span>'
        f'<span class="key"><i style="background:{_RED}"></i>2/0 infeasible — fix trim/heel</span>'
        f'<span class="key"><i style="background:{_GREY}"></i>prior only</span>'
    )

    css = """
    :root{color-scheme:light}
    *{box-sizing:border-box}
    body{font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;
         color:%(ink)s;margin:0;padding:24px;background:#fff}
    .wrap{max-width:820px;margin:0 auto}
    h1{font-size:20px;margin:0 0 2px}
    .meta{color:#6b7280;font-size:13px;margin-bottom:14px}
    .banner{background:#fef2f2;border:1px solid #fca5a5;color:#991b1b;
            padding:8px 12px;border-radius:8px;font-size:13px;font-weight:600;
            margin-bottom:14px}
    table{border-collapse:separate;border-spacing:6px;width:100%%}
    th{font-size:12px;color:#374151;text-align:center;font-weight:600;
       text-transform:uppercase;letter-spacing:.03em}
    th.mode{text-align:left;width:96px;font-size:14px;text-transform:none}
    td{border-radius:10px;text-align:center;padding:10px 6px;min-width:78px;
       vertical-align:middle}
    .toe{font-size:20px;font-weight:700;line-height:1.1}
    .ci{font-size:12px;color:#374151}
    .n{font-size:10px;color:#6b7280;margin-top:2px}
    .legend{margin-top:16px;display:flex;gap:16px;flex-wrap:wrap;font-size:12px;
            color:#374151}
    .key{display:inline-flex;align-items:center;gap:6px}
    .key i{width:13px;height:13px;border-radius:3px;display:inline-block}
    .foot{margin-top:14px;font-size:11px;color:#9ca3af;line-height:1.5}
    @media print{body{padding:0}.wrap{max-width:none}}
    """ % {"ink": _INK}

    doc = f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Toe card — {_html.escape(boat)} — {date}</title><style>{css}</style></head>
<body><div class="wrap">
<h1>Toe-setting card · {_html.escape(boat)}</h1>
<div class="meta">{date} · toe in degrees (+ = toe-in) · target AoA
{cfg.target.aoa_lee_deg:g}° leeward / {cfg.target.aoa_wind_deg:g}° windward</div>
{banner}
<table><thead><tr><th class="mode">Mode \\ TWS</th>{head_cells}</tr></thead>
<tbody>{body_rows}</tbody></table>
<div class="legend">{legend}</div>
<div class="foot">Toe controls only the split between rudders; the leeward target
is reachable only when the common-mode (leeway + helm) is right — red cells are a
trim/heel issue, not a toe one. Downwind cells are low-confidence until the
architect confirms the downwind target. Generated {_dt.datetime.now():%Y-%m-%d %H:%M}.
</div>
</div></body></html>"""

    with open(out_path, "w") as f:
        f.write(doc)
    return out_path


# ─────────────────────────────────────────────────────────────────────────────
# PDF (matplotlib — no system deps beyond what's already installed)
# ─────────────────────────────────────────────────────────────────────────────
def card_to_pdf(fit: FitResult, cfg: Config = CFG, date: Optional[str] = None,
                out_path: str = "toe_card.pdf", calibrated: bool = False,
                boat: str = "Northstar 7X", legs=None) -> str:
    """Write a one-page PDF toe card (table + optional toe-vs-TWS plot)."""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.backends.backend_pdf import PdfPages

    date = date or _dt.date.today().isoformat()
    modes, cols, cells = _grid(fit, cfg)

    with PdfPages(out_path) as pdf:
        fig = plt.figure(figsize=(8.27, 5.4))  # A5-landscape-ish
        fig.suptitle(f"Toe-setting card · {boat} · {date}",
                     fontsize=14, fontweight="bold", x=0.06, ha="left", y=0.97)
        fig.text(0.06, 0.91,
                 f"toe in degrees (+ = toe-in) · target AoA "
                 f"{cfg.target.aoa_lee_deg:g}° lee / {cfg.target.aoa_wind_deg:g}° wind",
                 fontsize=9, color="#6b7280")
        if not calibrated:
            fig.text(0.5, 0.855,
                     "PROVISIONAL — architect inputs not yet calibrated",
                     ha="center", fontsize=10, color="#991b1b", fontweight="bold",
                     bbox=dict(boxstyle="round,pad=0.3", fc="#fef2f2", ec="#fca5a5"))

        ax = fig.add_axes([0.16, 0.30, 0.80, 0.50]); ax.axis("off")
        n_r, n_c = len(modes), len(cols)
        cell_text, cell_colour = [], []
        for m in modes:
            row_txt, row_col = [], []
            for c in cols:
                cell = cells[m].get(c)
                if not cell:
                    row_txt.append("—"); row_col.append(_GREY); continue
                sub = (f"\n±{cell['half_ci']:.2f}  n={cell['n']}"
                       if cell["state"] != "prior" else "\nprior")
                row_txt.append(f"{cell['toe']:+.2f}°{sub}")
                row_col.append(_STATE_COLOUR[cell["state"]])
            cell_text.append(row_txt); cell_colour.append(row_col)

        tbl = ax.table(
            cellText=cell_text, cellColours=cell_colour,
            rowLabels=[m.title() for m in modes],
            colLabels=[c.replace("kt", " kt") for c in cols],
            cellLoc="center", loc="center")
        tbl.auto_set_font_size(False); tbl.set_fontsize(10); tbl.scale(1, 2.4)

        # legend
        from matplotlib.patches import Patch
        handles = [Patch(fc=_GREEN, label="confident"),
                   Patch(fc=_AMBER, label="low confidence"),
                   Patch(fc=_RED, label="2/0 infeasible — fix trim/heel"),
                   Patch(fc=_GREY, label="prior only")]
        fig.legend(handles=handles, loc="lower center", ncol=4, frameon=False,
                   fontsize=8, bbox_to_anchor=(0.5, 0.16))
        fig.text(0.06, 0.06,
                 "Toe sets only the split between rudders; red = a trim/heel "
                 "(common-mode) issue, not a toe one. Downwind low-confidence "
                 "until the architect confirms the downwind target.",
                 fontsize=7.5, color="#9ca3af", wrap=True)
        pdf.savefig(fig); plt.close(fig)

    return out_path


def write_cards(fit: FitResult, cfg: Config = CFG, date: Optional[str] = None,
                out_dir: str = ".", calibrated: bool = False,
                boat: str = "Northstar 7X"):
    """Convenience: write both HTML and PDF for a date. Returns (html, pdf)."""
    import os
    date = date or _dt.date.today().isoformat()
    os.makedirs(out_dir, exist_ok=True)
    h = card_to_html(fit, cfg, date, os.path.join(out_dir, f"toe_card_{date}.html"),
                     calibrated, boat)
    p = card_to_pdf(fit, cfg, date, os.path.join(out_dir, f"toe_card_{date}.pdf"),
                    calibrated, boat)
    return h, p
