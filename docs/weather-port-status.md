# SSA Weather Tab — Port Status

**Checkpoint tag:** `weather-phase3` (this commit)  ·  **Code tip:** `3a6aba4`  ·  **Branch:** `main`
**Date:** 2026-06-09  ·  **Repo:** github.com/wouter-v75/smartsailinganalytics

Native React/Next port of the standalone v1.3 weather tool
(`Smart Sailing Analytics/index.html`). No new npm deps — Leaflet, Plotly and
D3 are lazy-loaded from CDN via `useScriptsOnce`.

## Get back to this point
```bash
cd ~/Code/ssa
git fetch --tags
git checkout weather-phase3      # detached snapshot of this checkpoint
# or stay on main and just: git pull --rebase
```

## What's shipped

### Forecast sub-tab
- Leaflet 3-point picker. Map starts empty, so clicks number **1 → 2 → 3** in
  order; drag to fine-tune; Clear per card. Fetch disabled until a point exists.
- Surface model toggle (AROME / ECMWF / ICON), per-location hourly wind tables.
- **Mast-height (m) input** left of the Fetch button (default 20 m), shared
  app-wide so tables and Model Comparison both use it.
- Wind tables read **Time · 10m TWD · TWS columns sorted by increasing height**,
  with the **mast column inserted in its correct slot** and highlighted. Columns
  adapt per model (its display heights ∪ {mast}, deduped; merge if equal).
  Mast speed = Lagrange fit through the 3 nearest model levels in log-height.
- **Fetch progress bar + per-model messages** ("Loading AROME — Location 1…")
  under the button, driven by `onProgress(phase, modelKey)`.
- Multi-location summary strip, wind-speed comparison chart, vertical wind
  profile (log axis + time scrubber), GFS boundary-layer-height chart.

### Model Comparison sub-tab
- One location across all 6 models. Panels: 10 m speed, **mast-height speed**,
  100 m speed (ICON interpolated 80↔120 m), 10 m direction.

### Sounding sub-tab (Phase 3 headline)
- Hand-rolled **D3 v7 Skew-T Log-P**: isobars, skewed isotherms, dry adiabats,
  T/Td profiles, wind barbs, Windy-style hover crosshair with a dynamically
  lifted parcel, and **true semantic zoom** (wheel/drag rescales the temperature
  and pressure axes and redraws — axes re-tick, strokes stay crisp; double-click
  resets).
- Surface-parcel **convective indices** (LCL / CCL / convective temperature).
- **Leaflet picker** to drop a one-off "Selected sounding position" (fetched on
  demand: ICON + ECMWF + GFS). Diagram on a white meteo panel, dark chrome.

## File map
| File | Role |
|---|---|
| `src/components/WeatherTab.jsx` | sub-tab shell + shared state (`windData`, `activeModel`, `resolvedTz`, `mastHeight`) |
| `src/components/weather/openMeteo.js` | model configs, fetch helpers, `fetchSoundingPoint`, `interpolateSpeedAtHeight`, `SOUNDING_SOURCES` |
| `src/components/weather/ForecastView.jsx` | map picker, controls, tables, charts, fetch progress |
| `src/components/weather/CompareView.jsx` | 6-model comparison panels |
| `src/components/weather/SoundingView.jsx` | D3 Skew-T + picker + indices |
| `src/components/weather/PlotlyChart.jsx`, `useScriptOnce.js` | CDN chart + script-loader helpers |

## This session's commits
- `d640a83` Phase 3: native D3 Skew-T sounding sub-tab
- `59f2afa` Skew-T: true semantic zoom (rescale axes, not picture zoom)
- `b0eae39` Masthead wind (interpolated) + fetch progress
- `895fb3d` Forecast tables: order columns by height, mast inserted in place
- `3a6aba4` Forecast map: start empty so clicks number 1 → 2 → 3

`weather-phase3` tags the doc commit on top of `3a6aba4` (identical code).

## Caveats / next
- Verified via `esbuild` bundle (JSX + all import/export bindings) — the sandbox
  disk can't run a full `next build`. **Browser smoke-test still recommended.**
- Defaults chosen: mast height 20 m; interpolation in log-height space.
- **Phase 4 (pending):** Skill Score / model verification (admin-only) — see
  `MODEL_VERIFICATION_PROPOSAL.md`.
