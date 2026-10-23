// Which venues are being watched DENSELY right now, and which are just ticking over.
//
// THE POINT. A dense network is worth having while a regatta is on and worth
// almost nothing the rest of the time. Saint-Tropez graded out to 50 nm is
// about sixty Davis stations; twelve venues like that is several hundred,
// polled every half hour, for ever, to answer questions nobody is asking in
// February. The observations are also not free to anybody else — most of them
// come off somebody's public endpoint as a favour.
//
// So each venue has two modes:
//
//   dense   the full graded set — everything inside the inner circle and a
//           thinning spread out to the outer edge. What you want when the
//           model is running for that domain and people are racing on it.
//   idle    the inner circle only. Enough to answer "what is it doing there"
//           and to keep a continuous record at the places that matter, at a
//           fraction of the requests.
//
// WHAT TURNS A VENUE DENSE. Two things, and both are needed:
//
//   1. A WINDOW, stored in obs_venue_activation. A regatta's dates are known
//      weeks ahead — Les Voiles, a worlds, a training block — so they are set
//      once and the density turns itself on and off. This is the normal case,
//      and it is why windows exist rather than a boolean: a flag has to be
//      remembered twice, and the second time is the one that gets forgotten
//      and leaves the dense set running all winter.
//   2. A FORCE LIST, for "when I say so" — the cron's ?domains=, which the
//      NWP box can generate from its own NESTS config so the observations
//      follow the model automatically, or a hand-run poll.
//
// Force ADDS; it never takes away. A venue inside a stored window stays dense
// whatever the force list says, because the window is the deliberate decision
// and the force list is the ad-hoc one.
//
// NOTHING HERE DECIDES WHAT TO DO ABOUT IT. It returns a mode and a radius;
// each source filters its own stations. That keeps this testable without a
// network, a database or a clock.

import { GRADED_DEFAULTS } from './obsDensity'

export type VenueMode = 'dense' | 'idle'

export interface ActivationWindow {
  venueKey: string
  startsAt: string
  endsAt: string
  reason?: string | null
}

export interface ActivationInput {
  windows?: readonly ActivationWindow[]
  /** Venue keys to force dense regardless of windows. 'all' forces every venue. */
  force?: readonly string[]
  nowMs?: number
}

/**
 * How far out an idle venue is polled — CHOSEN BY MEASUREMENT, not by feel.
 *
 * The three per-station registries hold 239 stations between them. Counting
 * how many sit within each radius of any venue (23 Oct 2026):
 *
 *     1 nm     9     2 nm    28     3 nm    51
 *     5 nm    96     8 nm   144    10 nm   167
 *
 * 10 nm was the first guess and it is nearly worthless: it keeps 167 of 239,
 * a 30 % cut, because a garden station in a coastal town is usually within
 * 10 nm of the venue centre anyway. 3 nm keeps 51 — about 2,450 requests a
 * day against 11,500 — and 3 nm of the committee boat is still the race area.
 *
 * BUT A RADIUS ALONE LEAVES VENUES DARK. At 5 nm Porto Cervo has no station
 * at all, and at 1 nm six of the twelve venues have none. A venue with no
 * continuous record is worse than a venue polled slightly too widely: the
 * gap is invisible until somebody looks for last month's wind and it is not
 * there. Hence the floor below.
 */
export const IDLE_NM = 3

/**
 * The nearest few stations are polled even when they are outside IDLE_NM, so
 * that EVERY venue keeps a continuous record however sparse its neighbourhood.
 * This is what stops Porto Cervo going dark out of season.
 */
export const IDLE_MIN_PER_VENUE = 3

export const FORCE_ALL = 'all'

const norm = (s: string): string => s.trim().toLowerCase()

/** Does this window cover `nowMs`? A window with unreadable dates covers nothing. */
export function windowCovers(w: ActivationWindow, nowMs: number): boolean {
  const a = Date.parse(w.startsAt)
  const b = Date.parse(w.endsAt)
  // A broken row must not switch dense polling ON — failing closed is the
  // cheap direction here, and a missing dense set is visible on the map while
  // an accidental one is only visible on somebody else's rate limit.
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return false
  return nowMs >= a && nowMs <= b
}

export function venueMode(venueKey: string, input: ActivationInput = {}): VenueMode {
  const now = input.nowMs ?? Date.now()
  const key = norm(venueKey)
  const forced = (input.force ?? []).map(norm)
  if (forced.includes(FORCE_ALL) || forced.includes(key)) return 'dense'
  for (const w of input.windows ?? []) {
    if (norm(w.venueKey ?? '') === key && windowCovers(w, now)) return 'dense'
  }
  return 'idle'
}

/** The radius a venue is polled to, given its mode. */
export function pollRadiusNm(mode: VenueMode, denseOuterNm: number = GRADED_DEFAULTS.outerNm): number {
  return mode === 'dense' ? denseOuterNm : IDLE_NM
}

export interface VenueDecision {
  key: string
  name: string
  lat: number
  lon: number
  mode: VenueMode
  radiusNm: number
  /** The window that made it dense, when one did — for the poll's own report. */
  reason: string | null
}

/**
 * Decide every venue at once, which is what the poller actually needs, and
 * report why — a poll that quietly stopped collecting a venue is the kind of
 * thing that is noticed a season later.
 */
export function decideVenues(
  venues: readonly { key: string; name: string; lat: number; lon: number; dense?: { outerNm?: number } }[],
  input: ActivationInput = {},
): VenueDecision[] {
  const now = input.nowMs ?? Date.now()
  const forced = (input.force ?? []).map(norm)
  return venues.map((v) => {
    const mode = venueMode(v.key, { ...input, nowMs: now })
    let reason: string | null = null
    if (mode === 'dense') {
      if (forced.includes(FORCE_ALL)) reason = 'forced: all'
      else if (forced.includes(norm(v.key))) reason = 'forced'
      else {
        const w = (input.windows ?? []).find(
          (x) => norm(x.venueKey ?? '') === norm(v.key) && windowCovers(x, now),
        )
        reason = w ? (w.reason?.trim() || `window ${w.startsAt} → ${w.endsAt}`) : 'window'
      }
    }
    return {
      key: v.key,
      name: v.name,
      lat: v.lat,
      lon: v.lon,
      mode,
      radiusNm: pollRadiusNm(mode, v.dense?.outerNm),
      reason,
    }
  })
}

/**
 * Force keys that match no venue. Worth returning rather than ignoring: a
 * typo in a cron line would otherwise mean the regatta is simply not covered,
 * with every check green.
 */
export function unknownForceKeys(
  venues: readonly { key: string }[],
  force: readonly string[] = [],
): string[] {
  const known = new Set(venues.map((v) => norm(v.key)))
  return force
    .map((f) => f.trim())
    .filter((f) => f && norm(f) !== FORCE_ALL && !known.has(norm(f)))
}

/** `?domains=st-tropez,solent` → ['st-tropez','solent']. */
export function parseForceParam(raw: string | null | undefined): string[] {
  if (!raw) return []
  return raw.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean)
}
