// src/lib/sailTrimLidar.ts
// ─────────────────────────────────────────────────────────────────────────────
// SailTrim's photographed sail shape against the boat's own lidar, at the second
// the shutter fired.
//
// This is the only independent check there is on the whole projection model. A
// photo measurement has no ground truth in it: the residual across several
// frames says the marking was consistent, not that the answer is right, and a
// uniform scale error is invisible in it. The lidar is measured by a different
// instrument through a different physics, so where the two agree it is worth
// something.
//
// TWO COMPARISONS, and the second is the one to trust:
//
//   ABSOLUTE   the chord's angle off the centreplane at a stripe, against the
//              lidar's TW at the same height. Only meaningful if both count
//              their zero from the same place, which is an assumption about
//              KND's convention rather than something either records.
//
//   RELATIVE   the DIFFERENCE between two stripes — 25 % to 75 %, say. Any
//              common zero cancels, so this survives not knowing the
//              convention. When the two disagree on the absolute and agree on
//              the relative, the disagreement is a datum, not the shape.
//
// So both are computed and the relative one is reported as the check.
// ─────────────────────────────────────────────────────────────────────────────

import type { PhaseStat } from './phaseStats'
import { measKey, type LidarSail } from './lidarTables'
import type { SailTrimAnnotation } from './sailTrimOverlay'

/** Draft stripes to the heights the lidar reports. 87 % has no lidar channel. */
export const LIDAR_HEIGHT_BY_TAG: Record<string, number> = {
  stripe25: 25, stripe50: 50, stripe75: 75,
}

export const LIDAR_SAIL_BY_SAIL: Record<string, LidarSail> = { main: 'mn', jib: 'jib' }

/**
 * A photo's instant, in epoch ms.
 *
 * `taken_utc` really is UTC here — the 26 Sep frames read 10:36 against a 12:36
 * CEST shutter — but a bare "YYYY-MM-DD HH:MM:SS" with no zone is parsed as
 * LOCAL by Date, which would shift the whole day by the venue offset and match
 * every photo to the wrong phase. See the clocks trap in CLAUDE.md.
 */
export function photoInstantMs(takenUtc: string | number | null | undefined): number | null {
  if (takenUtc == null) return null
  if (typeof takenUtc === 'number') return Number.isFinite(takenUtc) ? takenUtc : null
  const s = takenUtc.trim()
  if (!s) return null
  const zoned = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(s) ? s : `${s.replace(' ', 'T')}Z`
  const t = Date.parse(zoned)
  return Number.isFinite(t) ? t : null
}

export interface PhaseMatch { phase: PhaseStat; gapMs: number }

/**
 * The phase covering an instant, or the nearest one and how far off it is.
 *
 * Nearest rather than nothing, because a photo landing in a gap between phases
 * still has a sail shape either side of it — but the gap is returned so the
 * caller can refuse it. A phase is 30 s; several minutes away is a different
 * piece of sailing, with the sheet and traveller moved.
 */
export function phaseAt(phases: PhaseStat[], atMs: number): PhaseMatch | null {
  let best: PhaseMatch | null = null
  for (const p of phases) {
    const gap = atMs < p.utc ? p.utc - atMs : atMs > p.endUtc ? atMs - p.endUtc : 0
    if (!best || gap < best.gapMs) best = { phase: p, gapMs: gap }
    if (gap === 0) return best
  }
  return best
}

export interface AngleRow {
  sail: 'main' | 'jib'
  height: number
  photoDeg: number
  photoSigmaDeg: number
  lidarDeg: number | null
  /** photo − lidar, degrees. Null when the lidar has nothing at that height. */
  diffDeg: number | null
}

/** Chord angle per stripe, beside the lidar's twist at the same height. */
export function angleRows(a: SailTrimAnnotation, phase: PhaseStat | null): AngleRow[] {
  const out: AngleRow[] = []
  for (const c of a.chords || []) {
    const height = LIDAR_HEIGHT_BY_TAG[c.tag]
    const kind = LIDAR_SAIL_BY_SAIL[c.sail]
    if (height == null || !kind) continue
    const lidar = phase ? phase.mean[measKey(kind, 'Tw', height)] ?? null : null
    out.push({
      sail: c.sail,
      height,
      photoDeg: c.angleDeg,
      photoSigmaDeg: c.angleSigmaDeg,
      lidarDeg: lidar,
      diffDeg: lidar == null ? null : c.angleDeg - lidar,
    })
  }
  return out.sort((x, y) => x.sail.localeCompare(y.sail) || x.height - y.height)
}

export interface TwistRow {
  sail: 'main' | 'jib'
  fromHeight: number
  toHeight: number
  photoDeg: number
  photoSigmaDeg: number
  lidarDeg: number | null
  diffDeg: number | null
  /** True when the photo number leant on an interpolated sail width. */
  interpolated: boolean
}

