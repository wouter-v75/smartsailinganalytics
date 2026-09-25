// src/lib/sailTrim.ts
// ─────────────────────────────────────────────────────────────────────────────
// SailTrim — the three astern speed-team measurements, done properly.
//
//   mast centreline → jib clew
//   mast centreline → jib leech at spreader 2
//   mast centreline → boom
//
// Today these are drawn by hand in Rhino: scale the photo off something known,
// draw a horizontal line from the mast, read the number. That method has three
// silent errors in it, and this module exists to remove all three. See
// docs/sail-geometry-from-astern-2026-09.md for the full derivation; the short
// version:
//
//  1. MISALIGNMENT (ψ). The camera is never exactly on the boat's centreplane.
//     A point d forward of the mast is displaced in the image by d·sin ψ, which
//     lands straight in the answer: at d = 8 m, ψ = 1° is 140 mm on a 1,900 mm
//     reading. You cannot hold ψ ≤ 0.14° from a RIB at 260 m — but you can
//     MEASURE it from the photograph, ~20× better than you can achieve it, off
//     any two points known to lie on the centreplane (masthead + forestay tack,
//     bow + transom centre…). So we measure it and correct, rather than asking
//     for a perfectly aligned photo.
//
//  2. DEPTH SCALE. The camera is ASTERN, so a point d FORWARD of the mast is
//     d FARTHER away and images SMALLER by R/(R+d). Scale it with the mast's
//     mm-per-pixel and you UNDER-read by d/R — ≈3 % at 260 m, ≈5 % at 140 m.
//     The boom, aft of the mast, over-reads by the same mechanism.
//
//  3. WHICH DIRECTION "ACROSS" MEANS. A horizontal line in the image measures
//     a WORLD-HORIZONTAL distance to a mast that has leaned away; a line
//     perpendicular to the mast measures the BOAT-FRAME athwartships distance.
//     They differ by exactly 1/cos(heel) — 8.6 % at 23° of heel. Measuring the
//     6 Sept compilations says the speed team already means the BOAT-FRAME one
//     (their panels are rotated ~23° to stand the mast up before the line is
//     drawn), but both come out of the same clicks here, so nothing is lost if
//     that turns out to be an accident of making the panels look tidy.
//
// And one free gift: the SEA HORIZON is world-horizontal by definition. Where
// it is visible — almost always — it fixes the camera's roll exactly, and the
// mast's angle to it IS the heel, which the log can then be checked against.
// That check is what catches a rotated panel, a mis-clicked axis or the wrong
// log second, and it agreed to 0.14° on the one frame with a Rhino number.
//
// Everything here is pure: pixels and numbers in, millimetres and sigmas out.
// No React, no DOM, no image decoding.
//
// PROJECTION MODEL. Scaled orthographic (weak perspective) in the transverse
// plane, with an explicit per-target depth correction. Justified: the rig is
// ~40 m across a ~260 m range, so within one transverse plane the pinhole and
// the orthographic projections differ by second-order terms far below the
// click noise. What is NOT second order is the plane-to-plane scale change,
// which is exactly what `depthMm` + `rangeMm` handle.
//
// IMAGE COORDINATES are pixels of the image AS SUPPLIED, x right, y DOWN.
// Everything derives the pixel pitch from the supplied width, so a resized
// image self-corrects — but see `pixelPitchMm`: measure on the ORIGINAL frame,
// never on a re-exported compilation, which has been resampled.
// ─────────────────────────────────────────────────────────────────────────────

export interface Px { x: number; y: number }

// ── small vector helpers ────────────────────────────────────────────────────
const sub = (a: Px, b: Px): Px => ({ x: a.x - b.x, y: a.y - b.y })
const dot = (a: Px, b: Px): number => a.x * b.x + a.y * b.y
const len = (a: Px): number => Math.hypot(a.x, a.y)
const norm = (a: Px): Px => { const l = len(a) || 1; return { x: a.x / l, y: a.y / l } }
const DEG = Math.PI / 180

