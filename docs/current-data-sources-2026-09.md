# Current data — what is available, and whether it is good enough

Goal: a current source that plays the role Open-Meteo plays for wind — a cheap,
always-available baseline that **validates** the track-derived TWD/TWS and seeds
the current solve in §6-L4 of
[dinghy-gps-prior-art-and-twd-2026-09.md](dinghy-gps-prior-art-and-twd-2026-09.md).

Covering the Mediterranean, NW Europe, the Baltic, US East and US West.

**The short answer:** Open-Meteo already serves currents, *including tides*, from
the same API SSA uses for wind — but at 8 km, which is too coarse for a
racecourse. Use it as the free global baseline and the "does current matter
here?" flag. For venues where current actually decides races, use the regional
model (1.5 km in NW Europe, 1 nm in the Baltic, metre-scale in US bays) and
accept that it is a per-venue setup, not a global API call.

---

## 1. First: how accurate does it have to be?

From §7 of the TWD doc, a cross-course current biases a tack-bisector TWD by

```
bias(deg) ≈ 57.3 · c⊥ · cos(TWA) / V
```

Inverting it gives the requirement — how well must `c⊥` be known to hit a given
TWD accuracy:

| target TWD error | 49er (6 kn, 42°) | 470 (5 kn, 43°) | ILCA (4.5 kn, 45°) |
|---|---|---|---|
| **1°** | 0.14 kn | 0.12 kn | 0.11 kn |
| 2° | 0.28 kn | 0.24 kn | 0.22 kn |
| 5° | 0.70 kn | 0.60 kn | 0.56 kn |

**To reach the ~1° that a pooled fleet otherwise achieves, cross-course current
must be known to about 0.1–0.15 knots.** No free model delivers that in a bay.
That single number frames everything below — and it is the strongest argument
that the *track-derived* current solve (L4) will beat any model at venue scale,
because it measures the water the boats were actually in.

The model's job is therefore not correction. It is:

1. a **prior** to seed and stabilise the L4 solve,
2. **validation** — an independent check, exactly as Open-Meteo is for wind,
3. a **flag**: "current is 1.8 kn across the course today, so an uncorrected
   TWD is ~10° wrong" is enormously useful even when the number is rough.

---

## 2. The drop-in: Open-Meteo Marine

SSA already uses Open-Meteo for wind, so this is the same client, the same
billing, the same failure modes.

| | |
|---|---|
| variables | `ocean_current_velocity`, `ocean_current_direction` (0° = northward, 90° = eastward) |
| model | **MeteoFrance SMOC — "Currents & Tides"**, so the tidal component *is* included |
| resolution | **0.08° ≈ 8 km** |
| cadence | hourly; **15-minutely for Central Europe and North America** |
| history | **from January 2022**, plus 10-day forecast, updated every 24 h |
| cost | same free/commercial tiers as the weather API |

And their own warning, which is the important part:

> Tides and ocean currents are computed at 0.08° (~8 km) resolution using
> numerical models. Accuracy at coastal areas is limited. This is not suitable
> for coastal navigation and does not replace your nautical almanac.

**Verdict: adopt it immediately, for the three jobs in §1 — and never as a
correction term.** An 8 km cell cannot represent a tidal gate, a headland
acceleration or a back-eddy, and those are precisely what decide an inshore
race. But it is one API call, it covers every venue on earth, it goes back to
2022, and it costs nothing extra.

*Practical note:* the same per-location billing trap as the wind API applies —
a current track along a boat's path is a sequence of locations. Snap to the
venue, not to the boat.

---

## 3. Region by region

### 3a. Mediterranean — Palma, Hyères, Genoa, Vilamoura

| source | resolution | tides | access |
|---|---|---|---|
| **CMEMS `MEDSEA_ANALYSISFORECAST_PHY_006_013`** | **1/24° ≈ 4 km**, hourly | weak tides, largely resolved | free, registration; Python toolbox / OPeNDAP / subsetting |
| Open-Meteo | 8 km | yes | REST |

