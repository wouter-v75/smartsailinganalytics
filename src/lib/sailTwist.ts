// src/lib/sailTwist.ts
// ─────────────────────────────────────────────────────────────────────────────
// Twist, from a leech offset and a sail width.
//
// The photograph gives ONE number per stripe: how far the leech sits from the
// boat's centreplane. That is a position, not a shape. What makes it a shape is
// the WIDTH of the sail at that height — the straight line from luff to leech,
// which is on the certificate as MHW/MTW/MUW and HHW/HTW/HUW.
//
//     chord angle = asin( leech offset ÷ width )
//     twist       = chord angle aloft − chord angle below
//
// Why the athwartships offset IS the athwartships component of the width: both
// sails' luffs lie in the centreplane — the main's on the mast, the jib's on the
// forestay — so the luff end of the width contributes nothing sideways whatever
// height it is at. Only the leech end does, and that is what was measured.
//
// TWO ASSUMPTIONS, both worth knowing:
//
//  1. The width is measured from the leech point to the NEAREST point on the
//     luff, which is roughly perpendicular to the luff rather than horizontal.
//     With a raked mast the two differ by a few degrees of rake, and the error
//     is second-order in that angle. Ignored here, and small.
//
//  2. Widths exist at 1/2, 3/4 and 7/8 only. The 50 % and 75 % stripes land on
//     MHW and MTW exactly. The 25 % stripe has NO certificate width and has to
//     be interpolated from the foot — see `widthAt`, which returns how it got
//     the number so nothing downstream has to guess.
//
// Twist is kinder than absolute position: it is a DIFFERENCE, so an error common
// to both stripes — a scale error, a steady ψ bias — stays relative. Three per
// cent of a ten-degree twist is 0.3°, not three.
// ─────────────────────────────────────────────────────────────────────────────

import type { HeightTag } from './rigModel'

const DEG = Math.PI / 180

/**
 * Where a tagged height sits, as a fraction of the hoist.
 *
 * The stripe tags carry their own answer — that is what "50 % stripe" means. The
 * spreaders do not: where spreader 2 is depends on the rig, and until somebody
 * measures it there is no honest fraction to give, so twist is not offered at a
 * spreader rather than invented for one.
 */
export const STATION_FRACTION: Record<HeightTag, number | null> = {
  stripe25: 0.25,
  stripe50: 0.50,
  stripe75: 0.75,
  spr1: null,
  spr2: null,
  spr3: null,
}

/** Luff-to-leech widths for one sail, metres, as the certificate gives them. */
export interface SailWidths {
  /** The foot — E for the main, HLP for the headsail. The width at fraction 0. */
  foot: number | null
  /** At 1/2 the hoist: MHW / HHW. */
  half: number | null
  /** At 3/4: MTW / HTW. */
  threeQuarter: number | null
  /** At 7/8: MUW / HUW. */
  upper: number | null
}

export interface WidthAt {
  /** Metres. */
  m: number
  /** 1σ, metres. */
  sigmaM: number
  /** `certificate` when a station was hit exactly; `interpolated` otherwise. */
  source: 'certificate' | 'interpolated'
  note: string
}

/**
 * The sail's width at a fraction of the hoist.
 *
 * Exact at 1/2, 3/4 and 7/8. Between stations it interpolates linearly, and
 * says so — the 25 % stripe is always in that case.
 *
 * How wrong is the interpolation? Fitting a quadratic through the three upper
 * stations and asking it for the FOOT, where the answer is known, is the test.
 * On Northstar the JIB comes back 0.7 % out; the MAIN comes back 10 % out,
 * because a mainsail's planform bends hard near the foot and a fit from above
 * cannot see it. So the 25 % station gets a sigma that admits it: half the gap
 * between the linear and quadratic readings, which on the main is ~0.1 m.
 */
export function widthAt(w: SailWidths, fraction: number): WidthAt | null {
  const pts: [number, number][] = []
  if (w.foot != null) pts.push([0, w.foot])
  if (w.half != null) pts.push([0.5, w.half])
  if (w.threeQuarter != null) pts.push([0.75, w.threeQuarter])
  if (w.upper != null) pts.push([0.875, w.upper])
  if (pts.length < 2) return null

  const exact = pts.find(([f]) => Math.abs(f - fraction) < 1e-9)
  if (exact && fraction > 0) {
    return {
      m: exact[1],
      // A measurer's width, clicked off a certificate. 20 mm is generous.
      sigmaM: 0.02,
      source: 'certificate',
      note: `measured at ${(fraction * 100).toFixed(0)} % of hoist`,
    }
  }

  // Bracket it. Outside the measured range there is nothing honest to say.
  if (fraction < pts[0][0] || fraction > pts[pts.length - 1][0]) return null
  let lo = pts[0], hi = pts[pts.length - 1]
  for (let i = 0; i < pts.length - 1; i++) {
    if (fraction >= pts[i][0] && fraction <= pts[i + 1][0]) { lo = pts[i]; hi = pts[i + 1] }
  }
  const t = (fraction - lo[0]) / (hi[0] - lo[0])
  const linear = lo[1] + t * (hi[1] - lo[1])

  // How much does the curvature matter here? Compare against a quadratic
  // through the three upper stations where there are three to use.
  let sigmaM = 0.05
  if (w.half != null && w.threeQuarter != null && w.upper != null) {
    const q = quadratic([[0.5, w.half], [0.75, w.threeQuarter], [0.875, w.upper]], fraction)
    sigmaM = Math.max(0.05, Math.abs(q - linear) / 2)
  }
  return {
    m: linear,
    sigmaM,
    source: 'interpolated',
    note: `interpolated between ${(lo[0] * 100).toFixed(0)} % and ${(hi[0] * 100).toFixed(0)} % of hoist`,
  }
}

