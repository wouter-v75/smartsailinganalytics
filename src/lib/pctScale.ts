// The colour scale for a PERFORMANCE PERCENTAGE — VMG%, BSP_trg%, %Pol.
//
// All three answer the same question: how close to the target are we, where 100
// is on it. So they share one scale, and a colour means the same thing in the
// Starts table as it does in a report row. Before this there were three hard
// steps (>=95 green, >=85 amber, else red) in one component and no colour at all
// on the report tables, so %Pol 96 and %Pol 140 looked alike and nothing below
// 85 was distinguishable from anything else below 85.
//
// NOT for every column with a % on it. UpDfclt% / LwDfclt% are deflections and
// BSP/SOG% is a current reading — they are percentages of something else
// entirely, and painting 92 of them amber would say the boat was slow when it
// was not. `isPctScaleKey` is the allowlist, and it is deliberately short.
//
// The stops are Wouter's, 8 October 2026:
//
//   <= 85  dark red      the boat is a long way off
//      90  red
//      95  yellow
//    97.5  light green   on the number
//   102.5  light green   — a PLATEAU, so normal variation around 100 is one
//     105  green           colour and does not shimmer through three
//  >= 110  dark green
//
// Between stops it interpolates, which is what makes it a scale rather than
// steps: 92 reads as most of the way from red to yellow, and the eye picks up
// the direction of a column without reading the numbers.
//
// The one liberty taken: he wrote ">105 = dark green", and a snap at 105 would
// make 104.9 and 105.1 wildly different for a tenth of a knot. So it darkens
// from green at 105 to full dark green by 110. Change DARK_GREEN_AT to 105 for
// a hard edge.

export interface PctStop {
  pct: number
  hex: string
  /** What this stop is called, for the legend. */
  label?: string
}

const DARK_GREEN_AT = 110

/** Anchors, in order. Anything outside the ends clamps to them. */
export const PCT_STOPS: PctStop[] = [
  { pct: 85, hex: '#7F1D1D', label: 'dark red' },
  { pct: 90, hex: '#DC2626', label: 'red' },
  // #FACC15, not #EAB308: the darker yellow goes OLIVE once it is washed over
  // #0A1929 at any alpha a number can still be read through, and olive between
  // red and green reads as a third hue rather than as caution.
  { pct: 95, hex: '#FACC15', label: 'yellow' },
  { pct: 97.5, hex: '#86EFAC', label: 'light green' },
  { pct: 102.5, hex: '#86EFAC' },
  { pct: 105, hex: '#22C55E', label: 'green' },
  { pct: DARK_GREEN_AT, hex: '#15803D', label: 'dark green' },
]

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x)

function rgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}

const hex2 = (n: number) => Math.round(n).toString(16).padStart(2, '0')

/**
 * The colour for a percentage, as `#rrggbb`.
 *
 * Interpolated in plain RGB. Not a perceptual space — these stops are close
 * enough in lightness that the extra machinery would buy nothing a trimmer
 * could see, and a hex a designer can paste beats a correct-but-opaque one.
 */
export function pctColour(v: number | null | undefined): string | null {
  if (v == null || !Number.isFinite(v)) return null
  const stops = PCT_STOPS
  if (v <= stops[0].pct) return stops[0].hex
  if (v >= stops[stops.length - 1].pct) return stops[stops.length - 1].hex
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i], b = stops[i + 1]
    if (v >= a.pct && v <= b.pct) {
      if (a.hex === b.hex) return a.hex            // the plateau around 100
      const t = clamp01((v - a.pct) / (b.pct - a.pct))
      const [ar, ag, ab] = rgb(a.hex), [br, bg, bb] = rgb(b.hex)
      return `#${hex2(ar + (br - ar) * t)}${hex2(ag + (bg - ag) * t)}${hex2(ab + (bb - ab) * t)}`
    }
  }
  return null
}

/**
 * The same colour as a cell background, i.e. washed out enough to read white
 * monospace numbers on top of it.
 *
 * The alpha is NOT constant. On this dark UI a dark fill recedes, so dark red
 * and dark green — the two ends, the two a trimmer most needs to catch out of
 * the corner of an eye — would be the faintest cells on the table at a uniform
 * 25 %. They get more alpha to compensate, which keeps the ORDER of visual
 * weight matching the order of how much the number matters.
 */
export function pctBg(v: number | null | undefined): string {
  const hexColour = pctColour(v)
  if (!hexColour) return 'transparent'
  const [r, g, b] = rgb(hexColour)
  const d = v == null ? 0 : Math.abs(v - 100)
  // 0.30 on the plateau, rising to 0.70 by the time a number is 15 off and
  // STOPPING there. Two things forced these numbers, both found by rendering
  // the scale and looking at it rather than by reasoning about hex:
  //
  //   a low alpha over #0A1929 turns every stop to mud — yellow went olive and
  //   everything from 97.5 up washed into one green, which is precisely the
  //   distinction being asked for;
  //   and the cap keeps the darkest fills off opaque, so a broken log row at
  //   0 % cannot hide the very number that shows it is broken.
  const alpha = 0.3 + (Math.min(d, 15) / 15) * 0.4
  return `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(3)})`
}

/**
 * Which columns this scale is allowed to paint.
 *
 * `logPolPct` and `logTrgPct` are the same measures computed from the LOG's own
 * polar rather than ours; `bspTrgPct` is the Starts table's name for target.
 * Everything else — deflections, BSP/SOG — is a percentage of something that is
 * not a target, and must not borrow this scale's meaning.
 */
const PCT_SCALE_KEYS = new Set(['vmgPct', 'bspPol', 'bspTrgPct', 'logPolPct', 'logTrgPct'])

export const isPctScaleKey = (key: string): boolean => PCT_SCALE_KEYS.has(key)

/** Stops that carry a name, for drawing a legend. */
export const PCT_LEGEND = PCT_STOPS.filter((s) => s.label)