/** Rotate a unit vector 90° so that an up-the-screen mast yields image-right. */
const perp = (m: Px): Px => ({ x: -m.y, y: m.x })

// ── the mast axis ───────────────────────────────────────────────────────────
// Two or more centreline points. In practice the operator clicks the port and
// starboard EDGE of the mast at two heights; `mastAxisFromEdges` bisects them,
// which is both more precise than eyeballing a centreline and gives the mast's
// apparent width as a scale reference for free.

export interface MastAxis {
  /** Lower centreline point (larger image y). */
  low: Px
  /** Upper centreline point (smaller image y). */
  high: Px
  /** Unit vector UP the mast in image coordinates. */
  up: Px
  /** Unit vector perpendicular to the mast, image-right for an upright mast. */
  across: Px
  /** Apparent lean from image-vertical, degrees, positive toward image right.
   *  This is heel + camera roll — see `cameraRollDeg`. */
  tiltDeg: number
  /** Apparent mast width in px at each clicked height, if edges were given. */
  widthPx: number[]
}

export function mastAxisFromEdges(pairs: { port: Px; stbd: Px }[]): MastAxis | null {
  if (!pairs || pairs.length < 2) return null
  const mids = pairs.map((p) => ({ x: (p.port.x + p.stbd.x) / 2, y: (p.port.y + p.stbd.y) / 2 }))
  const widths = pairs.map((p) => len(sub(p.port, p.stbd)))
  // Sort by image y so `low` is genuinely the lower one on screen.
  const order = mids.map((m, i) => i).sort((a, b) => mids[b].y - mids[a].y)
  const low = mids[order[0]]
  const high = mids[order[order.length - 1]]
  return mastAxisFromPoints(low, high, order.map((i) => widths[i]))
}

export function mastAxisFromPoints(a: Px, b: Px, widthPx: number[] = []): MastAxis | null {
  const low = a.y >= b.y ? a : b
  const high = a.y >= b.y ? b : a
  const v = sub(high, low)
  if (len(v) < 1e-6) return null
  const up = norm(v)
  // atan2(x, -y): image y is DOWN, so -y is up-screen. Positive = leaning right.
  const tiltDeg = Math.atan2(up.x, -up.y) / DEG
  return { low, high, up, across: perp(up), tiltDeg, widthPx }
}

/**
 * Camera roll, recovered for free.
 *
 * Under this projection the mast's apparent lean in the image IS heel + camera
 * roll: rolling the camera rotates the whole scene, heeling the boat rotates
 * only the boat. So with the logged heel in hand the roll falls out, and the
 * world-horizontal direction can be corrected for a camera that was not level —
 * which, on a RIB, it never is.
 *
 * `heelDeg` is taken as a MAGNITUDE; its port/starboard sign convention differs
 * between log exports, so the side is read off the observed mast lean instead.
 * Guard: if the mast barely leans, that sign is not trustworthy and we decline.
 */
export function cameraRollDeg(axis: MastAxis, heelDeg: number | null): number | null {
  if (heelDeg == null || !Number.isFinite(heelDeg)) return null
  const heel = Math.abs(heelDeg)
  if (Math.abs(axis.tiltDeg) < heel / 2) return null // lean too small to sign reliably
  return axis.tiltDeg - Math.sign(axis.tiltDeg) * heel
}

/**
 * The sea horizon — world-horizontal, by definition, and free in almost every
 * one of these frames.
 *
 * `tiltDeg` is the horizon's angle from the image x axis, positive when the
 * line falls to the right (image y is down). It is the same quantity the
 * heel-derived `cameraRollDeg` estimates, but measured rather than inferred,
 * so when it is present it wins: no heel needed, no sign to guess, and the
 * mast's angle to it IS the heel (see `imageHeelDeg`) — which the log can then
 * be checked against.
 */
export interface Horizon {
  tiltDeg: number
  /** Fit quality, in pixels, and how many columns went into it. */
  rms: number
  samples: number
}

