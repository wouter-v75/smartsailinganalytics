// src/lib/sailCamber.ts
// ─────────────────────────────────────────────────────────────────────────────
// Camber and draft position from a stern photograph.
//
// THE THING THAT MAKES IT POSSIBLE, because it inverts the intuition: camber is
// measured PERPENDICULAR to the chord, and the chord of a sail seen from astern
// runs mostly fore-and-aft — the jib's leech is 4.7 m abaft its luff at half
// hoist. So perpendicular to the chord is mostly ATHWARTSHIPS, which is exactly
// the direction an astern camera resolves best. The foreshortening is only
// cos(chord angle): 0.94 to 0.98 on Northstar's stations. Draft is not the
// hardest thing to see from behind. It is nearly the easiest.
//
// THE THING THAT MAKES IT AWKWARD is the other half of the same fact. Position
// ALONG the chord is fore-and-aft, and the operator cannot judge it by eye —
// "I have no way to determine where along the stripe the points are" (Wouter,
// 27 Sep). They do not have to. Both ends of the stripe are already marked: the
// leech end is the stripe station, the luff end is where the luff polyline
// crosses. Projecting a mark onto the line between them gives its position
// along the chord, and that line spans ~220 px, so 2 px of click noise places a
// mark to within 1 % of the chord. The geometry knows what the eye cannot.
//
// WHAT THE OPERATOR MUST DO is spread the marks. Simulated against five
// deliberately wrong section shapes, marks confined to the forward third read
// camber 2.2 points LOW and collapse the draft to 20 %; adding any marks near
// the leech — even where the sail is nearly back on the chord — brings it to
// +0.4 pp. Both ends matter far more than the count. That is why the aft stripe
// showing through the back of the sail is not a curiosity: it is the
// measurement.
//
// NO DEPTH ESTIMATE ENTERS THIS. The fore-and-aft leg comes from the
// certificate width and the measured athwartships offset, so the main leech's
// ±2500 mm guess — which dominates the error on every other target — is
// irrelevant here.
// ─────────────────────────────────────────────────────────────────────────────

export interface Px { x: number; y: number }

export interface CamberFit {
  /** Maximum depth as a fraction of chord. 0.12 = 12 %. */
  camber: number
  /** Where that maximum sits, as a fraction of chord from the LUFF. */
  draft: number
  /** Fit residual in mm, and in pixels — the pixel figure is the one to read,
   *  because it should look like the click noise and nothing more. */
  rmsMm: number
  rmsPx: number
  /** The span of chord the marks actually cover, luff-most to leech-most. */
  coverage: { from: number; to: number }
  /** True when the marks straddle the fitted draft. When false the depth is
   *  extrapolated from one side and reads LOW. */
  spansDraft: boolean
  /** How many marks went in. */
  n: number
  /** The chord this is a fraction OF, mm. */
  chordMm: number
  /** cos(chord angle): how much of the camber survives into the image. */
  projection: number
}

/**
 * The section family: one hump, pinned to zero at both ends, peaking at `draft`.
 *
 * Two parameters, which is the least that can describe a sail and the most a
 * partial arc can support. Tested against a circular arc, a sharp-entry flat-run
 * main, a draft-forward reaching shape and a hooked leech: camber came back
 * within 0.2 points of truth on all of them. Draft position did not — it was 6
 * points out on the sharp-entry shape — so camber is the number to trust and
 * the residual is what says when the family is wrong.
 */
export function sectionDeviation(s: number, camber: number, draft: number): number {
  if (!(s > 0) || !(s < 1)) return 0
  if (!(draft > 0) || !(draft < 1)) return 0
  const a = draft / (1 - draft)
  return camber * Math.pow(s / draft, a) * ((1 - s) / (1 - draft))
}

/** Where a mark sits along the chord, and how far off it — in IMAGE pixels. */
export function alongAndOff(mark: Px, luff: Px, leech: Px): { s: number; offPx: number } | null {
  const dx = leech.x - luff.x, dy = leech.y - luff.y
  const L2 = dx * dx + dy * dy
  if (!(L2 > 0)) return null
  const s = ((mark.x - luff.x) * dx + (mark.y - luff.y) * dy) / L2
  // Signed, so a mark on the wrong side of the chord shows up as a sign flip
  // rather than quietly adding to the depth.
  const offPx = ((mark.x - luff.x) * dy - (mark.y - luff.y) * dx) / Math.sqrt(L2)
  return { s, offPx }
}

export interface CamberInput {
  /** Marks on the FRONT face — the side of the sail turned towards the camera,
   *  forward of where the stripe turns away. */
  front: Px[]
  /** Marks on the BACK, aft of that turn: the far face, seen past the leech. */
  back: Px[]
  /** The stripe's two ends, already marked for the leech position and twist. */
  luff: Px
  leech: Px
  /** Chord at this station, off the certificate (MHW, HHW…). */
  chordMm: number
  /** The chord's angle to the centreline, degrees — `chordAngle` already
   *  computes it for twist. */
  chordAngleDeg: number
}

