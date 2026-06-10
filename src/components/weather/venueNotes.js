// Per-venue MOS findings (prose) shown in the Venue MOS tab. Mirrors the
// summaries in Smart Sailing Analytics/wind-verification/build_corrected.py.

export const VENUE_LABEL = {
  sorrento: 'Sorrento',
  porto_cervo: 'Porto Cervo',
  st_tropez: 'St Tropez',
}

export const VENUE_KEYS = ['sorrento', 'porto_cervo', 'st_tropez']

export const FINDINGS = {
  sorrento: {
    regime: 'SW sea-breeze dominates — TWD 200–270° is ~76% of bins. ' +
      'Thermal-driven: the breeze builds through the afternoon.',
    zones: 'Every model UNDER-forecasts. Worst is the E–S sector (80–200°), ' +
      'where ICON-EU runs ~7 kn light — but it is infrequent. The dominant ' +
      'SW sea-breeze sector is under by 1–3.3 kn. N–NE (0–70°) barely occurs.',
    best: 'DIURNAL. The deficit tracks time-of-day, and the models’ direction ' +
      'skill is poor here (62% sector agreement), so a direction-keyed ' +
      'correction is unreliable — hour is known exactly. Diurnal cuts RMSE ' +
      '~28–32% (ECMWF 4.83→3.46, ICON-EU 5.17→3.5). Sector/ensemble add little.',
    rec: 'ECMWF or ICON-EU + diurnal (~3.5 kn). AROME is out of domain; ' +
      'ICON-2I shipped raw.',
  },
  porto_cervo: {
    regime: 'Funnel / lee — mistral and gap-flow through the Bonifacio strait ' +
      '& Maddalena islands. Windier (median ~12 kn).',
    zones: 'Strongly direction-dependent (the headline). NW gap-flow ' +
      '(270–330°) is UNDER-forecast 1.3–3.4 kn (acceleration the models miss); ' +
      'the E–SE lee (90–120°) is OVER-forecast up to +2 kn. The two cancel, so ' +
      'the average bias looks ~0 and masks a real directional error.',
    best: 'DIRECTIONAL (sector). Model direction skill is high (87–90% ' +
      'agreement), so a per-regime correction keyed on forecast direction ' +
      'validates out-of-sample: ARPEGE 3.09→2.71, ECMWF 3.01→2.79. Diurnal ' +
      'does NOT help (no thermal timing). The multi-model MEAN beats every ' +
      'single model — a blend is a strong base.',
    rec: 'ARPEGE + sector (~2.7 kn) or a multi-model ensemble. AROME ' +
      'underperforms here (southern domain edge).',
  },
  st_tropez: {
    regime: 'Mixed — June sea-breeze (windier, ~12 kn) + October ' +
      'gradient/mistral (lighter). Most predictable venue (RMSE 2.3–3.4 kn).',
    zones: 'S–W (160–260°) is the problem regime — under-forecast 2–3 kn, ' +
      'highest RMSE. E–SE (30–150°) is handled well. NW/mistral (270–330°) is ' +
      'under-forecast but rare (mostly June) — needs more data before it can ' +
      'be corrected.',
    best: 'MIXED. Simple bias+scale suffices for GFS (2.36) and ICON-EU ' +
      '(2.66); DIURNAL is best for AROME (2.51, in-domain, captures the June ' +
      'sea-breeze); a 3-SECTOR correction validates here (80% agreement) and ' +
      'cuts ECMWF/ICON-EU ~20–24%.',
    rec: 'GFS or AROME (near-raw / small correction), or ECMWF/ICON-EU + ' +
      'sector (~2.5 kn).',
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