function quadratic(p: [number, number][], x: number): number {
  const [[x0, y0], [x1, y1], [x2, y2]] = p
  const L = (a: number, b: number, c: number) => ((x - b) * (x - c)) / ((a - b) * (a - c))
  return y0 * L(x0, x1, x2) + y1 * L(x1, x0, x2) + y2 * L(x2, x0, x1)
}

export interface ChordAngle {
  deg: number
  sigmaDeg: number
}

/**
 * The chord's angle to the centreplane, from a leech offset and a width.
 *
 * Sign follows the offset: leeward-positive when the tack was known, so a main
 * strapped above the centreline comes out negative here too.
 */
export function chordAngle(
  leechMm: number, leechSigmaMm: number, width: WidthAt,
): ChordAngle | null {
  const g = width.m * 1000
  if (!(g > 0)) return null
  const r = leechMm / g
  // A leech further out than the sail is wide is not a measurement, it is a
  // mismarked point or the wrong sail's edge.
  if (Math.abs(r) >= 1) return null
  const deg = Math.asin(r) / DEG
  // d(asin)/dy = 1/sqrt(g²−y²);  d(asin)/dg = −y/(g·sqrt(g²−y²))
  const root = Math.sqrt(g * g - leechMm * leechMm)
  const dAdy = 1 / root
  const dAdg = -leechMm / (g * root)
  const sigmaDeg = Math.hypot(dAdy * leechSigmaMm, dAdg * width.sigmaM * 1000) / DEG
  return { deg, sigmaDeg }
}

export interface TwistRow {
  sail: 'main' | 'jib'
  /** The two stations, lower first. */
  from: HeightTag
  to: HeightTag
  fromDeg: number
  toDeg: number
  /** Positive = the sail opens (falls away to leeward) as it rises. */
  twistDeg: number
  sigmaDeg: number
  /** True when either station's width had to be interpolated. */
  interpolated: boolean
}

export interface StationAngle {
  sail: 'main' | 'jib'
  tag: HeightTag
  fraction: number
  leechMm: number
  width: WidthAt
  angle: ChordAngle
}

/**
 * Chord angles at every station a measurement and a width can both be had for.
 *
 * `leechByTag` is keyed the way the measurements are — `jib@stripe50` etc.
 */
export function stationAngles(
  sail: 'main' | 'jib',
  widths: SailWidths,
  leechByTag: { tag: HeightTag; mm: number; sigmaMm: number }[],
): StationAngle[] {
  const out: StationAngle[] = []
  for (const l of leechByTag) {
    const fraction = STATION_FRACTION[l.tag]
    if (fraction == null) continue          // a spreader: no honest fraction
    const width = widthAt(widths, fraction)
    if (!width) continue
    const angle = chordAngle(l.mm, l.sigmaMm, width)
    if (!angle) continue
    out.push({ sail, tag: l.tag, fraction, leechMm: l.mm, width, angle })
  }
  return out.sort((a, b) => a.fraction - b.fraction)
}

/** Twist between each adjacent pair of stations, lowest first. */
export function twistBetween(angles: StationAngle[]): TwistRow[] {
  const out: TwistRow[] = []
  for (let i = 0; i < angles.length - 1; i++) {
    const lo = angles[i], hi = angles[i + 1]
    out.push({
      sail: lo.sail,
      from: lo.tag, to: hi.tag,
      fromDeg: lo.angle.deg, toDeg: hi.angle.deg,
      // Opening to leeward with height is positive, whichever tack: the
      // measurements are already leeward-positive, so the magnitude growing
      // means the sail is falling away.
      twistDeg: Math.abs(hi.angle.deg) - Math.abs(lo.angle.deg),
      sigmaDeg: Math.hypot(lo.angle.sigmaDeg, hi.angle.sigmaDeg),
      interpolated: lo.width.source === 'interpolated' || hi.width.source === 'interpolated',
    })
  }
  return out
}
