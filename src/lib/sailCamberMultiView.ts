// src/lib/sailCamberMultiView.ts
// ─────────────────────────────────────────────────────────────────────────────
// The sail's DEPTH — "draft %" — from several stern shots of one stripe.
//
// WHY A SINGLE FRAME CANNOT DO IT. A dot's only observable is its athwartships
// offset from the mast axis. That offset mixes how far ALONG the stripe the dot
// sits with how deep the sail is there, and on a main the two are comparable —
// the leech is 650 mm out while the belly reaches 1000 and more. One number,
// two unknowns, per dot.
//
// Correcting for ψ needs each dot's DEPTH, and a dot's depth depends on where
// along the chord it is, which is the unknown. Circular. Give every dot the
// leech's depth instead and the error scales with sin ψ: on the 27 Sep 11:43
// set that produced 14.8 %, 10.4 % and 8.5 % from three frames of the same
// sail six seconds apart, ordered exactly by their ψ.
//
// SEVERAL FRAMES BREAK THE CIRCLE. One section shape — a camber depth and a
// draft position — has to explain every dot in every frame at once, and each
// dot's depth then follows from its own fitted position along the chord rather
// than being assumed. Two unknowns against thirty-odd observations, and the
// frames' mutual agreement becomes the residual.
//
// NO POINT CORRESPONDENCE IS NEEDED, which is what killed every earlier
// attempt: a dot on a featureless painted stripe cannot be matched between
// frames. Only the ORDER along the stripe is used, which is how they are
// marked anyway.
//
// The datum is the MAST AXIS, never the luff-to-leech line. Seen from astern
// that line is 6 px long on some frames — the chord points nearly along the
// line of sight — and dividing by it turns a pixel of noise into metres.
// ─────────────────────────────────────────────────────────────────────────────

export interface MultiViewDot {
  /** Athwartships offset from the mast axis, mm, with NO ψ correction applied —
   *  the raw thing the image gives. */
  rawMm: number
}

export interface MultiViewFrame {
  psiDeg: number
  /** Dots in the order they lie along the stripe, luff end first. */
  dots: MultiViewDot[]
}

export interface MultiViewInput {
  frames: MultiViewFrame[]
  /** Chord at this station, off the certificate (MHW, HHW…), mm. */
  chordMm: number
  /** The leech's athwartships offset and depth — both MEASURED, by
   *  triangulating the leech point across the same frames. */
  leechAthwartshipsMm: number
  leechDepthMm: number
}

export interface MultiViewFit {
  /** Depth as a fraction of chord. 0.11 = 11 %. */
  camber: number
  /** Where it peaks, as a fraction of chord from the luff. Fitted because the
   *  shape needs it, not because it is trustworthy on its own. */
  draft: number
  /** How far the dots sit from the fitted section, mm. */
  rmsMm: number
  dots: number
  frames: number
  baselineDeg: number
  /** True when some dot is past the fitted peak — without that the depth is
   *  extrapolated from one flank and reads LOW. */
  reachedPeak: boolean
}

const D2R = Math.PI / 180

/** One hump, pinned to zero at both ends, peaking at `draft`. */
export function sectionDev(s: number, camber: number, draft: number): number {
  if (!(s > 0) || !(s < 1) || !(draft > 0) || !(draft < 1)) return 0
  const a = draft / (1 - draft)
  return camber * Math.pow(s / draft, a) * ((1 - s) / (1 - draft))
}

/**
 * What a frame at `psi` sees for the section point at `s`: the athwartships
 * offset from the mast axis, uncorrected, which is what the image measures.
 *
 * The chord runs from the luff (on the mast: 0 athwartships, 0 depth) to the
 * measured leech. The deviation is perpendicular to it, in the stripe's own
 * plane, so both the athwartships and the depth components follow.
 */
export function rawAt(
  s: number, camber: number, draft: number,
  chordMm: number, leechY: number, leechD: number, psiDeg: number,
): number {
  const cy = leechY, cd = leechD
  const len = Math.hypot(cy, cd) || 1
  // Perpendicular to the chord, pointing to the side the sail bellies.
  const ny = -cd / len, nd = cy / len
  const dev = sectionDev(s, camber, draft) * chordMm
  const Y = s * cy + dev * ny
  const D = s * cd + dev * nd
  const p = psiDeg * D2R
  return Y * Math.cos(p) - D * Math.sin(p)
}

