// Which stations may be FITTED against, which are on probation, and which are
// for looking at only.
//
// WHY A TIER AND NOT JUST `trust`. Every observation already carries a 0-10
// `trust` from its source class, which is fine for weighting a map. It is not
// fit for deciding what a CORRECTION may be fitted against, for two reasons:
//
//   IT IS PER SOURCE, NOT PER STATION. All 301 Davis stations score pws/2
//   whether they are Napoli Posillipo on the headland or Baranello in the
//   Apennine interior. Every Meteo-France land station scores synop/7 —
//   including Cap Camarat, 107 m up a cliff, which is a first-rate wind-sector
//   indicator and a poor target for an absolute bias.
//
//   A NUMBER IS NOT A PERMISSION. trust: 2 does not say "never fit on this",
//   so nothing stops a future fitting script pooling all 301 gardens and
//   down-weighting them. The Met Office's own assessment of crowd-sourced wind
//   is that "the observation rejection rate is too high to be useful", and
//   KNMI measured about 19 % surviving QC before any representativeness test.
//   Against that, down-weighting is not a defence; refusing is.
//
// SO THE TIERS ARE PERMISSIONS:
//
//   fit        professionally sited, maintained, and either over water or with
//              known exposure. May be fitted against.
//   probation  real instruments whose siting is known to be compromised, or
//              whose metadata is incomplete. Good for timing, gradient and
//              wind-sector work. NOT for fitting an absolute bias until
//              something has checked them — the O-B monitoring, or a buddy
//              check against neighbours once enough history exists.
//   display    draw it on the map, never compute from it.
//
// WHAT THIS IS NOT. It is not derivable from metadata alone, and pretending
// otherwise would be the error. `seaNm` and a present `height_m` help, but
// "Procida Istituto Nautico" versus "Napoli Meteo Chiaia Live" is not decidable
// from a row — it needs an eye or a monitoring record. So the defaults below
// are by SOURCE, the exceptions are by station and each carries its reason, and
// promotion out of probation is left to evidence rather than guessed at here.

import type { WindObs } from './windObs'

export type ObsTier = 'fit' | 'probation' | 'display'

export const OBS_TIERS: Record<ObsTier, { label: string; mayFit: boolean; note: string }> = {
  fit: {
    label: 'Fit',
    mayFit: true,
    note: 'professionally sited and maintained; may be fitted against',
  },
  probation: {
    label: 'Probation',
    mayFit: false,
    note: 'a real instrument with compromised siting or incomplete metadata — timing and '
      + 'gradient yes, absolute bias no, until something has checked it',
  },
  display: {
    label: 'Display only',
    mayFit: false,
    note: 'draw it, never compute from it',
  },
}

/**
 * Default tier by station-id prefix, which is how provenance is carried.
 *
 * Reasons, station by station, so none of this is a bare assertion:
 *
 *   portlog    ABP Southampton's own met network, pilot-grade, Bramble Bank and
 *              Nab Tower out in the fairway. fit.
 *   ndbc       NOAA buoys: published metadata, marine standard. fit.
 *   mf-buoy    Meteo-France buoys, same case. fit.
 *   mf-ship    a moving platform with an unknown deck height; the reading is
 *              real but the siting changes hourly. probation.
 *   metar      a defined 10-minute mean at a known 10 m, maintained because
 *              aircraft depend on it — and usually the furthest thing from the
 *              water. fit, with its distance the thing to watch.
 *   cco        Channel Coastal Observatory piers: a national programme, over
 *              open water, publishing knots AND m/s so each row checks itself.
 *              fit.
 *   frost      MET Norway: states the unit, the HEIGHT and a quality code per
 *              reading. The best-described source here. fit.
 *   mo         Met Office land observations: hourly, ~50 km spacing, direction
 *              to 16 points. Genuine and coarse — 22.5 deg of direction
 *              resolution is most of a wind shift. probation.
 *   mf-land    RADOME. Professional and well-documented, but sited for
 *              climate, not for sailing: Cap Camarat is a cliff-top.
 *              probation as a class.
 *   rmn        ISPRA: declares height and averaging period, which no one else
 *              does — but "ubicate prevalentemente all'interno delle strutture
 *              portuali", i.e. harbour basins, and published at validation
 *              level L0. probation.
 *   wf         WeatherFile: the RLymYC starting platform and Hurst Castle are
 *              exactly where the racing is, but no anemometer height is
 *              published for any of them. probation.
 *   wle        the curated WeatherLink embeds — NCI lookouts, Hamble harbour
 *              master. Known sites, chosen one at a time. probation.
 *   club       club and coastwatch anemometers: a clubhouse roof is a
 *              clubhouse roof. probation.
 *   wlmap      the 301 public Davis stations. Gardens, unknown siting, and the
 *              class two operational centres say is unusable for wind.
 *              display.
 *   piou       Pioupiou/Windbird spot beacons: sited for a sport. display.
 *   ffvl       free-flight beacons, same case. display.
 *   wl         keyed WeatherLink stations — whatever the account holds, siting
 *              unknown. display.
 */