/** Unit vector along TRUE world-horizontal in the image. */
export function horizontalDir(
  axis: MastAxis,
  heelDeg: number | null,
  horizon?: Horizon | null,
): { dir: Px; rollApplied: boolean; source: 'horizon' | 'heel' | 'assumed-level' } {
  if (horizon && Number.isFinite(horizon.tiltDeg)) {
    const t = horizon.tiltDeg * DEG
    return { dir: { x: Math.cos(t), y: Math.sin(t) }, rollApplied: true, source: 'horizon' }
  }
  const roll = cameraRollDeg(axis, heelDeg)
  if (roll == null) return { dir: { x: 1, y: 0 }, rollApplied: false, source: 'assumed-level' }
  const t = roll * DEG
  // World-up in the image is at angle `roll` from image-up; its perpendicular
  // is the world horizontal.
  return { dir: { x: Math.cos(t), y: Math.sin(t) }, rollApplied: true, source: 'heel' }
}

/**
 * Heel, read off the photograph: the angle between the mast and the TRUE
 * vertical, which the horizon fixes. Signed the same way as `MastAxis.tiltDeg`
 * — positive means the masthead is to the right of vertical.
 *
 * Measured this way on 5 Sept: 22.56° against a logged 22.7° on the 11:53:00
 * compilation panel, and 22.1° against a logged 22.1° on the 12:46:30
 * original. It is an independent check on the whole projection model, and it
 * is how a rotated image gives itself away.
 */
export function imageHeelDeg(axis: MastAxis, horizon: Horizon | null | undefined): number | null {
  if (!horizon || !Number.isFinite(horizon.tiltDeg)) return null
  return axis.tiltDeg - horizon.tiltDeg
}

/**
 * A crude read on how far the camera sat off the boat's centreplane, from the
 * fact that heel foreshortens: apparent lean = atan(tan(heel)·cos ψ).
 *
 * INDICATIVE ONLY, and the tool says so. Mast rake contributes an apparent
 * lean of about rake·sin ψ, the same order as the signal; heel moves in waves
 * between the logged sample and the shutter; and the inverse cosine is
 * brutally steep near zero, so a tenth of a degree of measurement error is
 * worth several degrees of ψ. It is good for "was this frame roughly lined up
 * or badly off", not for correcting anything. Mark a centreplane baseline for
 * that.
 */
export function psiFromHeelShortening(imageHeel: number, loggedHeelDeg: number): number | null {
  const a = Math.abs(imageHeel), h = Math.abs(loggedHeelDeg)
  if (!(h > 2) || !(a > 0)) return null
  const c = Math.tan(a * DEG) / Math.tan(h * DEG)
  if (!(c > 0)) return null
  return Math.acos(Math.min(1, c)) / DEG
}

// ── scale and range ─────────────────────────────────────────────────────────

/**
 * Millimetres per pixel in the mast's transverse plane, from a reference of
 * known true length.
 *
 * The reference must be a length that lies IN the transverse plane — spreader
 * tip to tip, mast width, a marked band across the rig. It must NOT be a
 * fore-and-aft length (mast chord, boom length): seen from astern those are
 * foreshortened to almost nothing and are useless as a scale.
 *
 * Note it is the reference's LENGTH IN THE IMAGE that matters, not its
 * horizontal component: the boat's athwartships axis lies entirely within the
 * image plane, so heel does not foreshorten it.
 */
export function mmPerPxFromReference(a: Px, b: Px, trueLengthMm: number): number | null {
  const px = len(sub(a, b))
  if (!(px > 1) || !(trueLengthMm > 0)) return null
  return trueLengthMm / px
}

export interface SensorSpec {
  /** Sensor width in mm along the image's long axis. 36 for full frame. */
  widthMm: number
  /** Focal length actually used, mm (EXIF FocalLength). */
  focalLengthMm: number
  /** Width of the image AS SUPPLIED, px — so a resized file still works. */
  imageLongEdgePx: number
}

