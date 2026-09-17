// Two facts about a dot on a phase plot, told two ways.
//
// WHICH TACK it was sailed on is a COLOUR — port light blue, starboard the chart's own
// colour — because that is the split people read first and colour is what the eye sorts
// fastest.
//
// WHICH SECTION it came from is a SHAPE. Sections are a comparison ("this beat against
// that one"), and if both facts were colours the plot would need six colours times two
// tacks and nobody could hold that. A shape survives being small, being printed, and
// being looked at by somebody who does not see colour well — which matters here,
// because the shape carries the thing being compared.

export const SECTION_SYMBOLS = ['circle', 'triangle', 'square', 'diamond', 'cross', 'star'] as const
export type SymbolKind = typeof SECTION_SYMBOLS[number]

// A phase with no section — the whole day, or a stretch outside every section — is a
// circle, which is what the plot has always drawn.
export function symbolFor(sectionN: number | null | undefined): SymbolKind {
  if (!sectionN || sectionN < 1) return 'circle'
  return SECTION_SYMBOLS[(sectionN - 1) % SECTION_SYMBOLS.length]
}

const round = (n: number) => Number(n.toFixed(2))

// One SVG path per shape, centred on (cx, cy) and sized so every shape covers roughly
// the same area — a square drawn to the same radius as a circle reads as bigger, and a
// plot where one section's dots look heavier than another's is a plot that argues.
export function symbolPath(kind: SymbolKind, cx: number, cy: number, r: number): string {
  const x = round(cx), y = round(cy)
  switch (kind) {
    case 'triangle': {
      const h = r * 1.25
      return `M${round(x)},${round(y - h)} L${round(x + h * 0.92)},${round(y + h * 0.7)} L${round(x - h * 0.92)},${round(y + h * 0.7)} Z`
    }
    case 'square': {
      const s = r * 0.9
      return `M${round(x - s)},${round(y - s)} H${round(x + s)} V${round(y + s)} H${round(x - s)} Z`
    }
    case 'diamond': {
      const d = r * 1.3
      return `M${round(x)},${round(y - d)} L${round(x + d)},${y} L${round(x)},${round(y + d)} L${round(x - d)},${y} Z`
    }
    case 'cross': {
      const a = r * 1.25, w = r * 0.42
      return `M${round(x - w)},${round(y - a)} H${round(x + w)} V${round(y - w)} H${round(x + a)} V${round(y + w)} `
        + `H${round(x + w)} V${round(y + a)} H${round(x - w)} V${round(y + w)} H${round(x - a)} V${round(y - w)} H${round(x - w)} Z`
    }
    case 'star': {
      const outer = r * 1.45, inner = r * 0.62
      const pts: string[] = []
      for (let i = 0; i < 10; i++) {
        const rad = i % 2 ? inner : outer
        const ang = (Math.PI / 5) * i - Math.PI / 2
        pts.push(`${round(x + rad * Math.cos(ang))},${round(y + rad * Math.sin(ang))}`)
      }
      return `M${pts.join(' L')} Z`
    }
    case 'circle':
    default:
      // Two arcs: a circle as a path, so every marker is the same element type.
      return `M${round(x - r)},${y} a${round(r)},${round(r)} 0 1,0 ${round(r * 2)},0 a${round(r)},${round(r)} 0 1,0 ${round(-r * 2)},0 Z`
  }
}

export const symbolLabel: Record<SymbolKind, string> = {
  circle: 'Circle', triangle: 'Triangle', square: 'Square',
  diamond: 'Diamond', cross: 'Cross', star: 'Star',
}
