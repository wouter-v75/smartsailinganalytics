// src/lib/northstarTarget.ts
// ─────────────────────────────────────────────────────────────────────────────
// Northstar MAINSAIL target shapes — the sailmaker's reference trim, tabulated by
// TWS (6/8/10/14 kn) across the stripe heights (25/50/75/87 %).
//
// Stored in the SAME units as the design shapes (lib/designShapeParse) so the
// SailScan charts/tables can render it through the existing design pipeline
// (interpDesignAtTws + the METRICS dKey/dScale mapping):
//   • camber / draft  → FRACTIONS (0.09 = 9 %); the charts scale them ×100
//   • trailAngle      → degrees. The sheet's column is headed "Exit (-ve)", so the
//     tabled magnitudes are stored NEGATIVE to sit on the same axis as the
//     measured exit angle.
//
// These are the shipped defaults. A boat can override them per-sail — the value
// is read from the mainsail's `specs.northstar_target` when present (edited in
// the SailScan detail view), so updating the numbers never needs a code change.
// ─────────────────────────────────────────────────────────────────────────────

export interface NsSection {
  posPct: number
  camber: number | null // fraction
  draft: number | null // fraction (the sheet's "Posn")
  trailAngle: number | null // degrees, negative (the sheet's "Exit (-ve)")
}
export interface NsCondition {
  tws: number
  sections: NsSection[]
}

export const NS_STRIPES = [25, 50, 75, 87]
export const NS_TWS = [6, 8, 10, 14]

// Row order matches the sheet: Camber · Posn · Exit(-ve), stripes 25/50/75/87.
const row = (tws: number, camber: number[], posn: number[], exit: number[]): NsCondition => ({
  tws,
  sections: NS_STRIPES.map((posPct, i) => ({
    posPct,
    camber: camber[i] != null ? camber[i] / 100 : null,
    draft: posn[i] != null ? posn[i] / 100 : null,
    trailAngle: exit[i] != null ? -Math.abs(exit[i]) : null,
  })),
})

export const NORTHSTAR_MAIN_DEFAULT: NsCondition[] = [
  //       TWS      Camber                    Posn                Exit (-ve)
  row(6, [9, 11, 10.5, 8.5], [44, 43, 42, 41], [13, 17, 15, 13]),
  row(8, [8.5, 10, 9.5, 7.5], [43, 43, 42, 41], [12, 15.5, 14, 11.5]),
  row(10, [7.5, 9.5, 8.5, 6.5], [42, 42, 43, 41], [11, 14, 13, 10]),
  row(14, [6.5, 7.5, 5, 3.5], [45, 47, 46, 45], [10, 14, 10, 6]),
]

// The mainsail's target: its own override if one has been saved, else the default.
export function northstarConditions(sail: any): NsCondition[] {
  const saved = sail?.specs?.northstar_target?.conditions
  return Array.isArray(saved) && saved.length ? (saved as NsCondition[]) : NORTHSTAR_MAIN_DEFAULT
}

// ── editing helpers ──────────────────────────────────────────────────────────
// The editable grid is the sheet's layout: one row per TWS, three metric blocks.
export type NsMetric = 'camber' | 'draft' | 'trailAngle'

export const nsCell = (conds: NsCondition[], tws: number, metric: NsMetric, posPct: number): number | null => {
  const c = conds.find((x) => x.tws === tws)
  const s = c?.sections.find((x) => x.posPct === posPct)
  const v = s ? s[metric] : null
  if (v == null) return null
  // display units: fractions → %, exit → magnitude (the column is "-ve")
  if (metric === 'trailAngle') return Math.abs(v)
  return v * 100
}

// Write a displayed value back into the conditions (inverse of nsCell).
export function nsSetCell(conds: NsCondition[], tws: number, metric: NsMetric, posPct: number, display: string): NsCondition[] {
  const n = display.trim() === '' ? null : Number(display)
  const val = n == null || Number.isNaN(n) ? null : metric === 'trailAngle' ? -Math.abs(n) : n / 100
  return conds.map((c) => {
    if (c.tws !== tws) return c
    return {
      ...c,
      sections: c.sections.map((s) => (s.posPct === posPct ? { ...s, [metric]: val } : s)),
    }
  })
}