const TIER_BY_PREFIX: Record<string, ObsTier> = {
  portlog: 'fit',
  ndbc: 'fit',
  'mf-buoy': 'fit',
  metar: 'fit',
  cco: 'fit',
  // FROST IS A NATIONAL NETWORK, so `fit` was the wrong default and this used
  // to sit above with the buoys. Of the 23 stations FROST_SITES names, seven
  // are lighthouses or islands and sixteen are inland — a hilltop at 445 m,
  // three roadside motorway sensors, an airport and a city garden among them.
  // Every one of those was fittable, which is the one kind of bad data the
  // tier exists to keep out and the one you cannot see from the outside.
  //
  // So the open-water ones are PROMOTED by name below and the rest stay here.
  // That way a station added to FROST_SITES tomorrow is safe until somebody
  // looks at it, rather than silently joining the fitting set.
  //
  // Frost's own quality handling is still the best of any source here — it
  // states the unit, the height and a quality code per reading, and
  // parseFrostObs drops anything with a non-zero code. That is why the inland
  // ones are `probation` and not `display`: the readings are trustworthy, the
  // SITES are just not measuring the race area.
  frost: 'probation',
  'mf-ship': 'probation',
  mo: 'probation',
  'mf-land': 'probation',
  rmn: 'probation',
  wf: 'probation',
  wle: 'probation',
  club: 'probation',
  wlmap: 'display',
  piou: 'display',
  ffvl: 'display',
  wl: 'display',
}

/**
 * Per-station departures from the class default, each with its reason.
 *
 * Kept small and explicit on purpose. A long list here would mean the defaults
 * are wrong; a list of none would mean nobody has looked.
 */