/**
 * Fit one section to every dot in every frame.
 *
 * Within a frame the dots are required to advance along the stripe in the order
 * they were marked. That is the only thing standing in for correspondence, and
 * it is enough: it stops the fit satisfying a dot by sending it to the far side
 * of the sail.
 */
export function fitCamberMultiView(input: MultiViewInput): MultiViewFit | null {
  const { frames, chordMm, leechAthwartshipsMm: LY, leechDepthMm: LD } = input
  const usable = (frames || []).filter((f) => f.dots?.length)
  const nDots = usable.reduce((n, f) => n + f.dots.length, 0)
  if (usable.length < 2 || nDots < 6 || !(chordMm > 0)) return null

  const psis = usable.map((f) => f.psiDeg)
  const baseline = Math.max(...psis) - Math.min(...psis)
  // Frames from one spot agree with each other and say nothing. Refusing beats
  // returning a confident number built out of rounding.
  if (!(baseline >= 2)) return null

  // EVENLY SPACED, not free. Letting every dot find its own s lets the model
  // explain almost any monotonic sequence, which leaves the objective flat and
  // the answer at the mercy of a pixel: one pixel of noise moved the depth 3.6
  // points that way. People mark dots roughly evenly along whatever they can
  // see, so each frame contributes two unknowns — where its run starts and
  // where it ends — instead of one per dot. Three frames: eight unknowns
  // against thirty-odd observations, which is a fit rather than an
  // interpolation.
  const spanFor = (n: number, a: number, b: number) =>
    Array.from({ length: n }, (_, i) => (n === 1 ? a : a + (i / (n - 1)) * (b - a)))

  const residual = (c: number, d: number) => {
    let ss = 0
    for (const f of usable) {
      let bestF = Infinity
      for (let a = 0.02; a <= 0.6; a += 0.02) {
        for (let b = a + 0.1; b <= 0.97; b += 0.02) {
          let e = 0
          const ss2 = spanFor(f.dots.length, a, b)
          for (let i = 0; i < f.dots.length; i++) {
            const pred = rawAt(ss2[i], c, d, chordMm, LY, LD, f.psiDeg)
            e += (pred - f.dots[i].rawMm) ** 2
          }
          if (e < bestF) bestF = e
        }
      }
      ss += bestF
    }
    return ss
  }

  let best: { camber: number; draft: number; ss: number } | null = null
  for (let d = 0.25; d <= 0.65; d += 0.02) {
    for (let c = 0.01; c <= 0.30; c += 0.004) {
      const ss = residual(c, d)
      if (!best || ss < best.ss) best = { camber: c, draft: d, ss }
    }
  }
  if (!best) return null

  // Did any dot get past the peak, or is the depth extrapolated from one flank?
  let reached = false
  for (const f of usable) {
    let bestE = Infinity, bestA = 0.02, bestB = 0.9
    for (let a = 0.02; a <= 0.6; a += 0.02) {
      for (let b = a + 0.1; b <= 0.97; b += 0.02) {
        let e = 0
        const ss2 = spanFor(f.dots.length, a, b)
        for (let i = 0; i < f.dots.length; i++) e += (rawAt(ss2[i], best.camber, best.draft, chordMm, LY, LD, f.psiDeg) - f.dots[i].rawMm) ** 2
        if (e < bestE) { bestE = e; bestA = a; bestB = b }
      }
    }
    if (bestB > best.draft) reached = true
  }

  return {
    camber: best.camber,
    draft: best.draft,
    rmsMm: Math.sqrt(best.ss / nDots),
    dots: nDots,
    frames: usable.length,
    baselineDeg: baseline,
    reachedPeak: reached,
  }
}

/** What to say about a fit, in the order somebody can act on it. */
export function multiViewNote(f: MultiViewFit, clickSigmaMm = 15): string {
  const bits: string[] = []
  if (!f.reachedPeak) {
    bits.push('no dot reaches past the deepest part of the sail, so the depth is extrapolated from one flank and reads LOW — mark further along the stripe if any of it is visible')
  }
  if (f.baselineDeg < 5) {
    bits.push(`only ${f.baselineDeg.toFixed(1)}° between the frames; 8° or more is what separates depth from position along the chord`)
  }
  if (f.rmsMm > 4 * clickSigmaMm) {
    bits.push(`the dots sit ${f.rmsMm.toFixed(0)} mm from the fitted section, past marking accuracy — a frame's ψ may be wrong, or the dots are not all on one stripe`)
  }
  return bits.join('; ')
}
