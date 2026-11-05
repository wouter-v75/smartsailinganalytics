// Per-venue MOS findings (prose) shown in the Venue MOS tab. Mirrors the
// summaries in Smart Sailing Analytics/wind-verification/build_corrected.py.

// KEYED BY THE VENUE LIST (lib/venues.ts), hyphenated. This file used to keep
// its own labels and its own key order — a fourth spelling of the same three
// places, after MOS's, the observation network's and VENUE_COAST_NORMAL's.
// The labels and the order now come from the one list, so a venue cannot
// appear in the MOS picker under a key the spec table does not recognise.
import { calibratedVenues, venueLabel } from './mos'

export const VENUE_KEYS = calibratedVenues()

export const VENUE_LABEL = Object.fromEntries(
  VENUE_KEYS.map((k) => [k, venueLabel(k) || k]),
)

export const FINDINGS = {
  sorrento: {
    regime: 'SW sea-breeze dominates — TWD 200–270° is ~76% of bins. ' +
      'Thermal-driven: the breeze builds through the afternoon. 445 bins over ' +
      'three May regattas, 2024–2026.',
    zones: 'Every model UNDER-forecasts. Worst is the E–S sector (80–200°), ' +
      'where ICON-EU runs ~7 kn light — but it is infrequent. The dominant ' +
      'SW sea-breeze sector is under by 1–3.3 kn. N–NE (0–70°) has TWO bins in ' +
      'the whole archive, so its offset is shrunk 80% toward the global one.',
    best: 'ECMWF takes DIURNAL (4.60→3.34, 27.4%) — the deficit tracks ' +
      'time-of-day and direction skill here is poor (59–70% agreement). ' +
      'ICON-EU takes SECTOR (4.82→3.52, 26.8%), narrowly over diurnal. ARPEGE ' +
      'is raw: its fitted form FAILS THE TAIL BAR, keeping none of the raw ' +
      'forecast’s 16 kn hits.',
    rec: 'ECMWF + diurnal or ICON-EU + sector (~3.4 kn). AROME is out of ' +
      'domain; ICON-2I and ARPEGE ship raw. Worth knowing before you trust a ' +
      'breeze forecast here: NO model has ever forecast 16 kn at Sorrento ' +
      '(0 of the 35 bins that reached it), so there is no strong-wind warning ' +
      'to preserve and none to rely on either.',
  },
  'porto-cervo': {
    regime: 'Funnel / lee — mistral and gap-flow through the Bonifacio strait ' +
      '& Maddalena islands. Windier (median ~12 kn).',
    zones: 'Strongly direction-dependent (the headline). NW gap-flow ' +
      '(270–330°) is UNDER-forecast 1.3–3.4 kn (acceleration the models miss); ' +
      'the E–SE lee (90–120°) is OVER-forecast up to +2 kn. The two cancel, so ' +
      'the average bias looks ~0 and masks a real directional error.',
    best: 'DIRECTIONAL (sector). Model direction skill is high (82–91% ' +
      'agreement), so a per-regime correction keyed on forecast direction ' +
      'validates out-of-sample: ARPEGE 3.63→2.95 (18.7%), ICON-EU 3.41→2.83 ' +
      '(16.9%, bias+scale). Diurnal does NOT help — no thermal timing. ' +
      '337 bins over three September regattas, 2024–2026.',
    rec: 'ARPEGE + sector (~2.95 kn) or ICON-EU. AROME underperforms here ' +
      '(southern domain edge). ECMWF IS NOW RAW and that is deliberate: its ' +
      'fitted correction cut rmse 14.6% by flattening the breeze — it kept ' +
      'only 27% of the raw forecast’s 20 kn+ hits (10 of 37) and turned a ' +
      '+0.8 kn error at 22 kn+ into −4.0. A pure offset there is WORSE than ' +
      'raw, so the whole gain was slope shrinkage and nothing else.',
  },
  'st-tropez': {
    regime: 'Mixed — June sea-breeze (windier, ~12 kn) + October ' +
      'gradient/mistral (lighter). Most predictable venue (RMSE 2.3–3.4 kn).',
    zones: 'S–W (160–260°) is the problem regime — under-forecast 2–3 kn, ' +
      'highest RMSE. E–SE (30–150°) is handled well. NW/mistral (270–330°) is ' +
      'under-forecast but rare (mostly June) — needs more data before it can ' +
      'be corrected.',
    best: 'BIAS+SCALE, for both shipped models: ICON-EU 3.00→2.46 (18%) and ' +
      'ECMWF 2.87→2.33 (18.6%). 457 bins over four regattas — and this ' +
      'season’s (Sept–Oct 2026, Northstar 76) is what EARNED ECMWF its ' +
      'correction: it holds in all three of its blocks where two could not ' +
      'tell a correction from a coincidence.',
    rec: 'ICON-EU or ECMWF + bias/scale (~2.4 kn). AROME and ARPEGE ship raw. ' +
      'AROME’s loss is the instructive one: its October-gradient fit held ' +
      'across two October regattas and does NOT hold across three (2.31→2.74 ' +
      'on the 2026 block), so the venue’s seasonal sea-breeze window is gone ' +
      'with it. Note the 2026 regatta ran E–SE throughout, so NW has 18 bins ' +
      'in the whole archive and S–W none from this season — those offsets come ' +
      'from 2023 and 2025.',
  },

  //  THE STATION-FITTED VENUES. Truth is a public anemometer over five years,
  //  not a boat log over a few regattas, so there is no "sector agreement"
  //  column (a station has no heading to agree with) and the blocks are YEARS.
  'san-juan': {
    regime: 'Tidal strait, not a sea-breeze basin — the eastern Strait of ' +
      'Juan de Fuca funnels between Vancouver Island and the Olympics. Truth ' +
      'is Smith Island (NDBC SISW1), a low island 14.8 nm from the venue, ' +
      'anemometer 17.4 m reduced to 10 m; five years, 2022–2026.',
    zones: 'Four quadrant bands (N/E/S/W) rather than the Mediterranean’s ' +
      'named sectors, because the funnelling is along the strait axis: E and W ' +
      'are the along-strait regimes and carry most of the hours.',
    best: 'ICON global takes sector+diurnal, the largest gain measured here at ' +
      '25.4% — BUT IT IS NOT APPLIED, and the table says so on its own row. ' +
      'Of what actually reaches the app: GFS global + sector 6%, HRDPS + ' +
      'bias/scale 2.7%, HRRR + bias/scale 1.6%. ECMWF is raw — its best ' +
      'ladder form gained 0.0% and cleared no bar.',
    rec: 'GFS global + sector. The honest summary is that no model is much ' +
      'wrong here once lifted to mast height, which is why three of the four ' +
      'corrections are under 3%. ICON global’s 25.4% is inert until ' +
      'MODELS.ICON stops mapping to icon_eu, which does not reach the Pacific.',
  },
  'long-beach': {
    regime: 'San Pedro Bay, outside the breakwater. Truth is Angels Gate ' +
      '(NOAA CO-OPS 9410647) at the harbour entrance, 1.2 nm from the venue — ' +
      'the closest truth of any venue here. Five years, 2022–2026.',
    zones: 'W 58% / S 27% in the racing season, against 15.6% N year-round: ' +
      'the summer wind collapses onto the sea-breeze quadrant, so the per-band ' +
      'sample floor had to scale with the season arm or the sector term was ' +
      'refused for want of a northerly.',
    best: 'EVERY SHIPPED FORM HAS ITS SLOPE PINNED AT 1 (the a=1 marker), and ' +
      'that is the headline. The ordinary least-squares ladder gained 13–30% ' +
      'here by SHRINKING the forecast toward the mean: corrected ECMWF warned ' +
      'on ZERO of the 130 hours the station really had 18 kn+, where raw ' +
      'warned on 86. Pinning the slope and fitting only bias, sector and ' +
      'diurnal offsets keeps 97–124% of raw’s strong-wind hits: NAM 23.2%, ' +
      'ECMWF 10.0%, HRRR 9.4%, ICON 7.1%, GFS 4.9%.',
    rec: 'NAM where it reaches, else ECMWF or HRRR. June–September is fitted ' +
      'as its OWN arm (Olympic 2028 and the Transpac start fall there) and the ' +
      'season gains are the larger ones — HRRR 19.8%, ICON 15.6%, ECMWF 12.0%, ' +
      'GFS 8.7%. Across five summers the venue never reaches 20 kn (median ' +
      '6.0, max 18.6), so the season bars sit at 12 and 14 kn, read off the ' +
      'distribution rather than chosen.',
  },
}

export const GUIDANCE =
  'Which MOS form wins depends on (1) the dominant error and (2) how reliably ' +
  'the model forecasts the variable you key on. Thermal venues → diurnal ' +
  '(hour is always known). Funnel/regime venues → directional/sector, but ' +
  'only where model direction agreement is high (Porto Cervo & St Tropez ' +
  '~80–90%; not Sorrento at 62%, where diurnal wins instead). A multi-model ' +
  'ensemble mean often beats any single model — strongest at Porto Cervo — ' +
  'and makes a good base before bias-correction.'