/**
 * The check: twist BETWEEN two stripes, both ways of measuring it.
 *
 * Built from the annotation's own twist entries so the photo side is the number
 * the tool published, not one re-derived here — and the lidar side is the plain
 * difference of its two heights, which is the same quantity whatever its zero.
 */
export function twistRows(a: SailTrimAnnotation, phase: PhaseStat | null): TwistRow[] {
  const out: TwistRow[] = []
  for (const t of a.twist || []) {
    const fromHeight = LIDAR_HEIGHT_BY_TAG[t.from]
    const toHeight = LIDAR_HEIGHT_BY_TAG[t.to]
    const kind = LIDAR_SAIL_BY_SAIL[t.sail]
    if (fromHeight == null || toHeight == null || !kind) continue
    const lo = phase ? phase.mean[measKey(kind, 'Tw', fromHeight)] ?? null : null
    const hi = phase ? phase.mean[measKey(kind, 'Tw', toHeight)] ?? null : null
    const lidar = lo == null || hi == null ? null : hi - lo
    out.push({
      sail: t.sail,
      fromHeight,
      toHeight,
      photoDeg: t.twistDeg,
      photoSigmaDeg: t.sigmaDeg,
      lidarDeg: lidar,
      diffDeg: lidar == null ? null : t.twistDeg - lidar,
      interpolated: t.interpolated,
    })
  }
  return out.sort((x, y) => x.sail.localeCompare(y.sail) || x.fromHeight - y.fromHeight)
}

/**
 * Is a disagreement bigger than the two instruments' own uncertainty?
 *
 * The photo carries a sigma; the lidar's phase mean does not, and KND's own
 * spread across a phase is not stored, so 0.8° is used — the figure the 27 Sep
 * lidar twist came with (5.69 ±0.81). It is a stand-in, and saying so matters:
 * "within tolerance" here means "not obviously inconsistent", not "verified".
 */
export const LIDAR_SIGMA_DEG = 0.8

export function agrees(photoSigmaDeg: number, diffDeg: number | null): boolean | null {
  if (diffDeg == null) return null
  return Math.abs(diffDeg) <= 2 * Math.hypot(photoSigmaDeg, LIDAR_SIGMA_DEG)
}


// ── the lidar columns on a photo's geometry card ─────────────────────────────

/**
 * Which lidar channel each card column belongs beside.
 *
 * TWIST → `Tw`, and DEPTH → `Ca`, which is the one worth stating out loud. The
 * card's "Draft" column shows `camberPct`, the sail's DEPTH as a percentage of
 * chord. KND calls that CA. Its `Dr` is something else entirely — WHERE the
 * depth peaks, percent of chord from the luff — and the two differ by roughly a
 * factor of five, so putting Dr beside camberPct would look like a catastrophic
 * disagreement and mean nothing. `draftPct` on the annotation is the one that
 * belongs beside Dr, and it is fitted rather than trusted.
 */
export const LIDAR_CHANNEL = { twist: 'Tw', depth: 'Ca', peak: 'Dr' } as const
export type LidarQuantity = keyof typeof LIDAR_CHANNEL

/** One lidar reading for a sail at a draft stripe, or null if it is not there. */
export function lidarCell(
  phase: PhaseStat | null | undefined,
  sail: string,
  tag: string,
  what: LidarQuantity,
): number | null {
  if (!phase) return null
  const height = LIDAR_HEIGHT_BY_TAG[tag]
  const kind = LIDAR_SAIL_BY_SAIL[sail]
  if (height == null || !kind) return null
  return phase.mean[measKey(kind, LIDAR_CHANNEL[what], height)] ?? null
}

/**
 * Does this phase actually carry lidar?
 *
 * The columns appear only when there is something in them. A boat without a
 * lidar — every rival, and our own boat on a day the mast head unit was off —
 * would otherwise grow a pair of columns full of dashes, which reads as a
 * missing measurement rather than as equipment that was never there.
 */
export function phaseHasLidar(phase: PhaseStat | null | undefined): boolean {
  if (!phase) return false
  return Object.entries(phase.mean).some(([k, v]) => v != null && /^(mn|jib|spi)(Ca|Dr|Tw)\d\d$/.test(k))
}

/**
 * Is the boat in the photograph the boat the lidar is on?
 *
 * Our lidar describes OUR rig. Printing it beside a photograph of Capricorno
 * would be two different boats in one table — the same mistake as scaling her
 * by Northstar's P, which has already happened once.
 */
export function lidarAppliesTo(
  measuredAs: string | null | undefined,
  ownBoat: string | null | undefined,
): boolean {
  const a = (measuredAs || '').trim().toLowerCase()
  const b = (ownBoat || '').trim().toLowerCase()
  return !!a && !!b && a === b
}