/** Camera→mast range in mm. Needed only for the depth correction. */
export function rangeMmFrom(sensor: SensorSpec, mmPerPxAtMast: number): number | null {
  const { widthMm, focalLengthMm, imageLongEdgePx } = sensor
  if (!(widthMm > 0) || !(focalLengthMm > 0) || !(imageLongEdgePx > 0)) return null
  const pitchMm = widthMm / imageLongEdgePx
  if (!(pitchMm > 0) || !(mmPerPxAtMast > 0)) return null
  return (mmPerPxAtMast * focalLengthMm) / pitchMm
}

/**
 * Scale at a target's own depth. `depthMm` is FORWARD-positive from the mast
 * plane; the camera is astern, so forward is farther and images smaller.
 * Range unknown ⇒ no correction, and the caller inflates sigma instead.
 */
export function mmPerPxAtDepth(mmPerPxAtMast: number, depthMm: number, rangeMm: number | null): number {
  if (rangeMm == null || !(rangeMm > 0)) return mmPerPxAtMast
  return mmPerPxAtMast * ((rangeMm + depthMm) / rangeMm)
}

// ── misalignment (ψ) ────────────────────────────────────────────────────────

export interface CentreplaneBaseline {
  /** Two points KNOWN to lie on the boat's centreplane (masthead, forestay
   *  tack, gooseneck, transom centre, backstay…). */
  aft: Px
  fwd: Px
  /** Their fore-and-aft separation in mm, from the rig model. Forward point
   *  minus aft point, so always positive. */
  separationMm: number
}

export interface Psi {
  deg: number
  sigmaDeg: number
  measured: boolean
}

/**
 * ψ, the camera's off-centreplane angle, from two centreplane landmarks.
 *
 * Sign convention, chosen so that measurement and correction cannot disagree:
 * a point at fore-aft depth d with zero athwartships offset is displaced in
 * image-x (measured along `across`) by −d·sin ψ. Everything downstream uses
 * the same `across` axis and the same forward-positive depth, so the sign
 * bookkeeping takes care of itself.
 */
export function solvePsi(
  base: CentreplaneBaseline | null,
  across: Px,
  mmPerPxAtMast: number,
  heelDeg: number | null,
  opts: { clickSigmaPx?: number; assumedSigmaDeg?: number } = {},
): Psi {
  const assumed = opts.assumedSigmaDeg ?? 1.0
  if (!base || !(base.separationMm > 0)) {
    // Not measured. ψ = 0 is the best guess and ALSO what Rhino implicitly
    // assumes — but now it carries an honest ±1°, which is the whole point.
    return { deg: 0, sigmaDeg: assumed, measured: false }
  }
  // Measured PERPENDICULAR TO THE MAST, which is what cancels the other reason
  // a centreplane point sits off the mast line: heel. A point z above the deck
  // on the centreplane is displaced sideways by z·sin(heel) in the image, and
  // that term is far bigger than the ψ signal — but it is displaced ALONG the
  // mast's own lean, so measuring across the mast removes it exactly.
  //
  // The price is a cos(heel): ψ displaces the camera HORIZONTALLY, and the
  // across-the-mast axis is tilted out of horizontal by the heel.
  const duMm = (dot(sub(base.fwd, base.aft), across) * mmPerPxAtMast) / cosHeel(heelDeg)
  const s = Math.max(-1, Math.min(1, -duMm / base.separationMm))
  const deg = Math.asin(s) / DEG
  // Two clicks, each ±clickSigma, over the baseline.
  const clickPx = opts.clickSigmaPx ?? 1.5
  const sigmaDeg = ((Math.SQRT2 * clickPx * mmPerPxAtMast) / base.separationMm) / DEG
  return { deg, sigmaDeg, measured: true }
}

/** cos(heel), or 1 with a shrug when heel is not known. */
const cosHeel = (heelDeg: number | null): number =>
  heelDeg == null || !Number.isFinite(heelDeg) ? 1 : Math.cos(heelDeg * DEG)

// ── the measurement ─────────────────────────────────────────────────────────

