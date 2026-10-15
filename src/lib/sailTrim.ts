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

/** Either source of a lens: EXIF read off the file, or the row's recorded copy. */
export interface LensFacts {
  camera?: string | null
  lensModel?: string | null
  focalMm?: number | null
  focal35Mm?: number | null
}

export interface ResolvedLens {
  mm: number | null
  from: '35mm-equivalent' | 'actual' | 'none'
  suspect: boolean
  /** Which SOURCE it came from, which is not the same question as `from`. */
  source: 'file' | 'recorded' | 'none'
  camera: string | null
  lensModel: string | null
}

/**
 * The lens for a frame, from the file's own EXIF if it has any and the photo
 * row's recorded copy if it does not.
 *
 * WHY THERE ARE TWO SOURCES. The file SailTrim is handed is usually not the file
 * the camera wrote: a cloud copy is a re-export with the EXIF stripped. A focal
 * length is what turns a scale into a RANGE, and without a range no depth
 * correction is applied to anything — not applied badly, skipped — while the
 * frame still produces millimetres that sit beside corrected ones with nothing
 * to distinguish them. Five of Northstar 76's six measured frames on 5 Sept were
 * measured exactly that way.
 *
 * THE FILE WINS when it carries a focal length, because it is the picture in
 * front of you and the recorded copy was matched to the row by capture time —
 * which is only as good as the second it was taken in. A 17 fps burst can hold
 * a zoom: six originals stamped 12:46:37 on 5 Sept span 114 to 118 mm.
 *
 * `source` is reported separately from `from` so the operator can be told which
 * one was used. They answer different questions: `from` is which EXIF field
 * (actual against 35 mm equivalent), `source` is which copy of the EXIF.
 */
export function resolveLens(
  file: LensFacts | null | undefined,
  recorded: LensFacts | null | undefined,
  sensorWidthMm: number,
): ResolvedLens {
  const has = (l: LensFacts | null | undefined) =>
    !!l && ((Number.isFinite(l.focalMm) && (l.focalMm as number) > 0)
      || (Number.isFinite(l.focal35Mm) && (l.focal35Mm as number) > 0))
  const source: 'file' | 'recorded' | 'none' = has(file) ? 'file' : has(recorded) ? 'recorded' : 'none'
  const lens = source === 'file' ? file! : source === 'recorded' ? recorded! : null
  const pick = focalForSensor({
    focalMm: lens?.focalMm, focal35Mm: lens?.focal35Mm, sensorWidthMm,
  })
  // Camera and lens NAMES fall back independently of the focal length: a
  // re-export can keep the model and lose the rest, and a name with no focal
  // length is still worth showing.
  return {
    ...pick,
    source,
    camera: file?.camera ?? recorded?.camera ?? null,
    lensModel: file?.lensModel ?? recorded?.lensModel ?? null,
  }
}

/**
 * Which focal length goes with the sensor width the rig model is carrying.
 *
 * `range` is proportional to focal ÷ sensorWidth, so the two are a PAIR and
 * mixing them is not a small error. EXIF offers both halves of two different
 * pairs and they look alike:
 *
 *   FocalLength            the glass's actual length, which belongs with the
 *                          camera's actual sensor width;
 *   FocalLengthIn35mmFormat the same view expressed on a 36 mm sensor.
 *
 * `sensorWidthMm` defaults to 36, so the 35 mm equivalent is the half that
 * matches. On a full-frame body the two are equal and nothing turns on it —
 * which is why this went unnoticed: the Canon R6m2 is full frame.
 *
 * On a phone they are wildly different, and the equivalent is the ONLY one that
 * works, for two reasons. An iPhone 13's wide lens is 5.1 mm against a sensor
 * about 7 mm across, so 5.1 with 36 understates the range by a factor of ~18.
 * And the equivalent also absorbs DIGITAL ZOOM: three frames off the same 5.1 mm
 * lens on 10 Oct reported 46, 55 and 93 mm equivalent, because the camera had
 * cropped. The actual focal length cannot express that at all — it is 5.1 for
 * every one of them.
 */