export const TIER_EXCEPTIONS: Record<string, { tier: ObsTier; why: string }> = {
  // 107 m up on a headland, 4.1 nm from the Golfe de Saint-Tropez race area,
  // and a WIND-ONLY station — no temperature at all. Superb for which way the
  // gradient is running, wrong for how hard it is blowing on the water.
  'mf-land:83101001': {
    tier: 'probation',
    why: 'Cap Camarat: 107 m cliff-top. Sector indicator, not a bias target.',
  },
  // In the fairway rather than in a basin: a post on the Bramble Bank in the
  // middle of the Solent, and a tower at the eastern approach.
  'portlog:3306': { tier: 'fit', why: 'Bramble Bank, mid-Solent, in open water' },
  'portlog:3304': { tier: 'fit', why: 'Nab Tower, eastern approach' },
  'portlog:3392': { tier: 'fit', why: 'No.4 Buoy, 0.3 nm off Cowes' },
  // Up Southampton Water behind buildings and grain terminals. Real, and not
  // measuring the race area.
  'portlog:3302': { tier: 'probation', why: 'Dock Head: inside the docks' },
  'portlog:3310': { tier: 'probation', why: 'Town Quay: inside the docks' },
  'portlog:3303': { tier: 'probation', why: 'Marchwood: inside the docks' },

  // ── The Norwegian open-water stations, promoted out of frost's inland
  // default. Lighthouses and low islands: water on every side, nothing
  // upwind, and an altitude in single or low double figures.
  'frost:SN27500': { tier: 'fit', why: 'Færder fyr: island lighthouse, 6 m, WMO 1482, records from 1885' },
  'frost:SN29950': { tier: 'fit', why: 'Svenner fyr: island lighthouse S of Larvik, 15 m' },
  'frost:SN17000': { tier: 'fit', why: 'Strømtangen fyr: lighthouse off Fredrikstad, 10 m' },
  'frost:SN17280': { tier: 'fit', why: 'Gullholmen: island in the Oslofjord, 14 m' },
  'frost:SN30235': { tier: 'fit', why: 'Larvik - Fugløya: island off Larvik, 27 m' },
  'frost:SN34130': { tier: 'fit', why: 'Jomfruland: exposed island off Kragerø, 3 m, WMO 1476' },
  'frost:SN250000': { tier: 'fit', why: 'Nordkoster: outer Koster island, Skagerrak, 33 m, WMO 2500' },

  // Tjøme is the instructive one. It is ON the island Færder fyr stands off,
  // 6 nm away and nominally just as coastal — and in the SE gale of
  // 25 Oct 2026 06:30 it read 6.9 m/s against Færder's 21.0. A third of the
  // wind at a station that looks coastal on a map is the whole argument for
  // reading a live value before trusting a site.
  'frost:SN27420': { tier: 'probation', why: 'Tjøme: sheltered — read 1/3 of Færder 6 nm away in the same gale' },
}

/** How far inland a station may be and still be considered for `fit`. */
export const FIT_MAX_SEA_NM = 2

export interface TierDecision {
  tier: ObsTier
  mayFit: boolean
  why: string
}

const prefixOf = (id: string): string => {
  const i = id.indexOf(':')
  return i < 0 ? '' : id.slice(0, i)
}

/**
 * The tier for one observation.
 *
 * `seaNm` may be supplied where it has been measured (the Davis registry
 * records it). It can only ever DEMOTE: a station measured well inland is not
 * a candidate for fitting however good its network, and no distance from the
 * water promotes a garden.
 */
export function tierFor(
  obs: Pick<WindObs, 'id' | 'source'>,
  opts: { seaNm?: number | null } = {},
): TierDecision {
  const id = String(obs.id || '')
  const exception = TIER_EXCEPTIONS[id]
  if (exception) {
    return { tier: exception.tier, mayFit: OBS_TIERS[exception.tier].mayFit, why: exception.why }
  }

  const prefix = prefixOf(id)
  let tier = TIER_BY_PREFIX[prefix]
  let why = tier ? `${prefix}: class default` : ''

  if (!tier) {
    // An id shape nobody has classified is display-only. Defaulting a new
    // source INTO the fitting set is the one mistake that cannot be noticed
    // from the outside.
    tier = 'display'
    why = `unclassified id prefix ${prefix ? `"${prefix}"` : '(none)'} — display until someone says otherwise`
  }

  const seaNm = opts.seaNm
  if (tier === 'fit' && typeof seaNm === 'number' && Number.isFinite(seaNm) && seaNm > FIT_MAX_SEA_NM) {
    return {
      tier: 'probation',
      mayFit: false,
      why: `${why}, but measured ${seaNm} nm from the sea — too far inland to fit against`,
    }
  }

  return { tier, mayFit: OBS_TIERS[tier].mayFit, why }
}

/**
 * The observations a correction may be fitted against.
 *
 * REFUSES rather than down-weights, which is the whole point of the tier. A
 * caller that wants everything should ask for everything explicitly.
 */
export function fitTierOnly<T extends Pick<WindObs, 'id' | 'source'>>(obs: readonly T[]): T[] {
  return obs.filter((o) => tierFor(o).mayFit)
}

/** Counts per tier, for a report or a sanity check. */
export function tierCounts(
  obs: readonly Pick<WindObs, 'id' | 'source'>[],
): Record<ObsTier, number> {
  const out: Record<ObsTier, number> = { fit: 0, probation: 0, display: 0 }
  for (const o of obs) out[tierFor(o).tier]++
  return out
}