export interface Calibration {
  axis: MastAxis
  mmPerPxAtMast: number
  /** Relative 1σ on the scale itself (reference click noise + how well the
   *  true length is known). 0.002 = 0.2 %. */
  scaleRelSigma: number
  rangeMm: number | null
  psi: Psi
  /** Heel as LOGGED, if we have the row. Used for the cos(heel) in the ψ
   *  correction and as the cross-check against what the image says. */
  heelDeg: number | null
  heelSigmaDeg: number
  clickSigmaPx: number
  /** The sea horizon, when it could be found. Authoritative for
   *  world-horizontal; makes `heelDeg` a check rather than an input. */
  horizon?: Horizon | null
}

/** Heel to use for the geometry: what the image says, else what the log says. */
export function effectiveHeelDeg(cal: Calibration): number | null {
  const fromImage = imageHeelDeg(cal.axis, cal.horizon)
  if (fromImage != null) return fromImage
  return cal.heelDeg
}

export interface TargetInput {
  key: string
  label: string
  point: Px
  /** Fore-and-aft offset from the mast plane, mm, FORWARD positive. Jib clew
   *  and leech are positive; the boom is negative. From the rig model when we
   *  have it; operator estimate until then. */
  depthMm: number
  depthSigmaMm: number
}

export interface Measurement {
  key: string
  label: string
  /** Boat-frame athwartships distance from the mast axis, mm. Measured
   *  perpendicular to the mast, which under this projection IS the boat's
   *  transverse axis at full length — no heel term needed. */
  boatFrameMm: number
  boatFrameSigmaMm: number
  /** World-horizontal distance from the mast axis, mm — the Rhino-equivalent
   *  number, corrected for camera roll when heel is known. */
  worldHorizontalMm: number
  worldHorizontalSigmaMm: number
  /** What the naive method gives: image-horizontal, mast-plane scale, ψ = 0.
   *  Kept so every measurement can be compared with the Rhino history. */
  naiveMm: number
  /** Diagnostics. */
  mmPerPxUsed: number
  depthScaleApplied: boolean
  rollApplied: boolean
}

/**
 * The core. Offsets are taken from the MAST AXIS, not from a single clicked
 * mast point, so the reference is a fitted line rather than one noisy click.
 *
 * Boat frame: the component of (target − axis) along `across`. Because the
 * boat's y axis lies wholly in the image plane, that component is the
 * athwartships distance directly.
 *
 * World horizontal: the same offset taken along the true-horizontal direction,
 * measured to the point where that horizontal line crosses the mast axis.
 */
