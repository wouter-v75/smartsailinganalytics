// Wind barbs — the met convention, drawn as SVG.
//
// WHY A BARB AND NOT AN ARROW. An arrow with a number beside it makes you READ
// each station one at a time. A field of barbs is read at a glance: the shaft
// says where the wind is from, and the feathers say how hard without a single
// digit being parsed. On a map with twenty-odd stations that is the difference
// between a picture and a table.
//
// THE RULES, which are fixed and not ours to adjust:
//   pennant (filled triangle) = 50 kn
//   full barb                 = 10 kn
//   half barb                 =  5 kn
//   bare shaft                =  1-2 kn
//   ring                      = calm, or a speed with no direction
// Speed is ROUNDED TO THE NEAREST 5 kn before feathering, because the symbol
// cannot express anything finer. The exact value is printed beside it.
//
// The shaft points toward where the wind is COMING FROM, like every other wind
// symbol in this app and like the forecast deck's own barbs.

export interface BarbParts {
  pennants: number
  fulls: number
  halves: number
  /** Nothing to draw but a ring: calm, or a direction we do not have. */
  calm: boolean
  /** What the FEATHERS add up to, which is the rounded speed, not the real one. */
  roundedKn: number
}

/**
 * Feather counts for a speed. Rounded to the nearest 5 kn first — a barb cannot
 * say 7, and pretending otherwise by drawing something in between would be a
 * symbol nobody can read back.
 */
export function barbParts(kn: number): BarbParts {
  if (!Number.isFinite(kn) || kn < 0) return { pennants: 0, fulls: 0, halves: 0, calm: true, roundedKn: 0 }
  const r = Math.round(kn / 5) * 5
  // Calm is judged on the REAL speed, not the rounded one. 2 kn rounds to no
  // feathers at all but is not calm — the convention draws it as a bare shaft,
  // and a ring would claim the anemometer read zero when it did not.
  if (r < 5) return { pennants: 0, fulls: 0, halves: 0, calm: kn < 1, roundedKn: r }
  let left = r
  const pennants = Math.floor(left / 50); left -= pennants * 50
  const fulls = Math.floor(left / 10); left -= fulls * 10
  const halves = Math.floor(left / 5)
  return { pennants, fulls, halves, calm: false, roundedKn: r }
}

// Geometry, in a 44x44 box with the station at its centre. The shaft points UP
// (north) before rotation, so rotating by the wind's direction makes it point at
// the source.
const CX = 22, CY = 22
// TIP_Y leaves room for the first feather's RISE. At TIP_Y 4 with RISE 5 the
// topmost feather reached y = -1 and was clipped off by the viewBox — the barb
// then read one feather short, which is 10 kn of silent error.
const TIP_Y = 6                 // far end of the shaft
const FEATHER_STEP = 3.2        // spacing down the shaft
const FULL_LEN = 11
const PENNANT_LEN = 10
const RISE = 4.5                // how far a feather climbs back toward the tip

/**
 * Barb strokes in local coordinates, tip-first down the shaft.
 *
 * Feathers are drawn on the LEFT of the shaft, which is the northern-hemisphere
 * convention. We do not flip them south of the equator: every venue in this app
 * is northern, and a symbol that silently changes handedness by latitude is
 * harder to trust than one that is consistently one thing.
 */
export function barbGeometry(kn: number): { shaft: string; strokes: string[]; pennants: string[]; ring: boolean } {
  const p = barbParts(kn)
  if (p.calm) return { shaft: '', strokes: [], pennants: [], ring: true }

  const shaft = `M${CX} ${CY} L${CX} ${TIP_Y}`
  const strokes: string[] = []
  const pennants: string[] = []
  let y = TIP_Y

  for (let i = 0; i < p.pennants; i++) {
    pennants.push(`M${CX} ${y} L${CX - PENNANT_LEN} ${y + RISE * 0.5} L${CX} ${y + FEATHER_STEP * 1.6} Z`)
    y += FEATHER_STEP * 1.9
  }
  for (let i = 0; i < p.fulls; i++) {
    strokes.push(`M${CX} ${y} L${(CX - FULL_LEN).toFixed(1)} ${(y - RISE).toFixed(1)}`)
    y += FEATHER_STEP
  }
  for (let i = 0; i < p.halves; i++) {
    // A half barb never sits at the very tip: a lone 5 kn feather is moved down
    // one step so it cannot be misread as a full barb drawn short.
    if (y === TIP_Y) y += FEATHER_STEP
    strokes.push(`M${CX} ${y} L${(CX - FULL_LEN / 2).toFixed(1)} ${(y - RISE / 2).toFixed(1)}`)
    y += FEATHER_STEP
  }
  return { shaft, strokes, pennants, ring: false }
}

/**
 * The finished symbol. `dirDeg` is the direction the wind is FROM, true; null
 * draws the ring, because a barb without a direction would invent one.
 */
export function barbSvg(kn: number, dirDeg: number | null, colour: string, opacity = 1): string {
  const g = dirDeg == null ? { shaft: '', strokes: [], pennants: [], ring: true } : barbGeometry(kn)
  const common = `stroke="${colour}" stroke-width="1.8" stroke-linecap="round" fill="none"`
  if (g.ring) {
    return `<svg width="44" height="44" viewBox="0 0 44 44" style="opacity:${opacity}" aria-hidden="true">`
      + `<circle cx="${CX}" cy="${CY}" r="5" ${common}/></svg>`
  }
  const rot = `transform="rotate(${dirDeg} ${CX} ${CY})"`
  const parts = [
    `<path d="${g.shaft}" ${common}/>`,
    ...g.strokes.map((d) => `<path d="${d}" ${common}/>`),
    ...g.pennants.map((d) => `<path d="${d}" stroke="${colour}" stroke-width="1" stroke-linejoin="round" fill="${colour}"/>`),
  ].join('')
  return `<svg width="44" height="44" viewBox="0 0 44 44" style="opacity:${opacity}" aria-hidden="true">`
    + `<g ${rot}>${parts}</g></svg>`
}

/** Knots to one decimal, which is what the panel and tooltip show. */
export const kn1 = (v: number | null | undefined): string =>
  (v == null || !Number.isFinite(v)) ? '--' : v.toFixed(1)
