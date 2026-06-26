// src/lib/designShapeParse.ts
// ─────────────────────────────────────────────────────────────────────────────
// Parse the North "Target sail shapes" design CSV (e.g. Target_sailshapes_KG2026)
// into structured per-section design target shapes.
//
// Format: European CSV — ';' delimiter, ',' decimal, CRLF lines. The sheet is a
// stack of TWS blocks separated by blank rows. Each block lays 8 panels side by
// side (Main + Jib pairs): MN | J1 | MN | J15 | MN | J2 | MN | J3, each panel
// 14 columns wide. The same MN model (MN_v5-9 = "MN A 2026") is given a distinct
// target per (TWS, paired jib).
//
// Per panel, columns are: Sec.#, TWS, condition-name, then 10 metrics
//   front-% · draft · camber · back-% · lead-% · trail-% · Lead Angle ·
//   Twist · Trail Angle · Section Angle.
// Rows within a block are horizontal sections; the TWS + name appear on the top
// section only and carry down. Section number → height %:
//   0→0(foot) · 2→25 · 4→50 · 6→75 · 7→87 · 8→100(head). Jibs stop at 6 (75%).
// ─────────────────────────────────────────────────────────────────────────────

export interface DesignShapeRow {
  sail: string // 'MN' | 'J1' | 'J1.5' | 'J2' | 'J3'
  pairedJib: string | null // for MN: the jib this target is paired with
  tws: number | null
  conditionName: string | null // e.g. "6TWS_J1_HelIN_v3d"
  section: number // raw section number (0,2,4,6,7,8)
  posPct: number | null // height %: 0/25/50/75/87/100
  frontPct: number | null
  draft: number | null
  camber: number | null
  backPct: number | null
  leadPct: number | null
  trailPct: number | null
  leadAngle: number | null
  twist: number | null
  trailAngle: number | null
  sectionAngle: number | null
}

export interface ParsedDesignShapes {
  rows: DesignShapeRow[]
  sails: string[]
  twsValues: number[]
}

const PANEL_W = 14 // columns per panel
const N_PANELS = 8
const SEC_POS: Record<number, number> = { 0: 0, 2: 25, 4: 50, 6: 75, 7: 87, 8: 100 }

const num = (s: string | undefined): number | null => {
  if (s == null || s.trim() === '') return null
  const v = parseFloat(s.replace(/\s/g, '').replace(',', '.'))
  return Number.isNaN(v) ? null : v
}

// Map a panel header label / condition name to a canonical sail code.
function sailFromLabel(label: string): string | null {
  const s = (label || '').toUpperCase()
  if (/\bMN\b|MN_|MAIN/.test(s)) return 'MN'
  if (/J15|J1\.5/.test(s)) return 'J1.5'
  if (/J1\b|J1_/.test(s)) return 'J1'
  if (/J2\b|J2_|J2-/.test(s)) return 'J2'
  if (/J3\b|J3_|J3-/.test(s)) return 'J3'
  return null
}
// The jib a condition name refers to (e.g. "6TWS_J15_HelIN" → J1.5).
function jibFromName(name: string | null): string | null {
  if (!name) return null
  const m = name.toUpperCase().match(/J15|J1|J2|J3/)
  if (!m) return null
  return m[0] === 'J15' ? 'J1.5' : m[0]
}

const isHeaderLine = (l: string): boolean => /Horizontal Sections/i.test(l)
const isColsLine = (l: string): boolean => /front-%/i.test(l) && /draft/i.test(l)
const isDataLine = (l: string): boolean => /Sec\.#/.test(l)

export function parseDesignShapes(text: string): ParsedDesignShapes {
  const lines = (text || '').replace(/\r/g, '').split('\n')
  const rows: DesignShapeRow[] = []

  let i = 0
  while (i < lines.length) {
    if (!isHeaderLine(lines[i])) { i++; continue }
    // Header line → per-panel sail labels (label sits in each panel's name column).
    const hdr = lines[i].split(';')
    const labels: (string | null)[] = []
    for (let k = 0; k < N_PANELS; k++) labels[k] = sailFromLabel(hdr[3 + k * PANEL_W] || '')
    i++
    if (i < lines.length && isColsLine(lines[i])) i++ // skip the column-name row

    // Carry TWS + condition name down each panel within this block.
    const panelTws: (number | null)[] = new Array(N_PANELS).fill(null)
    const panelName: (string | null)[] = new Array(N_PANELS).fill(null)

    while (i < lines.length && isDataLine(lines[i])) {
      const c = lines[i].split(';')
      for (let k = 0; k < N_PANELS; k++) {
        if (!labels[k]) continue
        const base = 1 + k * PANEL_W
        const secCell = c[base]
        if (!secCell || !/Sec\.#/.test(secCell)) continue
        const section = parseInt(secCell.replace(/[^0-9]/g, ''), 10)
        if (Number.isNaN(section)) continue
        const twsCell = num(c[base + 1])
        if (twsCell != null) panelTws[k] = twsCell
        const nameCell = (c[base + 2] || '').trim()
        if (nameCell) panelName[k] = nameCell
        const sail = labels[k]!
        rows.push({
          sail,
          pairedJib: sail === 'MN' ? jibFromName(panelName[k]) : sail,
          tws: panelTws[k],
          conditionName: panelName[k],
          section,
          posPct: SEC_POS[section] ?? null,
          frontPct: num(c[base + 3]),
          draft: num(c[base + 4]),
          camber: num(c[base + 5]),
          backPct: num(c[base + 6]),
          leadPct: num(c[base + 7]),
          trailPct: num(c[base + 8]),
          leadAngle: num(c[base + 9]),
          twist: num(c[base + 10]),
          trailAngle: num(c[base + 11]),
          sectionAngle: num(c[base + 12]),
        })
      }
      i++
    }
  }

  // The sheet repeats some boundary conditions across adjacent blocks (identical
  // values) — keep one per (sail, paired jib, TWS, section).
  const seen = new Set<string>()
  const deduped = rows.filter((r) => {
    const key = `${r.sail}|${r.pairedJib}|${r.tws}|${r.section}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  const sails = Array.from(new Set(deduped.map((r) => r.sail)))
  const twsValues = Array.from(new Set(deduped.map((r) => r.tws).filter((t): t is number => t != null))).sort((a, b) => a - b)
  return { rows: deduped, sails, twsValues }
}