export function focalForSensor(
  { focalMm, focal35Mm, sensorWidthMm }: { focalMm?: number | null; focal35Mm?: number | null; sensorWidthMm: number },
): { mm: number | null; from: '35mm-equivalent' | 'actual' | 'none'; suspect: boolean } {
  const fullFrame = Math.abs(sensorWidthMm - 36) < 1
  const f35 = Number.isFinite(focal35Mm) && (focal35Mm as number) > 0 ? (focal35Mm as number) : null
  const f = Number.isFinite(focalMm) && (focalMm as number) > 0 ? (focalMm as number) : null

  if (fullFrame && f35) return { mm: f35, from: '35mm-equivalent', suspect: false }
  if (!fullFrame && f) return { mm: f, from: 'actual', suspect: false }
  if (f) {
    // Only the actual, against a 36 mm sensor. Fine for a full-frame body, where
    // the two agree. Anything under ~15 mm is not a full-frame lens anyone points
    // at a boat a hundred metres away — it is a phone or a compact whose
    // equivalent is missing, and the range will come out far too short.
    return { mm: f, from: 'actual', suspect: fullFrame && f < 15 }
  }
  return { mm: f35 ?? null, from: f35 ? '35mm-equivalent' : 'none', suspect: false }
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
 * Refer a scale measured on something that is NOT in the mast plane back TO the
 * mast plane.
 *
 * Every reference used until now sat at the mast — spreaders, mast width, P up
 * the mast itself — so "mm per pixel at the reference" and "mm per pixel at the
 * mast" were the same number and the distinction never came up. The steering
 * wheels are not: they are ten metres or so abaft the mast, which is nearer the
 * camera, so they image LARGER and give fewer mm per pixel. Take that as the
 * mast's scale and every measurement on the frame reads low by depth/range —
 * about 4 % at 260 m, which is several times the error the rest of this file
 * works to remove.
 *
 * The camera model closes it without iterating: the range that comes back from
 * a scale is the range to whatever was measured, and the reference's own depth
 * is the difference between that and the mast.
 *
 * @param mmPerPxAtRef  scale where the reference actually is.
 * @param refDepthMm    the reference's offset from the mast, FORWARD positive.
 * @param sensor        camera, for the range. Without a focal length there is
 *                      no range, and no correction is possible.
 */
/**
 * How much a WRONG focal length costs, as a fraction of every measurement per
 * fraction of focal-length error.
 *
 * It matters because a zoom cannot be recovered from a stripped frame: a
 * RF100-500 could have been anywhere across a 5:1 range, and picking 254 mm
 * when it was 400 moves every millimetre by 3.3 % at 120 m — more than the
 * wheel-depth correction that this rig model was just rebuilt for.
 *
 * And it is ZERO when the scale reference sits in the mast plane. Focal length
 * enters only through the range, and the range only through the depth
 * correction (R − d)/R: with d = 0 that is 1 whatever the range, so a frame
 * scaled off P does not care what lens took it. Worth saying out loud, because
 * it turns "I cannot remember the zoom setting" from a dead end into a reason
 * to pick a different reference.
 *
 * Derivation: k = 1 − d/R and R ∝ f, so dk/k = (d/R)/(1 − d/R) · df/f.
 *
 * @returns the magnitude, or null when there is no range to reason about.
 */
export function focalSensitivity(refDepthMm: number, rangeToRefMm: number | null): number | null {
  if (!refDepthMm) return 0
  if (rangeToRefMm == null || !(rangeToRefMm > 0)) return null
  const dOverR = refDepthMm / rangeToRefMm
  const k = 1 - dOverR
  if (!(k > 0)) return null
  return Math.abs(dOverR / k)
}

export function mmPerPxAtMastFromRef(
  mmPerPxAtRef: number,
  refDepthMm: number,
  sensor: SensorSpec,
): { mmPerPxAtMast: number; rangeMm: number | null; corrected: boolean } {
  const rangeToRef = rangeMmFrom(sensor, mmPerPxAtRef)
  if (!refDepthMm) {
    return { mmPerPxAtMast: mmPerPxAtRef, rangeMm: rangeToRef, corrected: true }
  }
  if (rangeToRef == null) {
    // Honest failure: hand back the uncorrected scale and say it is uncorrected,
    // so the caller can widen the sigma and the checks can say so out loud.
    return { mmPerPxAtMast: mmPerPxAtRef, rangeMm: null, corrected: false }
  }
  const rangeToMast = rangeToRef - refDepthMm
  if (!(rangeToMast > 0)) {
    return { mmPerPxAtMast: mmPerPxAtRef, rangeMm: rangeToRef, corrected: false }
  }
  return {
    mmPerPxAtMast: (mmPerPxAtRef * rangeToMast) / rangeToRef,
    rangeMm: rangeToMast,
    corrected: true,
  }
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
  /**
   * Where each landmark sits fore-and-aft, mm, forward positive — the same
   * convention as every depth in the rig model.
   *
   * Needed because the two landmarks are at DIFFERENT depths and therefore at
   * different image scales: see `effectiveSeparationMm`. Optional, and when
   * absent ψ is solved the old way, which is right only for a camera at
   * infinity. Both must be given or neither.
   */
  depthFwdMm?: number
  depthAftMm?: number
}

/**
 * The separation ψ is actually divided by, once the two landmarks' own image
 * scales are accounted for.
 *
 * THE BUG THIS FIXES. ψ is read off the image displacement between two
 * centreplane landmarks, and that displacement was converted to millimetres
 * with ONE scale — the mast's. But the landmarks are at different depths: a
 * transom 7.8 m abaft the mast is nearer the camera and images LARGER, so its
 * share of the displacement is worth fewer millimetres per pixel than the
 * mast's. Using the mast's scale for both inflates the displacement, and ψ with
 * it.
 *
 * The algebra collapses to something simple. A centreplane point at depth d is
 * displaced −d·sinψ mm, which at that point's own scale k·(R+d)/R is
 * −d·sinψ·R / (k·(R+d)) pixels. Differencing the two landmarks and multiplying
 * by k gives −sinψ·R·[d_f/(R+d_f) − d_a/(R+d_a)], and that bracket times R is
 *
 *     separation · R² / ((R + d_f)(R + d_a))
 *
 * — the true separation divided by the PRODUCT of the two landmarks' depth
 * scale factors. So the inflation is exactly that product's reciprocal, it is
 * 1 when both landmarks sit in the mast plane, and it tends to 1 as R grows.
 *
 * It is not small and it is not constant. On a mast→transom baseline of 7.8 m
 * it is 1.45 at a 25 m range and 1.31 at 33 m — so two frames of the SAME trim
 * shot from different distances get ψ wrong by different amounts, which is the
 * one kind of error that makes a port-tack measurement disagree with a
 * starboard-tack one. On a clew at E that was worth 33 mm on the near frame and
 * 110 mm on a frame at ψ = 5°.
 */
export function effectiveSeparationMm(
  base: Pick<CentreplaneBaseline, 'separationMm' | 'depthFwdMm' | 'depthAftMm'>,
  rangeMm: number | null | undefined,
): number {
  const { separationMm: sep, depthFwdMm: df, depthAftMm: da } = base
  // No range means no depth correction anywhere in this file; no depths means
  // the caller has not been taught to supply them. Either way: the old answer.
  if (rangeMm == null || !(rangeMm > 0)) return sep
  if (df == null || da == null || !Number.isFinite(df) || !Number.isFinite(da)) return sep
  const sf = (rangeMm + df) / rangeMm
  const sa = (rangeMm + da) / rangeMm
  // A landmark at or behind the camera is not a photograph of a boat.
  if (!(sf > 0) || !(sa > 0)) return sep
  return sep / (sf * sa)
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
  opts: { clickSigmaPx?: number; assumedSigmaDeg?: number; rangeMm?: number | null } = {},
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
  // NOT base.separationMm: the two landmarks are at different depths and so at
  // different image scales. See `effectiveSeparationMm` — dividing by the true
  // separation inflates ψ by up to 45 % on a close shot.
  const sepMm = effectiveSeparationMm(base, opts.rangeMm)
  if (!(sepMm > 0)) return { deg: 0, sigmaDeg: assumed, measured: false }
  const s = Math.max(-1, Math.min(1, -duMm / sepMm))
  const deg = Math.asin(s) / DEG
  // Two clicks, each ±clickSigma, over the baseline — over the EFFECTIVE one,
  // for the same reason the angle is.
  const clickPx = opts.clickSigmaPx ?? 1.5
  const sigmaDeg = ((Math.SQRT2 * clickPx * mmPerPxAtMast) / sepMm) / DEG
  return { deg, sigmaDeg, measured: true }
}

/**
 * TWA → tack, the way the rest of SSA reads it (`manoeuvres.ts`, `phaseStats.ts`):
 * wind on the starboard bow is a positive TWA.
 */
export const tackFromTwa = (twaDeg: number | null | undefined): 'port' | 'stbd' | null =>
  twaDeg == null || !Number.isFinite(twaDeg) ? null : (twaDeg >= 0 ? 'stbd' : 'port')

/**
 * +1 or −1, converting an image-signed athwartships offset into a
 * LEEWARD-POSITIVE one.
 *
 * From astern, image-right is starboard. On starboard tack the wind is from
 * starboard, so starboard is WINDWARD and its offsets must come out negative —
 * hence the flip. On port tack windward is already the negative side, so
 * nothing changes.
 */
export const leewardSign = (tack: 'port' | 'stbd' | null | undefined): number =>
  tack === 'stbd' ? -1 : 1

/**
 * Undo the bias an ATHWARTSHIPS scale reference puts into the whole calibration.
 *
 * Seen from ψ off the centreplane, an athwartships length images at cos ψ of its
 * true extent, so the mm-per-pixel derived from one is too BIG by 1/cos ψ. Every
 * measurement then reads high by sec ψ — 3.5 % at 15°, 6.4 % at 20° — and, worse,
 * `solvePsi` inherits the same factor and returns asin(tan ψ) instead of ψ:
 * 15° reads as 15.6°, 20° as 21.4°.
 *
 * Both are invertible exactly, and neither needs iterating. `sin(ψ_biased) =
 * tan(ψ_true)` gives ψ back, and cos of that puts the scale right. Checked
 * against a full perspective camera at 5-25°: ψ comes back within 0.1°.
 *
 * A VERTICAL reference — P between the black bands, or any length up the mast —
 * has none of this: rotating the camera about a vertical axis does not
 * foreshorten a vertical line. That is the reference to use when the shot is a
 * long way off the centreplane, and it is on every IRC certificate.
 */
export function unbiasAthwartshipsScale(
  mmPerPxRaw: number,
  psiBiasedDeg: number,
): { mmPerPxAtMast: number; psiDeg: number } {
  const sinB = Math.sin(psiBiasedDeg * DEG)
  // |sin ψ_biased| >= 1 means tan ψ >= 1, i.e. 45° off the centreplane. That is
  // not an astern photograph and there is nothing sensible to return.
  if (!(Math.abs(sinB) < 1)) return { mmPerPxAtMast: mmPerPxRaw, psiDeg: psiBiasedDeg }
  const psiDeg = Math.atan(sinB) / DEG
  return { mmPerPxAtMast: mmPerPxRaw * Math.cos(psiDeg * DEG), psiDeg }
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
  /**
   * Which tack the boat is on, from the log.
   *
   * It is what turns the sign of a measurement from a fact about the IMAGE into
   * a fact about the BOAT. `across` points image-right, which seen from astern
   * is starboard; but "150 mm to starboard" means opposite things on opposite
   * tacks, and a boom above the centreline is the case anybody cares about. With
   * the tack known the convention becomes LEEWARD POSITIVE, so the same trim
   * reads the same number whichever way the boat is going and a boom to windward
   * reads negative. Without it the sign stays image-relative and is not worth
   * printing — `leewardPositive` on the measurement says which you have.
   */
  tack?: 'port' | 'stbd' | null
  /** Two baseline points were clicked but the chosen baseline has no length, so
   *  ψ could not be solved. The difference between "not marked" and "marked and
   *  silently ignored" is worth saying out loud. */
  baselineMarkedButUnmeasured?: boolean
  /** The scale reference's own offset from the mast, forward positive. */
  scaleRefDepthMm?: number
  /** True when that offset could NOT be corrected for — no focal length, so no
   *  range — and the scale is therefore biased by depth/range. */
  scaleDepthUncorrected?: boolean
  /**
   * True when the reference's DEPTH is a guess rather than a measurement.
   *
   * Separate from `scaleDepthUncorrected`, which is about not having a focal
   * length to correct a KNOWN depth with. This is not knowing the depth at all.
   *
   * It matters most where it is least visible: a reference carrying depth 0
   * because nobody has measured it looks exactly like one carrying depth 0
   * because it genuinely sits in the mast plane, and the old check keyed off the
   * depth being non-zero — so the guess produced no warning whatsoever. Baraka's
   * granny bar is the case: it sits a little abaft the mast, nobody has taped
   * how far, and 800 mm of that at 40 m is 2 % on every millimetre measured
   * with it.
   */
  scaleRefDepthEstimated?: boolean
  /**
   * The boat's longest known baseline, mm — a floor on how far away the camera
   * can possibly be.
   *
   * Used for the one check that catches marking the scale on the WRONG FEATURE,
   * which nothing else does. The range comes out of the scale and the focal
   * length, so declaring a 3375 mm reference while clicking the 31440 mm one
   * shrinks every millimetre on the frame by 9x and the range with it — and the
   * numbers all stay self-consistent. Northstar's three 27 Sep frames came back
   * at a 21 m range on a 23.2 m boat, which is not a photograph anyone took.
   *
   * It cannot be checked against the lens: range/mmPerPx is focal/pitch, which
   * is constant only at a FIXED focal length, and these were shot on a zoom.
   */
  boatLengthMm?: number
  /** The image's long edge in pixels, so the frame's own physical extent is
   *  known: mmPerPxAtMast x this is how much of the world is in the picture. */
  imageLongEdgePx?: number
  /** A rival, measured from the coach boat. None of our instrument data
   *  describes it — see effectiveHeelDeg. */
  isCompetitor?: boolean
}

/**
 * Heel to use for the geometry: what the IMAGE says, else what the log says.
 *
 * …except on a COMPETITOR, where the log is not an option at all. Every
 * instrument reading SSA holds is from our own boat, so the logged heel at
 * 12:25 is Northstar's, not Capricorno's. Handing it to a measurement of
 * Capricorno's rig is not an approximation, it is a different boat's number,
 * and it is wrong by however much the two differ — which upwind in a breeze is
 * plenty, and is exactly when the measurement is worth taking. A rival's heel
 * can only come from the photograph: the mast against the sea horizon, which
 * the detector reads to about 1.5°.
 *
 * So for a competitor this returns null rather than the log's figure, and the
 * caller says the horizon is needed. Null is the honest answer; a plausible
 * wrong number is the dangerous one.
 */
export function effectiveHeelDeg(cal: Calibration): number | null {
  const fromImage = imageHeelDeg(cal.axis, cal.horizon)
  if (fromImage != null) return fromImage
  return cal.isCompetitor ? null : cal.heelDeg
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
  /**
   * The fore-and-aft depth this measurement was corrected with, mm, forward
   * positive — `TargetInput.depthMm` as it actually arrived.
   *
   * It is a diagnostic in the tool and load-bearing everywhere else: the value
   * above is `raw + d·sinψ`-corrected, so ANY later re-analysis has to subtract
   * the same d to recover the raw offset. Without it recorded, a script has to
   * infer d from the rig model as it stands now — and the rig model moves, which
   * is how the triangulation script came to un-correct with the -6000 fallback
   * while the app had used per-station depths. The mismatch is a per-station
   * constant, so it vanishes into D and leaves the residuals small.
   */
  depthMm: number
  depthSigmaMm: number
  depthScaleApplied: boolean
  rollApplied: boolean
  /**
   * True when the tack was known, so the sign means LEEWARD POSITIVE — a boom
   * or a main leech above the centreline reads negative, and the same trim reads
   * the same number on both tacks. False when it was not, in which case the sign
   * is merely image-right-positive and should not be shown.
   */
  leewardPositive?: boolean
  /** Where the CENTREPLANE is at this target's depth — the other end of the
   *  measured line, and what to draw to. Not a point on the mast. */
  foot?: Px
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
/**
 * Where the boat's CENTREPLANE crosses a target's own depth, in the image.
 *
 * This is the thing a measurement is actually taken from, and it is NOT the
 * mast's line. The centreplane is a plane; a camera that is not in it sees it as
 * a region, not a line, so "distance from the centreplane" can only be read off
 * the picture once the target's depth is known. At depth d the plane sits
 * −d·sinψ·cos(heel) away from the mast axis, which is exactly the term
 * `measureTarget` adds — this returns the same displacement as a POINT, so the
 * line drawn on the photograph ends where the number says it does.
 *
 * On Northstar's boom, E = 10.33 m abaft the mast: at ψ = 0.42° that is 73 mm,
 * about 21 px on a 68 m shot. Draw the foot on the mast instead and the line and
 * its label disagree by that much.
 */
export function centreplaneFoot(cal: Calibration, point: Px, depthMm: number): Px {
  const onMast = intersectLineWithAxis(point, cal.axis.across, cal.axis)
    ?? { x: cal.axis.low.x, y: cal.axis.low.y }
  if (!depthMm) return onMast
  const mmPerPx = mmPerPxAtDepth(cal.mmPerPxAtMast, depthMm, cal.rangeMm)
  if (!(mmPerPx > 0)) return onMast
  const offPx = -(depthMm * Math.sin(cal.psi.deg * DEG) * cosHeel(effectiveHeelDeg(cal))) / mmPerPx
  return { x: onMast.x + cal.axis.across.x * offPx, y: onMast.y + cal.axis.across.y * offPx }
}

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
    // The projection model is a SMALL-ANGLE one. Measured against a full
    // perspective camera, a target at depth d picks up roughly 0.3 % of its
    // value per degree of ψ per 10 m of depth — about −4 % on a boom at E at
    // 15°. It is a modelling residual, not noise, so it cannot be averaged away;
    // the least this can do is stop reporting a confidence it has not got.
    terms.push(Math.abs(valueMm) * 0.003 * Math.abs(psi.deg) * (Math.abs(t.depthMm) / 10_000))
    // range unknown ⇒ the depth correction is simply missing. Charge for it:
    // the correction is d/R, and R is anywhere from ~80 m to ~400 m.
    if (!depthScaleApplied && t.depthMm !== 0) {
      terms.push(Math.abs((valueMm * t.depthMm) / 160_000) / Math.SQRT2)
    }
    return Math.hypot(...terms)
  }

  // Referred to the boat: leeward positive, so a boom above the centreline is
  // negative and the same trim reads the same on both tacks. Applied to the
  // VALUES only — a sigma has no side.
  const flip = leewardSign(cal.tack)
  const boatFrameSigmaMm = sigma(boatFrameMm)
  // The world-horizontal number inherits everything above plus, when the roll
  // correction could not be applied, an unknown camera roll. d(1/cos)/dρ at a
  // 23° lean is ≈0.46 per radian, so a ±2° unknown roll is ≈1.6 %.
  const extra = rollApplied ? 0 : Math.abs(worldHorizontalMm) * 0.016
  const worldHorizontalSigmaMm = Math.hypot(sigma(worldHorizontalMm), extra)

  return {
    key: t.key,
    label: t.label,
    boatFrameMm: boatFrameMm * flip,
    boatFrameSigmaMm,
    worldHorizontalMm: worldHorizontalMm * flip,
    worldHorizontalSigmaMm,
    naiveMm: naiveMm * flip,
    mmPerPxUsed: mmPerPx,
    depthMm: t.depthMm,
    depthSigmaMm: t.depthSigmaMm,
    depthScaleApplied,
    rollApplied,
    leewardPositive: cal.tack != null,
    foot: centreplaneFoot(cal, t.point, t.depthMm),
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
      : cal.baselineMarkedButUnmeasured
        ? 'a centreplane baseline was MARKED but the chosen baseline has no length in the rig model, so ψ fell back to 0 ± 1°. Type its fore-and-aft separation, or pick one that has a number. A degree of ψ is ±17 mm for every metre a target sits abaft the mast, so on a boom at E it is ±180 mm — which is why the boom then reads as a distance to the mast LINE rather than to the centreplane.'
        : 'no centreplane baseline marked — ψ assumed 0 ± 1°, and a degree of ψ is ±17 mm for every metre a target sits from the mast',
  })

  // An unmeasured depth is a reason to warn even when it is being treated as
  // zero — otherwise the one reference whose depth nobody knows is the only one
  // that says nothing.
  if (cal.scaleRefDepthMm || cal.scaleRefDepthEstimated) {
    const d = cal.scaleRefDepthMm ?? 0
    const where = `${Math.abs(d / 1000).toFixed(1)} m ${d < 0 ? 'abaft' : 'forward of'} the mast`
    out.push({
      key: 'scale-depth',
      label: 'Scale reference off the mast plane',
      ok: !cal.scaleDepthUncorrected && !cal.scaleRefDepthEstimated,
      detail: cal.scaleRefDepthEstimated
        ? `this reference's DEPTH has never been measured — it is being treated as ${d ? where : 'sitting in the mast plane'}, which is a guess, not a number. The scale is referred back to the mast plane by depth/range, so being wrong by 800 mm at 40 m is 2 % on every millimetre on this frame. Tape it to the mast and put it in the rig model.`
        : cal.scaleDepthUncorrected
          ? `the reference sits ${where} and there is no focal length, so its scale CANNOT be referred to the mast plane. Every measurement on this frame is biased by depth/range — a few per cent. Enter the focal length, or use a reference at the mast.`
          : `${where}, referred back to the mast plane`,
    })
  }

  // THE FRAME HAS TO BE BIG ENOUGH TO HOLD THE BOAT.
  //
  // mmPerPxAtMast x the long edge is how much of the world is in the picture,
  // and the boat is visibly in it, so that extent cannot be smaller than the
  // boat. It is the one check that catches the scale REFERENCE and the two
  // marks describing different things — a frame with the wrong reference stays
  // perfectly self-consistent, every number simply scaled by the ratio of the
  // two lengths.
  //
  // Northstar's three 27 Sep frames: the marks went on P (31440 mm) with the
  // picker still saying wheels (3375), so the view came out 7.8 m across on a
  // 23.2 m boat. Correctly scaled the same frames are 46.8 m across.
  //
  // It beats checking the RANGE, which only rules out a camera inside the boat
  // and missed two of those three at 22 m; and it beats range/mmPerPx, which is
  // focal/pitch and constant only at a FIXED focal length — these were a zoom.
  // ψ THAT IS NOT A STERN SHOT. solvePsi clamps its asin at ±90°, so a scale
  // that is wildly wrong does not fail — it saturates, and hands back an angle.
  // Northstar's 4 Sept frames came back at 77.2° and 57.7° because P (31440 mm)
  // had been declared over marks on the WHEELS (3375), nine times shorter. The
  // geometry here is a small-angle model checked against a perspective camera
  // from 5 to 25°; past ~30° it is not describing a photograph taken from
  // astern, whatever the arithmetic says.
  if (cal.psi.measured && Math.abs(cal.psi.deg) > 30) {
    out.push({
      key: 'psi-impossible',
      label: 'Misalignment',
      ok: false,
      detail: `ψ = ${cal.psi.deg.toFixed(0)}°, which is not a photograph taken from astern. `
        + 'ψ is solved from the scale, so this almost always means the two scale marks and '
        + 'the REFERENCE in the picker describe different things — check the picker says what '
        + 'you clicked. Nothing on this frame means anything until it does.',
    })
  }

  if (cal.boatLengthMm && cal.boatLengthMm > 0 && cal.imageLongEdgePx && cal.mmPerPxAtMast > 0) {
    const extentMm = cal.mmPerPxAtMast * cal.imageLongEdgePx
    // Too SMALL means the declared reference is shorter than what was clicked;
    // too LARGE means it is longer. Northstar managed both in a week: 7.8 m
    // across on 27 Sep, and 196 m across on 4 Sept, on a 23 m boat.
    const ok = extentMm > cal.boatLengthMm && extentMm < cal.boatLengthMm * 8
    out.push({
      key: 'frame-extent',
      label: 'Does the frame fit the boat',
      ok,
      detail: ok
        ? `the picture is ${(extentMm / 1000).toFixed(0)} m across at the mast, and the boat is `
          + `${(cal.boatLengthMm / 1000).toFixed(0)} m`
        : `this scale makes the picture ${(extentMm / 1000).toFixed(1)} m across at the mast, `
          + `and the boat in it is about ${(cal.boatLengthMm / 1000).toFixed(1)} m long — `
          + `${extentMm < cal.boatLengthMm ? 'too small to contain it' : 'far wider than any frame you would measure a sail on'}. `
          + 'The two scale marks and the REFERENCE in the picker are describing different '
          + 'things — every millimetre on this frame is out by the ratio between them.',
    })
  }

  out.push({
    key: 'tack',
    label: 'Sign of the measurement',
    ok: cal.tack != null,
    detail: cal.tack != null
      ? `${cal.tack === 'stbd' ? 'starboard' : 'port'} tack, so the numbers are LEEWARD POSITIVE — a boom or a main leech above the centreline reads negative, and the same trim reads the same on either tack`
      : 'no tack known, so a sign would only say which way round the photograph is. Give the tool the TWA from the log, or set the tack by hand, and the boom and main leech become signed about the centreline.',
  })

  if (Math.abs(cal.psi.deg) > 6) {
    out.push({
      key: 'psi-large',
      label: 'Well off the centreplane',
      ok: false,
      detail: `ψ = ${cal.psi.deg.toFixed(1)}°. The projection here is a small-angle model and starts to show it: measured against a full perspective camera, a target at the boom's depth reads a few per cent low by 15°, growing with ψ. The near targets — clew, jib leech — stay within about 1 %. Use a VERTICAL scale reference (P, between the mast's black bands) rather than an athwartships one, and treat the boom as indicative.`,
    })
  }

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

/**
 * The geometry that produced a stored measurement.
 *
 * Stamped onto every saved annotation, and BUMPED whenever the maths moves a
 * number — not when the UI changes. SailTrimRecompute compares it against the
 * stored frames and offers to put the operator's clicks back through the
 * current pipeline, so a correction reaches the frames that were measured
 * before it instead of waiting for somebody to reopen all of them by hand.
 *
 *   v0.2-horizon   the horizon-derived camera roll
 *   v0.3-psi-scale solvePsi divides by the EFFECTIVE separation, so ψ is no
 *                  longer inflated by the product of its baseline's two depth
 *                  factors — 45 % at a 25 m range, 1.3 % at 260 m
 */
export const SAILTRIM_VERSION = 'sailtrim-v0.4-twist-relative'

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
