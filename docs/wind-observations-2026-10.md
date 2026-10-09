# Live wind observations on the wind field — what we can get, and what it costs

**Status:** research · 3 Oct 2026 · feeds `windField.js` + `ForecastView.jsx`
**Question asked:** pull local wind observations onto the wind-field display — airports, ships,
PWS, buoys and our own — coloured by class.

---

## 1. The short answer

There is plenty available and most of what we want is free, but **the hard part is not
fetching it — it is making an observation comparable to the model wind we draw it on top of.**
A rooftop Netatmo in Saint-Tropez village and the 1 km nest's 10 m wind over the race area are
not the same quantity, and plotting them side by side without saying so invites the crew to
"correct" a good forecast against a bad measurement. §6 is the part that decides whether this
feature helps or hurts.

Recommended first cut (§7): **METAR + Météo-France (incl. buoys and ships) + FFVL balises +
our own boat**, four sources, all free, all genuinely 10 m-or-known-height, covering every
Mediterranean venue we race. Netatmo and the other PWS networks come second, behind a trust
weight and a visible "unverified siting" treatment.

---

## 2. What the wind-sport sites actually use

Worth knowing, because it is where the dense coastal coverage lives — these networks exist
precisely because national networks are thin on the exact beaches we race off.

| Network | What it is | Coverage near us | Access |
|---|---|---|---|
| **FFVL balises** | French free-flight federation's own beacons, ~200 of them, built from 2006 | France incl. the whole Med coast — Hyères, Leucate, Marseille | **Free, open data, 5-minute updates, JSON, 72 h history** ([data.ffvl.fr](https://data.ffvl.fr/), [data.gouv.fr](https://www.data.gouv.fr/datasets/reseau-de-balises-et-donnees-meteo-de-la-ffvl)) |
| **Pioupiou / OpenWindMap** | Open wind sensors, community-run, federated on openwindmap.org | France, Spain, Italy — kite and paraglider spots | Free in principle; `openwindmap.org/api` returned **403** to an anonymous fetch, so it needs a conversation or a key. Stations are also surfaced as `openwindmap.org/PP<id>` |
| **Holfuy** | Commercial wind stations, very common at European kite/paraglider spots | Alps, Adriatic, some Med | API exists (`api.holfuy.com/live/`, JSON/CSV/XML) but is **password-protected — you email info@holfuy.hu describing the project**, and any station owner can switch access off ([api.holfuy.com](https://api.holfuy.com)) |
| **Windguru stations** | Windguru's own station network, heavily used by windsurf/kite spots | Med, strong in Croatia/Greece/Canaries | JSON API documented at [stations.windguru.cz](https://stations.windguru.cz/json_api_stations.html) |
| **Windy Stations** | Windy's PWS network — **brand new API, effective January 2026** | Global, dense | API key; reading other people's stations is allowed **for stations shared under an Open licence** ([stations.windy.com/api-reference](https://stations.windy.com/api-reference)) |

**Takeaway:** the kitesurf/paraglider world runs on FFVL + Pioupiou + Holfuy. FFVL is the one
that is unambiguously free, documented and open, and it happens to cover the French Med coast
densely. That is our best "local spot" source for Riviera venues.

---

## 3. Airports — the reliable backbone

**NOAA Aviation Weather Center**, [aviationweather.gov/api/data/metar](https://aviationweather.gov/data/api/):

- Worldwide METAR, **no API key, anonymous**, JSON / GeoJSON / CSV / XML.
- Rate limit **100 requests/min**; they ask for a custom User-Agent and no more than
  1 req/min per thread. 15 days of history.
- Supports bounding-box queries — so we query a box around point 1 rather than hardcoding
  ICAO codes per venue, and new venues work with no code change.

METAR is the best-behaved observation we can get: a known 10 m height, a defined 10-minute
averaging period, a separate gust, and a station someone maintains. The catch is that airports
are inland and the wind there is not the wind on the course — see §6.

Also useful: **Iowa State Mesonet** keeps a free global METAR archive in CSV/JSON if we ever
want to verify retrospectively rather than live.

---

## 4. Ships, buoys and national networks

| Source | Gives us | Cadence / latency | Access |
|---|---|---|---|
| **Météo-France "Données d'Observation"** | SYNOP stations, **Météo-France buoys**, and **partner ships** — wind dir `dd`, speed `ff`, gust `fxi10` | 6-minute, hourly, SYNOP 3-hourly (~1 h delivery). **24 h retention only** | OAuth2 token, GeoJSON/CSV, endpoints `/station-horaire`, `/synop`, `/bouees` ([docs](https://confluence-meteofrance.atlassian.net/wiki/spaces/OpenDataMeteoFrance/pages/853934243/API+Cibl+e+Obs+EN)) |
| **Puertos del Estado (Spain)** | Buoy network incl. Balearics/Catalonia — wind, pressure, waves, SST | **Buoys hourly**, tide gauges every minute | Open via Portus/iMar; widget and data services rather than a clean REST API ([portus.puertos.es](https://portus.puertos.es/Portus/docs/widgets.pdf)) |
| **NDBC (US)** | ~700 buoys — matters for **Newport**, not the Med | Hourly | Free, no key |
| **Copernicus Marine In Situ TAC** | Moored + drifting buoys, ferrybox, Med component run by HCMR | **24–48 h latency** | We already hold CMEMS credentials ([marineinsitu.eu](https://marine.copernicus.eu/about/producers/insitu-tac)) |
| **Italy — regional ARPA / ItaliaMeteo MeteoHub** | Ground networks per region; ARPAE publishes `realtime.jsonl` | Real time | Open but **fragmented by region** — Sardinia (Porto Cervo) is ARPAS, a separate integration from ARPAE |

**Two things to note.** First, **CMEMS In Situ is not a race-day source** — 24–48 h latency
makes it a verification archive, not a live layer. Second, Météo-France is the single richest
hit on the brief: it is the one source that gives us airports, buoys *and* ships through one
API, for the venues we actually race.

**ilMeteo** is a consumer site, not a data provider — it republishes SYNOP/METAR. There is no
observation API to integrate; anything we would take from it we can take from the source.

---

## 5. PWS, "home" observations — and the licensing trap

| Source | Access | Catch |
|---|---|---|
| **Netatmo `getpublicdata`** | **Free**, OAuth client ID/secret, bounding-box query, returns public stations' wind ([dev.netatmo.com](https://dev.netatmo.com/apps)) | The wind module is an **optional extra most owners never buy**, so density is a fraction of Netatmo's temperature coverage — and the ones that exist are on roofs and in gardens |
| **meteoblue Measurements API** | Paid, pre-paid credits | **40,000+ stations**, 10-min to hourly, national institutes plus PWS ([docs.meteoblue.com](https://docs.meteoblue.com/en/weather-apis/measurements-api/overview)) — the cleanest single commercial aggregator |
| **Weather Underground / Ecowitt / WeatherLink** | Keys, varying terms | Fine for *our own* station; messy as a network |
| **Windy Stations** | API key, Open-licence stations only | New Jan 2026; see §2 |
| **PredictWind** | **No public API** | But its sources are documented: **MADIS, NDBC, and SOFAR** ([predictwind.com](https://predictwind.com/news/press-release/new-observations)) — so go to those directly rather than to PredictWind |

### The MADIS trap — read before anyone wires it in

MADIS looks like the jackpot: one NOAA interface covering METAR, mesonets, maritime and PWS.
But its datasets carry **distribution categories**, and mesonet data is restricted:
providers *"request that users not redistribute or place the data on web pages"*, and
redistribution outside the "Public — full distribution" category **is not allowed, including
placing the data on public web pages.** Derived graphics are permitted as long as an end user
cannot pull actual values back out ([MADIS restrictions](https://madis.ncep.noaa.gov/madis_restrictions.shtml)).
Access requires an application form and you are assigned a category.

SSA is login-gated rather than public, which is a better position than a public site, but it
is still redistribution to people outside our organisation. **If we want MADIS we apply and
ask for the right category — we do not quietly scrape it.** This is very likely why
PredictWind can show it and we cannot simply copy them.

### Our own observations are the ones nobody else has

Worth saying plainly: **SSA already ingests the boat's instrument log, with TWS and TWD at
masthead height, positioned and time-stamped.** That is a calibrated anemometer sitting exactly
where the race is, which is better than anything in §2–§5 for our purpose. The same is true of
the RIB if it logs. A "ours" class on this layer costs no new integration — the data is already
in the cloud log — and it is the one source where we know the height, the calibration history
and the siting.

---

## 6. The part that decides whether this helps

An observation and the model's 10 m wind are different quantities, and four differences all
push the same way — toward the observation reading **lower** than the model:

1. **Height.** A Netatmo on a 6 m roof, an FFVL beacon on a 15 m mast and a METAR at 10 m are
   three different winds. Our own `seaSurfaceFill` / `profileReader` work already gives us the
   machinery to normalise an observation to 10 m — but only if we know the sensor height, and
   most networks do not publish it reliably.
2. **Siting.** Land stations are sheltered, accelerated or channelled by whatever is upwind.
   An airport 40 km inland in a sea breeze is measuring a different circulation, not a noisier
   version of ours.
3. **Averaging.** METAR is a 10-minute mean with a separate gust. A PWS may report a 1-minute
   or instantaneous value. Our model wind is a grid-box mean. Comparing an instantaneous PWS
   reading to a model mean will look like a model error and is not one.
4. **Land vs sea.** Every land station sits over a rougher surface than the course. Even
   perfectly sited and height-corrected, it reads lower than the water a mile away.

**Design consequence:** each observation carries a **trust weight** and a **height**, the layer
normalises to 10 m where height is known, and marks it explicitly where it is not. A station we
cannot place on a mast height is drawn in a "siting unknown" treatment and never silently
averaged into anything. This is the same discipline as the model `WEIGHTS` — a weak source
contributing a weak amount, not an equal vote.

**The bigger prize** is not the display at all. We have MOS machinery (`mos.js`,
`wv_model_score`) that currently corrects against a thin verification set, and a TWD
ground-truth corpus that wants more paired hours. A live observation feed is **verification
data**: it tells us which model is right at this venue today, which is exactly what the
Confidence and MOS work has been short of.

---

## 7. Recommendation

**Phase 1 — four sources, all free, all known-height.**

| Class | Source | Colour |
|---|---|---|
| Airport | aviationweather.gov METAR, bbox query | blue |
| Official / marine | Météo-France obs — SYNOP, **buoys**, **ships** | cyan (buoy) / white (ship) |
| Spot beacon | FFVL balises | amber |
| **Ours** | boat + RIB from the cloud log | **magenta, heavier weight** |

Newport adds NDBC on the same marine class. This gets every Mediterranean venue covered without
a single licensing conversation or paid tier.

**Phase 2 —** Netatmo (free, needs OAuth app) and Windy Stations (new API) for coastal density,
behind the trust weight and the "siting unknown" treatment.

**Phase 3 — only if Phase 1 proves useful:** Holfuy (email for access), Pioupiou/OpenWindMap
(resolve the 403), meteoblue Measurements (paid, the clean way to buy breadth), MADIS (apply
properly for a distribution category).

### Implementation shape

- One normaliser, `lib/windObs.js`: `{ id, source, lat, lon, heightM, tws, twd, gust, t, trust }`.
  Every network gets an adapter into that shape; nothing downstream knows which network it came from.
- **Fetch server-side, not from the browser.** Météo-France needs an OAuth token and Netatmo a
  client secret — neither belongs in a client bundle — and one server fetch serves the whole
  team instead of each phone hitting the rate limit separately. A Next route (`/api/obs`) with a
  short cache, in the same shape as the existing `/api/bunny/storage` proxy.
- Render as a Leaflet layer of `divIcon` barbs above `leaflet-velocity`, one colour per class,
  with age-based fading so a stale station visibly decays rather than lying.
- Reuse `venueTz`/`wallHour` for the timestamps; observations are UTC and must stay that way
  until they are displayed (see the CLAUDE.md clock trap).

### Open questions for you

1. **Which station do you have at home / on the boat**, and does the RIB log? That decides the
   "ours" adapter and it is the highest-value source on the list.
2. Is the app's audience still team-only? It changes what we can accept from MADIS and the
   restricted mesonets.
3. Do you want the obs layer feeding **MOS/verification** from the start, or display first?

---

## Sources

- [NOAA Aviation Weather API](https://aviationweather.gov/data/api/)
- [Météo-France — API Données d'Observation](https://confluence-meteofrance.atlassian.net/wiki/spaces/OpenDataMeteoFrance/pages/853934243/API+Cibl+e+Obs+EN)
- [FFVL balise network — data.gouv.fr](https://www.data.gouv.fr/datasets/reseau-de-balises-et-donnees-meteo-de-la-ffvl)
- [OpenWindMap forum](https://forum.openwindmap.org/) · [Holfuy API](https://api.holfuy.com) · [Windguru Stations JSON API](https://stations.windguru.cz/json_api_stations.html) · [Windy Stations API](https://stations.windy.com/api-reference)
- [Netatmo developer apps](https://dev.netatmo.com/apps)
- [meteoblue Measurements API](https://docs.meteoblue.com/en/weather-apis/measurements-api/overview)
- [PredictWind — new observations](https://predictwind.com/news/press-release/new-observations)
- [MADIS dataset restrictions](https://madis.ncep.noaa.gov/madis_restrictions.shtml) · [MADIS data application](https://madis.ncep.noaa.gov/data_application.shtml)
- [Copernicus Marine In Situ TAC](https://marine.copernicus.eu/about/producers/insitu-tac)
- [Puertos del Estado — Portus widgets](https://portus.puertos.es/Portus/docs/widgets.pdf)