**The Med is effectively non-tidal.** Tidal range is small and currents are
mostly wind-driven and inertial — typically well under 0.5 kn. Two consequences,
both already exploited in Part 4 of the TWD doc:

- This is where **per-device compass calibration is identifiable**, because
  there is no cross-wind current to be confounded with a magnetometer offset.
- This is where the L4 current solve matters **least**. The Palma dataset
  validated the wind method precisely because current was negligible.

### 3b. NW Europe — Weymouth, the Solent, Cherbourg, La Rochelle, Medemblik

The hardest case and the best free data.

| source | resolution | tides | notes |
|---|---|---|---|
| **CMEMS `NWSHELF_ANALYSISFORECAST_PHY_004_013`** | **1.5 km**, 33 levels | **yes — coupled hydrodynamic-wave model with tides** | **quarter-hourly**, hourly, daily *de-tided* (Doodson filter), monthly. 7-day forecast, updated daily. North Sea, Irish Sea, English Channel |
| Tidetech | high-res proprietary | yes | €59/mo or €399/yr recreational single-user; enterprise for API. Supplies America's Cup, Volvo, Olympics |
| Admiralty atlases (NP250, NP337) | chart-scale | yes | paper/raster, not an API |
| XTide | harmonics | yes | **UK/NL data last updated 2011 — do not use** |

Two things make NWSHELF the pick. **1.5 km with tides** is 25× the areal
resolution of Open-Meteo. And the **de-tided variant** is quietly valuable: the
difference between the full and de-tided fields *is* the tidal stream, which
lets us separate the slowly-varying residual from the semi-diurnal signal —
the same additive decomposition used for wind in §13b.

Even so: 1.5 km will not resolve the Solent's gates or a Weymouth back-eddy to
0.15 kn. Here the L4 track solve should be primary and NWSHELF the prior.

### 3c. Baltic — Kiel, Warnemünde, Gdynia, Helsinki

| source | resolution | notes |
|---|---|---|
| **CMEMS `BALTICSEA_ANALYSISFORECAST_PHY_003_006`** | **1 nautical mile (~1.85 km)**, NEMO v4.2.1, up to 56 levels | hourly instantaneous, **plus a 15-minute surface dataset for sea level and surface currents**, plus de-tided daily. Updated twice daily (10-day and 6-day forecasts) |

The Baltic is near-tideless, but **not currentless** — wind-driven set-up,
seiches and outflow produce 0.5–1 kn, and unlike tide it is not predictable from
an almanac. So the model matters *more* here than the small tidal range
suggests, and the 15-minute surface current product is the right one.

### 3d. US East — Newport, Annapolis, Charleston, Miami

Two complementary NOAA products, both free, both with real APIs.

| source | what | resolution |
|---|---|---|
| **CO-OPS current predictions** (`api.tidesandcurrents.noaa.gov/api/prod/`) | **2,700+ stations**; harmonic stations give predictions at *any* interval, subordinate stations only max/slack | point |
| **Operational Forecast Systems (OFS)** | gridded nowcast + 48 h forecast of currents, temperature, salinity; run 4×/day | e.g. **CBOFS** (Chesapeake) 332×291 grid, **29–34 m at its finest**, ~3.4–4.9 km at its coarsest |

**US coverage is the best of any region**, and the OFS grids are the only public
data in this document that reach the ~0.1 kn venue scale. The catch is that OFS
is a *set* of regional models, so coverage must be checked per venue rather than
assumed; the CO-OPS station API is the universal fallback.

Note the subordinate-station limitation: max/slack only is not enough to build a
continuous current track. Prefer a harmonic station or an OFS grid.

### 3e. US West — San Francisco, Long Beach, Seattle

Same two products. **SFBOFS** covers San Francisco Bay, where currents reach
several knots and unambiguously decide races — the single strongest case in this
document for a real current model rather than a global average. Puget Sound and
the Columbia River are covered by their own OFS.

---

## 4. What to build

**Now — cheap and useful:**

1. Add `ocean_current_velocity` + `ocean_current_direction` to the existing
   Open-Meteo client as a **named wind/current source** in the registry from
   §13d of the TWD doc (`kind: 'model'`, `reference: 'ground'`).
