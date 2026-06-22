# SSA — `forecast-deck-v1` — Version Snapshot

**Marks:** HEAD `bfa4d22` on `main` (2026-06-22) · **Tag:** `weather-forecast-deck-v1`
**Why:** known-good fallback **immediately before** the Racing-Yacht Forecast Diagnostics
build begins. The complete weather/forecast suite — model comparison, MOS, HPBL, soundings,
and the editable **forecast deck with the AI exec-summary** — is in place and working.

> How to return to this exact version is at the bottom.

---

## 1. What this version adds (since `v2.0-stable` / on top of v3 Campaign OS)

This snapshot captures the **Weather tab + forecast-generation** workstream. It sits on the
v3 multi-team Campaign-OS base; nothing in the campaign/video/SailScan stack changed here.

**Weather tab & multi-model forecasting.** Pick up to 3 points on a Leaflet map; models load
automatically for the area. Sources include SSA-Race (ICON nest, UTC) and Open-Meteo models
(AROME, ECMWF, ICON, ARPEGE, ITALIA, DMI, GFS), all aligned on a common **local-time grid**
(SSA-Race `…Z` UTC vs Open-Meteo venue-local — the alignment fix that made the multi-model
comparison correct).

**Mast-height winds + MOS.** All winds interpolated to mast height; venue/model MOS applied
where available.

**Wind field, HPBL & soundings.**
- 2-D wind field over a detailed CARTO coastline, Beaufort colour scale, cropped to the
  domain with a 5 nm racing-area circle on point 1; view expanded to ~30 nm.
- **HPBL** (bulk-Richardson boundary-layer height) as a shaded + contoured map layer and a
  time-series in the forecast/comparison views (1500 m cap, dynamic intervals).
- **SSA-Race low-level Skew-T sounding** source (published from the `_pbl` profile); sounding
  point shared into the deck via the weather session store.

**Forecast deck (admin-gated, editable .pptx via pptxgenjs).** "Generate forecast" panel at
the top of the Forecast tab. Slides:
1. **Weather and strategy brief** — title, venue, type-of-day, race-day + **AI-generated
   executive summary** (Situation / Today's wind / Stability / Outlook) via the server-side
   Claude route `/api/ai/forecast-summary` (key stays server-side; heuristic fallback).
2. **General weather** — wind field @ 12:00 local.
3. **Outlook** — Morning/Midday/Afternoon (10/12/15 local), weighted multi-model TWD + TWS
   ranges, 4-day TWS/TWD plots with ±2σ shading and racing-window (10–17) shading.
4. **Details for today** — Time · TWD (fixed-size arrow + numeric, rounded 5°) · TWS · TWD
   range · TWS min&max · Trend · Notes; editable colour-coded tables (Beaufort scale).
5. **Stability** — HPBL development (08–20, racing window shaded) + 13:00 low-level sounding.
6. **Model comparison** — day-mode Plotly, grey ±2σ band, clipped to today 08:00–20:00.

**AI exec-summary link.** `/api/ai/forecast-summary` reads `ANTHROPIC_API_KEY` (server-side
only), calls Claude, returns structured `{typeOfDay, situation, todaysWind, stability,
outlook}`. Key is set in Vercel.

## 2. Key files

- `src/components/weather/ForecastDeck.jsx` — deck generator (tables, plots, wind field,
  HPBL, sounding, AI wiring).
- `src/app/api/ai/forecast-summary/route.ts` — server-side Claude proxy.
- `src/components/weather/{ForecastView,WeatherTab,SoundingView,weatherSession}.jsx/js` —
  weather tab, admin gating, sounding-point sharing.
- `docs/racing-forecast-diagnostics-spec.md` — the spec for the **next** build (not yet implemented).

## 3. Stack (unchanged)

Next.js 14 (App Router) + TypeScript + Tailwind on Vercel; Supabase (auth + Postgres + RLS);
Bunny.net (video). Weather data from the Icon-Race box pipeline + Open-Meteo.

---

## 4. How to return to this exact version

```
git checkout weather-forecast-deck-v1
```

or by commit:

```
git checkout bfa4d22
```

This is the known-good baseline to fall back to if the forecast-diagnostics work needs reverting.
