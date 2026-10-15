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
/**
 * A station can also be the CLEW — the bottom of the leech, at fraction 0.
 *
 * Wouter, 26 Sep: "you can use the clew position as the bottom leech point for
 * twist calculations". It is the one station whose fraction needs no convention
 * at all — the clew IS where the leech meets the foot — and its width is already
 * on the certificate as the foot (HLP for the headsail, E for the main). It
 * anchors the bottom of the profile, so a sail marked at 25/50/75 gains a fourth
 * point and the lowest twist figure stops starting a quarter of the way up.
 */
export type TwistTag = HeightTag | 'clew'

export const STATION_FRACTION: Record<TwistTag, number | null> = {
  clew: 0,
  stripe25: 0.25,
  stripe50: 0.50,
  stripe75: 0.75,
  stripe87: 0.875,
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

  // fraction 0 included: the foot is a measured certificate width (E / HLP),
  // not something interpolated towards. It used to be excluded here, which made
  // the clew station report an interpolated width and an inflated sigma.
  const exact = pts.find(([f]) => Math.abs(f - fraction) < 1e-9)
  if (exact) {
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

/**
 * The sag profile of a luff, fitted from however little of it was visible.
 *
 * From astern most of the jib's luff is hidden behind the jib and the main —
 * you get the bottom of the forestay and little else. That would be fatal if
 * the sag had to be measured where it is used, and it does not: the forestay is
 * pinned at BOTH ends, tack and masthead, and both are on the centreplane. So
 * sag is zero at 0 and at 1, and ONE interior measurement determines the rest.
 *
 * The shape barely matters. Taking the same measured point at the 25 % stripe
 * and asking a parabola and a half-sine for the twist between 25 % and 50 %,
 * they differ by 0.1-0.3°; measuring nothing at all costs 1.5°. So the crude
 * pinned parabola is used and the argument for a better one is weak.
 *
 * Least squares over whatever stations were measured, so two visible points are
 * used as two, not one.
 */
export function fitLuffSag(
  measured: { fraction: number; mm: number }[],
): ((fraction: number) => number) | null {
  const shape = (f: number) => 4 * f * (1 - f)
  const pts = measured.filter((m) => m.fraction > 0 && m.fraction < 1 && Number.isFinite(m.mm))
  if (!pts.length) return null
  let num = 0, den = 0
  for (const p of pts) { const w = shape(p.fraction); num += p.mm * w; den += w * w }
  if (!(Math.abs(den) > 1e-9)) return null
  const peak = num / den
  return (f: number) => peak * shape(f)
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
  from: TwistTag
  to: TwistTag
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
  tag: TwistTag
  fraction: number
  leechMm: number
  width: WidthAt
  angle: ChordAngle
  /** How the luff term at this station was arrived at. */
  luffSource?: 'measured' | 'fitted' | 'assumed-zero'
  luffMm?: number | null
}

/**
 * Chord angles at every station a measurement and a width can both be had for.
 *
 * `leechByTag` is keyed the way the measurements are — `jib@stripe50` etc.
 */
export function stationAngles(
  sail: 'main' | 'jib',
  widths: SailWidths,
  leechByTag: { tag: TwistTag; mm: number; sigmaMm: number }[],
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

/**
 * Twist between each adjacent pair of stations, lowest first.
 *
 * `leewardPositive` says whether the angles are already signed leeward-positive,
 * which chordAngle manages only when the TACK was known. Pass it when it is:
 * the plain signed difference is then the twist, and it stays correct when the
 * leech crosses the centreplane — which in light air it does, the clew and the
 * lower stations ending up to windward while the head falls away to leeward.
 *
 * Without a tack the sign is athwartships rather than leeward-positive and means
 * nothing on its own, so the difference is flipped into the frame of whichever
 * station is furthest from the centreplane. That keeps the two tacks reading
 * alike, which is the most that can be said — but it MISREADS a profile that
 * crosses over, because the furthest station can be the windward one. Hence the
 * flag: guessing is for when there is nothing better.
 */
export function twistBetween(angles: StationAngle[], leewardPositive = false): TwistRow[] {
  const sorted = [...angles].sort((a, b) => a.fraction - b.fraction)

  // ── which way round is positive ──────────────────────────────────────────
  //
  // Twist is RELATIVE, between adjacent stripes — the step from one to the next,
  // not a running total from the foot. What the clew is for is the bottom of the
  // chain and the zero the sign is taken from.
  //
  // Positive has to mean "opening as it rises" on either tack. With a tack known
  // the angles are already leeward-positive and the plain difference does it.
  // Without one the sign only says which way round the photograph is, so the
  // profile has to be flipped — and it is flipped by the trend from the DATUM
  // (the clew, or the lowest station marked) to the top.
  //
  // It used to flip by whichever single station was furthest from the
  // centreplane, which breaks in exactly the case this is about: with the boom
  // strapped to WINDWARD in light air, the clew can be the furthest station of
  // the lot, so the frame came off the bottom of the sail instead of the top and
  // every step came out negative on a sail twisting perfectly normally.
  // Bottom-to-top is the trend that defines opening, so that is what sets it.
  const flip = leewardPositive
    ? 1
    : (() => {
      if (sorted.length < 2) return 1
      const trend = sorted[sorted.length - 1].angle.deg - sorted[0].angle.deg
      return Math.sign(trend) || 1
    })()

  const out: TwistRow[] = []
  for (let i = 0; i < sorted.length - 1; i++) {
    const lo = sorted[i], hi = sorted[i + 1]
    out.push({
      sail: lo.sail,
      from: lo.tag, to: hi.tag,
      fromDeg: lo.angle.deg, toDeg: hi.angle.deg,
      // The SIGNED difference. This took magnitudes once, which silently
      // assumed the leech never crosses the centreplane. In light air it does —
      // Wouter, 26 Sep: "the boom ends up to windward of the centre line, as
      // does the 25 % leech point". A station 1.3 deg to WINDWARD under one
      // 2.8 deg to leeward is 4.1 deg of twist; |2.8| - |1.3| calls it 1.5,
      // understating the opening by nearly three degrees in exactly the
      // conditions where twist is what is being trimmed.
      //
      // And NOT through Math.abs. A negative step is a leech CLOSING as it
      // rises — a hooked or over-sheeted section, a real fault — and forcing
      // the sign would report the worst part of the sail as though it were the
      // best. The datum sets the frame; the sign then stays honest.
      twistDeg: flip * (hi.angle.deg - lo.angle.deg),
      sigmaDeg: Math.hypot(lo.angle.sigmaDeg, hi.angle.sigmaDeg),
      interpolated: lo.width.source === 'interpolated' || hi.width.source === 'interpolated',
    })
  }
  return out
}

// ── when is ONE frame enough? ───────────────────────────────────────────────
//
// Wouter, 15 Oct: show twist from a single shot when the picture is taken
// directly from astern (psi = 0 +/- 1 deg), and require three frames minimum
// off the centreline. It makes sense, and it is worth writing down WHY, because
// the reason is a derivative rather than a convention.
//
// A leech point's athwartships offset comes off the picture as
//
//     Y = (du.s + d.sin psi.cos phi) / cos psi
//
// where d is that station's own depth abaft the mast. d is NOT knowable from one
// photograph — it is exactly what `sailtrim-triangulate` solves from several —
// so a single frame has to take it from the rig model, where an unmeasured
// station is a +/-1500-2500 mm guess.
//
//     dY/dd = tan psi . cos phi
//
// At psi = 0 that is ZERO. The depth guess cannot touch the answer however bad
// it is, so one frame is not a compromise there — it is exact, and no number of
// extra frames would improve it. Off the centreline the same guess walks
// straight into Y, scaled by tan psi, and the only cure is to measure d, which
// takes three views (two are refused outright: their residual is zero by
// construction).
//
// The 1 deg bar follows from the arithmetic rather than being chosen. With a
// 2500 mm depth guess on Northstar's main at the 50 % stripe, the depth term is
// worth about 0.35 deg of chord angle at psi = 1, which sits just under the
// 0.3-0.9 deg the rest of the twist pipeline already carries — and about
// 1.8 deg at psi = 5, which is larger than the twist differences anyone is
// trying to read. So 1 deg is roughly where this error stops being the biggest
// one in the measurement.

/**
 * Degrees of chord-angle error a station's DEPTH uncertainty causes, at this ψ.
 *
 * Zero at ψ = 0 by construction, not by convention — see above.
 */
export function depthTwistErrorDeg(args: {
  psiDeg: number
  heelDeg: number | null
  /** 1σ on the station's depth abaft the mast, mm. */
  depthSigmaMm: number
  /** The sail's width at that station, metres. */
  widthM: number
  /** The measured leech offset there, mm. */
  leechMm: number
}): number {
  const { psiDeg, heelDeg, depthSigmaMm, widthM, leechMm } = args
  const g = widthM * 1000
  if (!(g > 0) || !(depthSigmaMm > 0)) return 0
  const root = Math.sqrt(Math.max(g * g - leechMm * leechMm, 1))
  const dYdd = Math.abs(Math.tan(psiDeg * DEG)) * Math.abs(Math.cos((heelDeg ?? 0) * DEG))
  return (dYdd * depthSigmaMm) / root / DEG
}

export interface TwistEligibility {
  ok: boolean
  code: 'no-psi' | 'astern' | 'depths-measured' | 'needs-frames'
  note: string
  /** The worst station's depth-induced error, degrees. Null when unknowable. */
  worstDeg: number | null
}

/** Whether this frame alone can carry a twist number. */
export function twistEligibility(args: {
  psiDeg: number | null
  psiMeasured: boolean
  /** Per station: its depth sigma and where the chord angle came from. */
  stations: { depthSigmaMm: number; widthM: number; leechMm: number }[]
  heelDeg?: number | null
  /** How much depth-induced error is tolerable before three frames are wanted. */
  maxDeg?: number
  /** True when the station depths were solved from a multi-frame set. */
  depthsFromSet?: boolean
}): TwistEligibility {
  const { psiDeg, psiMeasured, stations, heelDeg = null, maxDeg = 0.5, depthsFromSet = false } = args

  // An UNMEASURED ψ has no side — `psiFromHeelShortening` documents itself as
  // indicative only — so it cannot be claimed to be zero either.
  if (psiDeg == null || !psiMeasured) {
    return { ok: false, code: 'no-psi', worstDeg: null,
      note: 'ψ has not been measured off a centreplane baseline, so there is no way to tell whether '
        + 'this frame is square astern. Mark the baseline, or use a three-frame set.' }
  }

  const worstDeg = stations.length
    ? Math.max(...stations.map((st) => depthTwistErrorDeg({ psiDeg, heelDeg, ...st })))
    : 0

  if (Math.abs(psiDeg) <= 1) {
    return { ok: true, code: 'astern', worstDeg,
      note: `square astern (ψ = ${psiDeg.toFixed(2)}°), so the station depths drop out of the geometry `
        + '— one frame is exact here, not a compromise' }
  }
  if (depthsFromSet && worstDeg <= maxDeg) {
    return { ok: true, code: 'depths-measured', worstDeg,
      note: `ψ = ${psiDeg.toFixed(2)}° off the centreplane, but the station depths were solved from a `
        + `set, so the depth term is worth only ${worstDeg.toFixed(2)}°` }
  }
  return { ok: false, code: 'needs-frames', worstDeg,
    note: `ψ = ${psiDeg.toFixed(2)}° off the centreplane. The leech offset then depends on each station's `
      + `depth abaft the mast, which one photograph cannot give — on the guessed depths that is `
      + `${worstDeg.toFixed(2)}° of chord angle, against ${maxDeg.toFixed(2)}° allowed. `
      + 'Measure the depths with a three-frame set (sailtrim-triangulate), or shoot it square astern.' }
}

// ── a STRIPE's twist: the North / Sail Vision definition ────────────────────
//
// A stripe's own twist is its chord angle referenced to THE SAIL'S OWN FOOT —
// the clew-to-tack plane — not to the boat's midline. Zero at the foot, opening
// positive with height. This is what the trade means and what the reports say:
//
//   · North's SailScan lists "TWIST — how the top opens relative to the boom",
//     and their photo guidance insists the centre of the boom is in frame
//     BECAUSE it is needed to compute the twist profile.
//   · Sail Vision's reports (the three formats in sailScanParse) carry pairwise
//     twists accumulated from the FOOT stripe, which is 0 by definition, plus a
//     `Twist (total)`. The boat centreline never appears.
//   · Only VSPARS reports an angle to the boat centreline — and it is not
//     calling that twist; it is the absolute stripe angle, which is a SHEETING
//     angle with twist as its difference.
//
// WHY THE BOAT'S MIDLINE IS THE WRONG DATUM. It is not the sail's datum. Ease
// the traveller three degrees and every centreline-referenced angle moves three
// degrees while the sail's shape is untouched — so a centreline reference mixes
// SHEETING into what you want to read as SHAPE. It bites harder on the jib,
// whose foot is sheeted well off the centreline, than on the main.
//
// WHAT IT COSTS. The foot plane is itself measured, so its error lands on every
// stripe. Baraka's boom mark is ±30 mm and her clew ±108 mm, which on a jib foot
// is about 0.7° added to each absolute figure. That is the price of the right
// definition, and it is why `angleDeg` — the raw angle to the centreline — is
// kept alongside rather than replaced: it carries neither the foot's error nor
// its meaning, and the pairwise twists between stripes carry neither either,
// since a common datum cancels in a difference.

export interface StripeTwist {
  sail: 'main' | 'jib'
  tag: TwistTag
  fraction: number
  /** Degrees open relative to this sail's FOOT chord. 0 at the foot itself. */
  twistDeg: number
  sigmaDeg: number
  /** The station the foot was taken from. */
  datumTag: TwistTag
  /** False when no clew/boom was marked and the lowest stripe stood in. */
  datumIsFoot: boolean
}

/**
 * Each stripe's twist, referenced to the sail's own foot.
 *
 * `leewardPositive` as elsewhere: with a tack known the angles are already in
 * the boat's frame; without one the profile is flipped on the bottom-to-top
 * trend so "opening" is positive on either tack.
 *
 * With no clew/boom marked the lowest stripe becomes the datum and
 * `datumIsFoot` is false — every figure is then understated by however much the
 * sail twists below that stripe, which is not zero, and the caller must say so.
 */
export function stripeTwists(angles: StationAngle[], leewardPositive = false): StripeTwist[] {
  const sorted = [...angles].sort((a, b) => a.fraction - b.fraction)
  if (!sorted.length) return []
  const clew = sorted.find((a) => a.tag === 'clew') ?? null
  const datum = clew ?? sorted[0]
  const flip = leewardPositive
    ? 1
    : (sorted.length < 2 ? 1
      : (Math.sign(sorted[sorted.length - 1].angle.deg - sorted[0].angle.deg) || 1))
  return sorted.map((a) => ({
    sail: a.sail,
    tag: a.tag,
    fraction: a.fraction,
    twistDeg: flip * (a.angle.deg - datum.angle.deg),
    // At the datum itself the twist is 0 BY DEFINITION, so it carries no error.
    // Elsewhere the datum's error is common to every stripe — correlated, not
    // independent — but quoted per stripe it is what a reader of one figure
    // needs.
    sigmaDeg: a === datum ? 0 : Math.hypot(a.angle.sigmaDeg, datum.angle.sigmaDeg),
    datumTag: datum.tag,
    datumIsFoot: !!clew,
  }))
}
