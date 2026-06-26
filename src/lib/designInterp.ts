// src/lib/designInterp.ts
// ─────────────────────────────────────────────────────────────────────────────
// Pick the right DESIGN target shape for a SailScan and interpolate it to the
// measured TWS, so it can be overlaid on the scan (table + grey chart lines).
//
// Selection preference (per Wouter): (a) the sail — Main design for the main,
// the jib's design for that jib; (b) TWS — linearly interpolate between the two
// bracketing design conditions, clamped to the design's TWS window if the sail
// was used outside it. For the Main (whose targets are keyed by paired jib),
// prefer the jib that was actually up; otherwise one target per TWS.
// ─────────────────────────────────────────────────────────────────────────────

export interface DesignSectionVals {
  posPct: number
  draft: number | null
  camber: number | null
  twist: number | null
  frontPct: number | null
  backPct: number | null
  leadPct: number | null
  trailPct: number | null
  leadAngle: number | null
  trailAngle: number | null
  sectionAngle: number | null
}

export interface InterpDesign {
  sections: DesignSectionVals[] // head-first (highest posPct first)
  tws: number // clamped TWS used
  requestedTws: number
  clamped: boolean
  twsMin: number
  twsMax: number
}

const METRIC_KEYS: (keyof DesignSectionVals)[] = [
  'draft', 'camber', 'twist', 'frontPct', 'backPct', 'leadPct', 'trailPct', 'leadAngle', 'trailAngle', 'sectionAngle',
]

// Normalise a hoisted-sail name ("J1.5_2026") to a design code ("J1.5").
export const designCodeOf = (name: string | null | undefined): string | null => {
  if (!name) return null
  const c = name.replace(/_\d{4}$/, '').trim().toUpperCase()
  if (/^MAIN|^MN/.test(c)) return 'MN'
  if (/^J15|^J1\.5/.test(c)) return 'J1.5'
  const m = c.match(/^J\d/)
  return m ? m[0] : null
}

// Choose which conditions to use. Jib sails have one pairing; the Main has many
// (per jib) → filter to the active jib if present, else one per TWS.
export function selectDesignConditions(design: any, activeJib: string | null): any[] {
  const conds: any[] = Array.isArray(design?.conditions) ? design.conditions : []
  if (!conds.length) return []
  const jibs = new Set(conds.map((c) => c.pairedJib))
  if (jibs.size <= 1) return conds
  if (activeJib && conds.some((c) => c.pairedJib === activeJib)) return conds.filter((c) => c.pairedJib === activeJib)
  const byTws: Record<string, any> = {}
  for (const c of conds) if (!(String(c.tws) in byTws)) byTws[String(c.tws)] = c
  return Object.values(byTws)
}

export function interpDesignAtTws(conditions: any[], targetTws: number): InterpDesign | null {
  const conds = (conditions || []).filter((c) => typeof c.tws === 'number' && Array.isArray(c.sections)).sort((a, b) => a.tws - b.tws)
  if (!conds.length || !Number.isFinite(targetTws)) return null
  const twsMin = conds[0].tws
  const twsMax = conds[conds.length - 1].tws
  const clamped = targetTws < twsMin || targetTws > twsMax
  const t = Math.max(twsMin, Math.min(twsMax, targetTws))

  let lo = conds[0], hi = conds[conds.length - 1]
  for (let i = 0; i < conds.length - 1; i++) {
    if (t >= conds[i].tws && t <= conds[i + 1].tws) { lo = conds[i]; hi = conds[i + 1]; break }
  }
  const frac = hi.tws === lo.tws ? 0 : (t - lo.tws) / (hi.tws - lo.tws)

  const posSet = Array.from(new Set(conds.flatMap((c) => c.sections.map((s: any) => s.posPct)).filter((p: any) => p != null)))
    .sort((a: any, b: any) => b - a) // head-first
  const secAt = (cond: any, pos: number) => cond.sections.find((s: any) => s.posPct === pos)

  const sections: DesignSectionVals[] = posSet.map((pos: any) => {
    const sl = secAt(lo, pos), sh = secAt(hi, pos)
    const out: any = { posPct: pos }
    for (const k of METRIC_KEYS) {
      const a = sl?.[k], b = sh?.[k]
      out[k] = a != null && b != null ? a + (b - a) * frac : (a != null ? a : b != null ? b : null)
    }
    return out as DesignSectionVals
  })

  return { sections, tws: t, requestedTws: targetTws, clamped, twsMin, twsMax }
}

// Convenience: given the scan's inventory sail + the active jib + target TWS,
// return the interpolated design (or null).
export function designForScan(sail: any, activeJib: string | null, targetTws: number | null): InterpDesign | null {
  const design = sail?.specs?.design_shapes
  if (!design || targetTws == null) return null
  const conds = selectDesignConditions(design, activeJib)
  return interpDesignAtTws(conds, targetTws)
}