export function measureTarget(cal: Calibration, t: TargetInput): Measurement {
  const { axis, psi } = cal
  const psiRad = psi.deg * DEG
  const mmPerPx = mmPerPxAtDepth(cal.mmPerPxAtMast, t.depthMm, cal.rangeMm)
  const depthScaleApplied = cal.rangeMm != null

  // Y = (Δu + d·sin ψ) / cos ψ — see solvePsi for the sign convention. The ψ
  // displacement is horizontal, so in the across-the-mast frame it arrives
  // foreshortened by cos(heel); measured along the true horizontal it does not.
  const deMisalign = (duMm: number, foreshorten: number) =>
    (duMm + t.depthMm * Math.sin(psiRad) * foreshorten) / Math.cos(psiRad)

  // ── boat frame ────────────────────────────────────────────────────────────
  // The offset perpendicular to the mast IS the athwartships distance: the
  // boat's transverse axis lies wholly in the image plane, so heel neither
  // stretches nor shortens it.
  const heel = effectiveHeelDeg(cal)
  const acrossPx = dot(sub(t.point, axis.low), axis.across)
  const boatFrameMm = deMisalign(acrossPx * mmPerPx, cosHeel(heel))

  // ── world horizontal ──────────────────────────────────────────────────────
  const { dir: hDir, rollApplied } = horizontalDir(axis, cal.heelDeg, cal.horizon)
  const foot = intersectLineWithAxis(t.point, hDir, axis)
  const horizPx = foot ? dot(sub(t.point, foot), hDir) : acrossPx
  const worldHorizontalMm = deMisalign(horizPx * mmPerPx, 1)

  // ── what Rhino would have said ────────────────────────────────────────────
  const naiveFoot = intersectLineWithAxis(t.point, { x: 1, y: 0 }, axis)
  const naiveMm = (naiveFoot ? t.point.x - naiveFoot.x : acrossPx) * cal.mmPerPxAtMast

  const sigma = (valueMm: number) => {
    const terms: number[] = []
    // click noise: target + the axis fit (the axis is better than one click,
    // so √2 rather than 2 is conservative-but-not-silly)
    terms.push(Math.SQRT2 * cal.clickSigmaPx * mmPerPx)
    // misalignment: ∂Y/∂ψ ≈ d (the dominant term whenever ψ is not measured)
    terms.push(Math.abs(t.depthMm) * psi.sigmaDeg * DEG)
    // depth, entering through both sin ψ and the scale
    const perDepth = Math.abs(Math.sin(psiRad)) +
      (cal.rangeMm ? Math.abs(valueMm) / (cal.rangeMm + t.depthMm) : 0)
    terms.push(t.depthSigmaMm * perDepth)
    // scale
    terms.push(Math.abs(valueMm) * cal.scaleRelSigma)
    // range unknown ⇒ the depth correction is simply missing. Charge for it:
    // the correction is d/R, and R is anywhere from ~80 m to ~400 m.
    if (!depthScaleApplied && t.depthMm !== 0) {
      terms.push(Math.abs((valueMm * t.depthMm) / 160_000) / Math.SQRT2)
    }
    return Math.hypot(...terms)
  }

  const boatFrameSigmaMm = sigma(boatFrameMm)
  // The world-horizontal number inherits everything above plus, when the roll
  // correction could not be applied, an unknown camera roll. d(1/cos)/dρ at a
  // 23° lean is ≈0.46 per radian, so a ±2° unknown roll is ≈1.6 %.
  const extra = rollApplied ? 0 : Math.abs(worldHorizontalMm) * 0.016
  const worldHorizontalSigmaMm = Math.hypot(sigma(worldHorizontalMm), extra)

  return {
    key: t.key,
    label: t.label,
    boatFrameMm,
    boatFrameSigmaMm,
    worldHorizontalMm,
    worldHorizontalSigmaMm,
    naiveMm,
    mmPerPxUsed: mmPerPx,
    depthScaleApplied,
    rollApplied,
  }
}

/** Where a line through `p` in direction `dir` crosses the mast axis. */
export function intersectLineWithAxis(p: Px, dir: Px, axis: MastAxis): Px | null {
  // axis.low + s·axis.up = p + t·dir
  const d = dir.x * axis.up.y - dir.y * axis.up.x
  if (Math.abs(d) < 1e-9) return null // parallel
  const w = sub(axis.low, p)
  const t = (w.x * axis.up.y - w.y * axis.up.x) / d
  return { x: p.x + t * dir.x, y: p.y + t * dir.y }
}

/**
 * The jib leech is a curve, not a point, so the "leech at spreader 2" target
 * is an INTERSECTION — and which line you intersect it with is precisely the
 * §4.4 definition question. Digitise the leech as a short polyline through the
 * spreader-2 region and this returns both candidate points from the same
 * clicks, so the decision can be made after the fact.
 */
export function leechTargets(
  leech: Px[],
  axis: MastAxis,
  spreaderOnMast: Px,
  heelDeg: number | null,
  horizon?: Horizon | null,
): { boatFrame: Px | null; worldHorizontal: Px | null } {
  const { dir: hDir } = horizontalDir(axis, heelDeg, horizon)
  return {
    // perpendicular to the mast through the spreader-2 root = the boat's
    // transverse plane at that height
    boatFrame: intersectPolyline(leech, spreaderOnMast, axis.across),
    // horizontal through the same point = what the red line in the
    // compilations draws
    worldHorizontal: intersectPolyline(leech, spreaderOnMast, hDir),
  }
}

