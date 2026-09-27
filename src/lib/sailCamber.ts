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
  marks: Px[]
  /** The stripe's two ends, already marked for the leech position and twist. */
  luff: Px
  leech: Px
  /** Chord at this station, off the certificate (MHW, HHW…). */
  chordMm: number
  /** Millimetres per pixel at this stripe's depth. */
  mmPerPx: number
  /** The chord's angle to the centreline, degrees — `chordAngle` already
   *  computes it for twist, and its cosine is the foreshortening. */
  chordAngleDeg: number
}

/**
 * Fit camber and draft position to marks along one stripe.
 *
 * Returns null when there is nothing honest to say: fewer than two marks, or
 * marks that do not lie between the two ends.
 */
export function fitCamber(input: CamberInput): CamberFit | null {
  const { marks, luff, leech, chordMm, mmPerPx, chordAngleDeg } = input
  if (!marks || marks.length < 2 || !(chordMm > 0) || !(mmPerPx > 0)) return null

  // Undo the foreshortening once, here, rather than in the search loop.
  const projection = Math.cos(chordAngleDeg * Math.PI / 180)
  if (!(projection > 0.2)) return null      // edge-on: nothing to measure

  // WHY THIS SOMETIMES REFUSES.
  //
  // Everything below resolves a mark along the luff-to-leech line and calls its
  // distance from that line the depth. The arc itself is smooth — nothing you
  // would see in the photograph — but the MAPPING is not always one-to-one. On
  // Capricorno's main at half hoist the leech sits 879 mm to leeward of the luff
  // while an 11 % camber puts the deepest part of the stripe about 1210 mm out,
  // so the stripe reaches further to leeward in the middle than at its own end
  // and two positions along it share one offset. The chord has stopped being an
  // axis.
  //
  // The signature is marks resolving OUTSIDE the chord: on that geometry a point
  // 30 % along came back as 117 %. Discarding them silently is what produced
  // 1.0 % where the truth was 11 %, so count them instead, and say nothing when
  // too many land out there. A wrong camber reads exactly like a right one.
  //
  // The fix is to project the section through the camera and fit the marks to
  // that curve, using their order along the stripe to resolve the ambiguity —
  // which needs the real marks to build against, not a model of them.
  let outside = 0
  for (const m of marks) {
    const a = alongAndOff(m, luff, leech)
    if (!a || a.s < -0.05 || a.s > 1.05) outside++
  }
  if (outside > marks.length * 0.25) return null

  const obs: { s: number; y: number }[] = []
  for (const m of marks) {
    const a = alongAndOff(m, luff, leech)
    // Marks outside the ends are a mis-click or the wrong stripe; a point at an
    // end carries no information, because the deviation is zero there by
    // construction and fitting to it only dilutes the rest.
    if (!a || a.s <= 0.02 || a.s >= 0.98) continue
    obs.push({ s: a.s, y: Math.abs(a.offPx) * mmPerPx / projection / chordMm })
  }
  if (obs.length < 2) return null

  let best: { camber: number; draft: number; ss: number } | null = null
  for (let d = 0.20; d <= 0.70; d += 0.005) {
    for (let c = 0.01; c <= 0.30; c += 0.0005) {
      let ss = 0
      for (const o of obs) { const e = sectionDeviation(o.s, c, d) - o.y; ss += e * e }
      if (!best || ss < best.ss) best = { camber: c, draft: d, ss }
    }
  }
  if (!best) return null

  const rmsChord = Math.sqrt(best.ss / obs.length)
  const from = Math.min(...obs.map((o) => o.s))
  const to = Math.max(...obs.map((o) => o.s))
  return {
    camber: best.camber,
    draft: best.draft,
    rmsMm: rmsChord * chordMm,
    // Back into pixels, which is where the operator's error actually lives.
    rmsPx: (rmsChord * chordMm * projection) / mmPerPx,
    coverage: { from, to },
    spansDraft: from <= best.draft && best.draft <= to,
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
