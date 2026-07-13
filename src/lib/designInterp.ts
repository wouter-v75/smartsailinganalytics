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
  sourceCode?: string | null // which sail's design curve was actually used
  substituted?: boolean // true when a different sail's curve was used (scanned sail out of its TWS window)
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

const isMainSail = (sail: any): boolean =>
  sail?.kind === 'mainsail' || designCodeOf(sail?.category || sail?.name) === 'MN'

// Pick the right JIB design by TWS WINDOW: prefer the scanned jib's own design
// when the wind falls inside its design window; otherwise use whichever jib is
// actually designed for that wind (e.g. J1 flown at 20 kn → J3's curve, J1 at
// 11 kn → J1.5's curve). Beyond all windows, clamp to the lightest/heaviest jib.
export function designForJib(sails: any[], scanSail: any, targetTws: number | null): InterpDesign | null {
  if (targetTws == null) return null
  const cands = (sails || [])
    .map((s) => {
      const code = designCodeOf(s?.category || s?.name)
      const conds = selectDesignConditions(s?.specs?.design_shapes, null)
      const tw = conds.map((c: any) => c.tws).filter((x: any) => typeof x === 'number')
      return code && code !== 'MN' && tw.length
        ? { code, conds, min: Math.min(...tw), max: Math.max(...tw) }
        : null
    })
    .filter(Boolean) as { code: string; conds: any[]; min: number; max: number }[]
  if (!cands.length) return null

  const scanCode = designCodeOf(scanSail?.category || scanSail?.name)
  const scanned = cands.find((c) => c.code === scanCode) || null

  // (a) prefer the scanned sail if the wind is within its own design window
  let chosen = scanned && targetTws >= scanned.min && targetTws <= scanned.max ? scanned : null
  // (b) else pick the jib whose window covers this wind (heaviest match if overlapping)
  if (!chosen) {
    const covering = cands.filter((c) => targetTws >= c.min && targetTws <= c.max)
    if (covering.length) chosen = covering.sort((a, b) => b.min - a.min)[0]
  }
  // beyond every window: clamp to the lightest (light air) or heaviest (heavy air) jib
  if (!chosen) {
    const byMin = [...cands].sort((a, b) => a.min - b.min)
    chosen = targetTws < byMin[0].min ? byMin[0] : byMin[byMin.length - 1]
  }

  const out = interpDesignAtTws(chosen.conds, targetTws)
  if (out) {
    out.sourceCode = chosen.code
    out.substituted = !!scanCode && chosen.code !== scanCode
  }
  return out
}

// Single entry point used by the scan view: mains interpolate across their own
// (paired-jib) TWS conditions; jibs pick the design by TWS window across sails.
//
// `sailTypeHint` is the SCAN's own sail_type ('main' | 'headsail'), used when the scan
// hasn't been tagged to an inventory sail yet. Without it an untagged MAIN scan fell
// through to designForJib() and was handed a JIB's design curve — and jib designs stop
// at the 75% stripe, so the main's 87% design row silently vanished from the table and
// the charts. The report tells us it's a main; believe it rather than guessing a jib.
export function pickDesign(
  sails: any[],
  scanSail: any,
  activeJib: string | null,
  targetTws: number | null,
  sailTypeHint?: string | null
): InterpDesign | null {
  // Explicitly tagged sail always wins — the user said what this is.
  if (isMainSail(scanSail)) return designForScan(scanSail, activeJib, targetTws)
  if (scanSail) return designForJib(sails, scanSail, targetTws)

  // Untagged: fall back to what the REPORT says the sail was.
  if (sailTypeHint === 'main') {
    const main = (sails || []).find(isMainSail)
    return main ? designForScan(main, activeJib, targetTws) : null
  }
  return designForJib(sails, scanSail, targetTws)
}