/** First crossing of the polyline by the infinite line through `p` along `dir`. */
export function intersectPolyline(poly: Px[], p: Px, dir: Px): Px | null {
  if (!poly || poly.length < 2) return null
  const n = perp(dir)
  const side = (q: Px) => dot(sub(q, p), n)
  for (let i = 0; i < poly.length - 1; i++) {
    const s0 = side(poly[i])
    const s1 = side(poly[i + 1])
    if (s0 === 0) return poly[i]
    if ((s0 < 0) !== (s1 < 0)) {
      const f = s0 / (s0 - s1)
      return { x: poly[i].x + f * (poly[i + 1].x - poly[i].x), y: poly[i].y + f * (poly[i + 1].y - poly[i].y) }
    }
  }
  return null
}

// ── sanity checks the operator should see ───────────────────────────────────

export interface Check { key: string; label: string; ok: boolean; detail: string }

/**
 * Cheap checks that catch the ways this goes wrong in practice. None of them
 * block a measurement; they are there so a bad frame is obvious rather than
 * quietly producing a confident wrong number.
 */
export function runChecks(cal: Calibration): Check[] {
  const out: Check[] = []
  const { source } = horizontalDir(cal.axis, cal.heelDeg, cal.horizon)
  const roll = cal.horizon ? cal.horizon.tiltDeg : cameraRollDeg(cal.axis, cal.heelDeg)
  const imgHeel = imageHeelDeg(cal.axis, cal.horizon)

  out.push({
    key: 'psi',
    label: 'Misalignment measured',
    ok: cal.psi.measured,
    detail: cal.psi.measured
      ? `ψ = ${cal.psi.deg.toFixed(2)}° ± ${cal.psi.sigmaDeg.toFixed(2)}°`
      : 'no centreplane baseline marked — ψ assumed 0 ± 1°, and a degree of ψ is ±17 mm for every metre a target sits from the mast',
  })

  out.push({
    key: 'range',
    label: 'Depth scale',
    ok: cal.rangeMm != null,
    detail: cal.rangeMm != null
      ? `range ≈ ${(cal.rangeMm / 1000).toFixed(0)} m; a target 8 m forward is scaled by ${(1 + 8000 / cal.rangeMm).toFixed(3)}`
      : 'focal length unknown — no depth correction, expect a few % under-read forward of the mast',
  })

  out.push({
    key: 'horizon',
    label: 'World-horizontal from',
    ok: source === 'horizon',
    detail: source === 'horizon'
      ? `the sea horizon, at ${cal.horizon!.tiltDeg.toFixed(2)}° (${cal.horizon!.samples} columns, rms ${cal.horizon!.rms.toFixed(1)} px)`
      : source === 'heel'
        ? `the logged heel — no horizon found, so the camera's roll of ${roll!.toFixed(1)}° is inferred, not measured`
        : 'nothing — no horizon and no heel, so the camera is assumed level. It never is.',
  })

  // The image says what the heel was; the log says what the heel was. They
  // should agree, and when they do not the frame is usually not what it looks
  // like — a rotated compilation panel, the wrong log row, or an axis clicked
  // down a sail edge instead of the mast.
  if (imgHeel != null && cal.heelDeg != null) {
    const gap = Math.abs(Math.abs(imgHeel) - Math.abs(cal.heelDeg))
    out.push({
      key: 'heel-agree',
      label: 'Heel: photo vs log',
      ok: gap <= 2,
      detail: `${Math.abs(imgHeel).toFixed(2)}° off true vertical in the photo against ${Math.abs(cal.heelDeg).toFixed(1)}° logged — ${gap.toFixed(2)}° apart`
        + (gap > 2 ? '. Either the image has been rotated (a speed-team compilation panel has), the log row is the wrong second, or the mast axis is on a sail edge.' : ''),
    })
    const psiHint = psiFromHeelShortening(imgHeel, cal.heelDeg)
    if (psiHint != null && gap <= 2) {
      out.push({
        key: 'psi-hint',
        label: 'Rough alignment',
        ok: true,
        detail: `heel foreshortening puts the camera about ${psiHint.toFixed(0)}° off the centreplane — indicative only (mast rake and wave-to-wave heel both move this), so mark a baseline if you want ψ corrected`,
      })
    }
  }

  // A mast standing upright in the frame while the log says the boat was well
  // heeled means the picture has been turned. That is what a speed-team
  // compilation panel is, and it is invisible once done — the mast looks
  // right, the dimension line looks horizontal, and "horizontal" now means
  // something else entirely.
  if (cal.heelDeg != null && Math.abs(cal.heelDeg) > 8 && Math.abs(cal.axis.tiltDeg) < Math.abs(cal.heelDeg) / 2) {
    out.push({
      key: 'rotated',
      label: 'This image looks rotated',
      ok: false,
      detail: `the mast stands ${Math.abs(cal.axis.tiltDeg).toFixed(1)}° off the frame's vertical but the boat was heeled ${Math.abs(cal.heelDeg).toFixed(1)}°. A speed-team compilation panel has been turned to stand the mast up (and upscaled ~2.3×). Use the original camera file.`,
    })
  }

  if (roll != null && Math.abs(roll) > 10) {
    out.push({
      key: 'roll-big',
      label: 'Roll looks wrong',
      ok: false,
      detail: `${roll.toFixed(1)}° is a lot of camera roll. If this is a speed-team compilation it is not roll at all — the panel was rotated to stand the mast up, and it has been upscaled too. Use the original frame.`,
    })
  }

  out.push({
    key: 'psi-big',
    label: 'ψ within correctable range',
    ok: !cal.psi.measured || Math.abs(cal.psi.deg) <= 3,
    detail: Math.abs(cal.psi.deg) <= 3
      ? 'small enough that the correction is a correction'
      : `ψ = ${cal.psi.deg.toFixed(1)}° — far off the centreplane; treat the result as indicative`,
  })

  return out
}