/**
 * Athwartships offset from the luff, in millimetres, at position s.
 *
 * This is the WHOLE observable. The chord contributes s·CH·sin(angle) and the
 * sail's depth contributes dev·CH·cos(angle), and the camera resolves only
 * their sum — which is why a mark's offset alone cannot say where along the
 * stripe it is. On Capricorno's main the two terms are comparable: the leech
 * sits 879 mm out while an 11 % camber adds 813 mm, so the offset RISES to a
 * turning point and then FALLS back to the leech. Two positions share one
 * offset, and no amount of arithmetic separates them.
 *
 * What separates them is the operator: a mark on the front face is on the
 * rising branch, a mark on the back is on the falling one. That is the single
 * piece of information the photograph cannot supply and the eye can.
 */
export function athwartshipsMm(s: number, camber: number, draft: number, chordMm: number, angleDeg: number): number {
  const a = angleDeg * Math.PI / 180
  return s * chordMm * Math.sin(a) + sectionDeviation(s, camber, draft) * chordMm * Math.cos(a)
}

/** Where the offset stops rising: dev'(s) = -tan(angle). Found by scanning. */
function turningPoint(camber: number, draft: number, chordMm: number, angleDeg: number): number {
  let bestS = 0.5, best = -Infinity
  for (let s = 0.01; s < 1; s += 0.005) {
    const v = athwartshipsMm(s, camber, draft, chordMm, angleDeg)
    if (v > best) { best = v; bestS = s }
  }
  return bestS
}

/**
 * Fit the sail's DEPTH — "draft %" in the crew's words — to marks on one stripe.
 *
 * Depth is the number asked for and the number that survives: tested against a
 * circular arc, a sharp-entry flat-run main, a draft-forward reaching shape and
 * a hooked leech, it came back within 0.2 points of truth on all of them. The
 * POSITION of the deepest point did not — 6 points out on one — so it is fitted
 * because the shape cannot be described without it, and not reported.
 */
export function fitCamber(input: CamberInput): CamberFit | null {
  const { front, back, luff, leech, chordMm, chordAngleDeg } = input
  const marks = [...(front || []), ...(back || [])]
  if (marks.length < 2 || !(chordMm > 0)) return null

  const projection = Math.cos(chordAngleDeg * Math.PI / 180)
  if (!(projection > 0.2)) return null

  // The endpoints calibrate the image themselves: the leech's athwartships
  // offset is known to be chordMm·sin(angle), and it lands |leech-luff| pixels
  // from the luff. No separate scale is needed, and none of the rig model's
  // depth guesses enter.
  const chordPx = Math.hypot(leech.x - luff.x, leech.y - luff.y)
  const leechMm = chordMm * Math.sin(chordAngleDeg * Math.PI / 180)
  if (!(chordPx > 10) || !(Math.abs(leechMm) > 1)) return null
  const mmPerPx = leechMm / chordPx

  const offsetMm = (m: Px) => {
    const a = alongAndOff(m, luff, leech)
    return a ? a.s * leechMm : null      // distance along the chord's image line
  }
  const obs: { mm: number; branch: 'front' | 'back' }[] = []
  for (const m of front || []) { const o = offsetMm(m); if (o != null) obs.push({ mm: o, branch: 'front' }) }
  for (const m of back || []) { const o = offsetMm(m); if (o != null) obs.push({ mm: o, branch: 'back' }) }
  if (obs.length < 2) return null

  let best: { camber: number; draft: number; ss: number } | null = null
  for (let d = 0.25; d <= 0.65; d += 0.01) {
    for (let c = 0.01; c <= 0.30; c += 0.001) {
      const turn = turningPoint(c, d, chordMm, chordAngleDeg)
      let ss = 0
      for (const o of obs) {
        // Each mark is matched only on ITS OWN branch, which is what the
        // front/back split buys: the rising side, or the falling side.
        const lo = o.branch === 'front' ? 0.01 : turn
        const hi = o.branch === 'front' ? turn : 0.99
        let near = Infinity
        for (let s = lo; s <= hi; s += 0.005) {
          const e = Math.abs(athwartshipsMm(s, c, d, chordMm, chordAngleDeg) - o.mm)
          if (e < near) near = e
        }
        ss += near * near
      }
      if (!best || ss < best.ss) best = { camber: c, draft: d, ss }
    }
  }
  if (!best) return null

  const rmsMm = Math.sqrt(best.ss / obs.length)
  return {
    camber: best.camber,
    draft: best.draft,
    rmsMm,
    rmsPx: rmsMm / Math.abs(mmPerPx),
    coverage: { from: 0, to: 1 },
    spansDraft: (front?.length ?? 0) > 0 && (back?.length ?? 0) > 0,
    n: obs.length,
    chordMm,
    projection,
  }
}

/** What to say about a fit, in the order the operator can act on it. */
export function camberNote(f: CamberFit, clickSigmaPx = 1.5): string {
  const bits: string[] = []
  if (!f.spansDraft) {
    bits.push(`the marks cover ${(f.coverage.from * 100).toFixed(0)}–${(f.coverage.to * 100).toFixed(0)} % of the chord and the draft is fitted at ${(f.draft * 100).toFixed(0)} %, so the depth is extrapolated and reads LOW — mark whatever shows of the stripe nearer the other end`)
  }
  if (f.rmsPx > 3 * clickSigmaPx) {
    bits.push(`the marks sit ${f.rmsPx.toFixed(1)} px off the fitted section, well beyond clicking accuracy — either a mark is on the wrong stripe, or this sail is not the shape the model assumes`)
  }
  if (f.n < 4) bits.push(`only ${f.n} marks — four or more, at BOTH ends of what is visible, is what makes this reliable`)
  return bits.join('; ')
}