2. Show it on the session as context, and compute the **implied TWD bias** from
   §1's formula. That one derived number — "0.9 kn across the course ≈ 5° of
   TWD bias if uncorrected" — is more actionable than the raw vector.
3. Use it to **gate claims**: below ~0.15 kn cross-course, report TWD without a
   current caveat; above it, mark the estimate as ground-wind-only until L4
   runs.

**Later — per venue, not global:**

4. A **per-venue current source** on the venue/campaign record, exactly as the
   per-boat profile names a parser: `{ source: 'nwshelf' | 'ofs:cbofs' |
   'cmems:baltic' | 'open-meteo' | 'tidetech', ... }`. An Olympic campaign
   visits perhaps 6–10 venues in a quad, so curating them is a small, bounded
   job — and venue knowledge is already SSA's differentiator.
5. CMEMS access is **not** a simple REST call (Python toolbox / OPeNDAP /
   subsetting service, free but registered), so it wants a scheduled job that
   caches a venue box for the session dates, not a per-request fetch.

**Probably never:** paying for Tidetech unless a specific tidal venue in the
campaign justifies it. €399/yr recreational is not the blocker; the enterprise
API tier is, and the L4 solve may make it unnecessary.

---

## 5. Honest limits

- **No free source meets the 0.1–0.15 kn bar** at racecourse scale outside the
  US OFS grids. The model is a prior and a check, not a correction.
- **Everything about current in this project is still untested.** The only
  dataset in hand is Palma, which has no tide. Nothing here — including the
  bias formula's practical usefulness — should be considered validated until a
  Solent, Weymouth or San Francisco day exists.
- Open-Meteo currents start **January 2022**; older sessions have no baseline.
- Model currents are **ground-referenced**, which is the right frame: it is
  exactly the vector that converts track-derived ground wind into true wind
  (§11). That consistency is a point in favour of using it as the L4 prior.

---

## Sources

- [Open-Meteo Marine Weather API](https://open-meteo.com/en/docs/marine-weather-api) (MeteoFrance SMOC Currents & Tides, 0.08°, 15-minutely in Europe/NA, from Jan 2022) · [New weather and marine models](https://openmeteo.substack.com/p/new-weather-and-marine-models-integrated)
- [CMEMS NWSHELF_ANALYSISFORECAST_PHY_004_013](https://data.marine.copernicus.eu/product/NWSHELF_ANALYSISFORECAST_PHY_004_013/description) (1.5 km, tides, quarter-hourly, de-tided variant) · [NWS Monitoring Forecasting Centre](https://marine.copernicus.eu/about/producers/nws-mfc)
- [CMEMS BALTICSEA_ANALYSISFORECAST_PHY_003_006](https://data.marine.copernicus.eu/product/BALTICSEA_ANALYSISFORECAST_PHY_003_006/description) (1 nm, 15-min surface currents)
- [CMEMS Mediterranean currents](https://www.luckgrib.com/models/cmems_med/) (1/24° ≈ 4 km) · [Copernicus Marine data access](https://marine.copernicus.eu/access-data/)
- [NOAA CO-OPS API](https://api.tidesandcurrents.noaa.gov/api/prod/) · [National Current Observation Program](https://co-ops.nos.noaa.gov/ncop.html) · [OFS overview](https://tidesandcurrents.noaa.gov/models.html) · [CBOFS](https://tidesandcurrents.noaa.gov/ofs/cbofs/cbofs_info.html) · [SFBOFS](https://tidesandcurrents.noaa.gov/ofs/sfbofs/sfbofs_info.html)
- [Tidetech pricing](https://www.tidetech.org/pricing/) · [Tidetech Data API](https://docs.tidetech.org/data-api/) · [Tidetech sailing](https://tidetechmarinedata.com/solutions/sailing/)
- [Admiralty Tidal Stream Atlas — NW Europe](https://assets.admiralty.co.uk/public/2021-10/Tidal%20Stream%20Atlas%20NW%20Europe_0.pdf)