// ── export ──────────────────────────────────────────────────────────────────

export interface SailTrimResult {
  photo: string
  capturedAt: string | null
  boat: string
  measurements: Measurement[]
  calibration: {
    mmPerPxAtMast: number
    rangeMm: number | null
    psiDeg: number
    psiSigmaDeg: number
    psiMeasured: boolean
    heelDeg: number | null
    imageHeelDeg: number | null
    mastTiltDeg: number
    cameraRollDeg: number | null
    horizonTiltDeg: number | null
    horizonRmsPx: number | null
    horizontalFrom: 'horizon' | 'heel' | 'assumed-level'
  }
  checks: Check[]
  /** Everything the operator clicked, so a measurement can be reopened, and so
   *  these become the training labels for stage 2. */
  marks: unknown
  algorithmVersion: string
}

export const SAILTRIM_VERSION = 'sailtrim-v0.2-horizon'

export function toCsv(r: SailTrimResult): string {
  const head = [
    'photo', 'captured_at', 'boat', 'target',
    'boat_frame_mm', 'boat_frame_sigma_mm',
    'world_horizontal_mm', 'world_horizontal_sigma_mm',
    'naive_mm', 'depth_mm', 'psi_deg', 'psi_measured', 'range_m', 'heel_deg',
  ].join(',')
  const rows = r.measurements.map((m) => [
    JSON.stringify(r.photo), r.capturedAt ?? '', JSON.stringify(r.boat), m.key,
    m.boatFrameMm.toFixed(1), m.boatFrameSigmaMm.toFixed(1),
    m.worldHorizontalMm.toFixed(1), m.worldHorizontalSigmaMm.toFixed(1),
    m.naiveMm.toFixed(1), '', r.calibration.psiDeg.toFixed(3),
    r.calibration.psiMeasured ? '1' : '0',
    r.calibration.rangeMm != null ? (r.calibration.rangeMm / 1000).toFixed(1) : '',
    r.calibration.heelDeg ?? '',
  ].join(','))
  return [head, ...rows].join('\n')
}
