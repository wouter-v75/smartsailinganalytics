// src/lib/rigTuneParse.ts
// ─────────────────────────────────────────────────────────────────────────────
// Parse a JV76 "Sailing Info Summary" rig tuning sheet (A3 PDF) into structured
// per-sail-combination rig settings. Wide engineering table → we reconstruct
// columns from glyph x-coordinates (see pdfText.extractPdfItems), not flowing
// text, because cells align by position and several header labels span columns.
//
// The sheet has two table blocks, each a grid of sail-combination columns:
//   • UPWIND          — Full Main + J1 / J1.5 / J2 / J3 across rising TWS
//   • REACHING/DOWNWIND — Jib, Jib&GS, MOFO…, BRO…, A2 (A2 = downwind)
//
// For every column we pull the rows requested for the rig baseline:
//   - Approx TWS @ MH        (upwind; reaching/downwind carry a textual "Approx. TWS")
//   - Mastbase Position      (e.g. "6 FWD")
//   - Shim Stack             (e.g. "-18" / "Full")
//   - Mastbase  (RIG LOADS, 000 kg)
//   - Upper Deflector Cylinder Stroke (% retracted)
//   - Lower Deflector Cylinder Stroke (% retracted)
// plus the Mainsail + Headsail labels and the section (upwind/reaching/downwind).
//
// Pure: input is the positioned-item pages, output is plain data. No pdf-parse.
// ─────────────────────────────────────────────────────────────────────────────

export interface RigItem { x: number; y: number; str: string; width?: number }
export interface RigPage { items: RigItem[] }

export interface RigColumn {
  section: 'upwind' | 'reaching' | 'downwind'
  x: number // column centre on the shared grid — reaching sits under the upwind column
  mainsail: string | null
  headsail: string | null
  twsAtMh: string | null // numeric for upwind ("16"); textual for reaching ("Light Wind","35AWA")
  twsMhKn: number | null // TWS @ MH in knots; reaching/downwind inherit it from the aligned upwind column
  rakeDeg: number | null // Rake (°)
  mastbasePosition: string | null // "6 FWD"
  shimStack: string | null // "-18" | "Full"
  mastbaseLoadT: number | null // RIG LOADS Mastbase, 000 kg (tonnes)
  headstayT: number | null // RIG LOADS Headstay, 000 kg
  jibTackT: number | null // TACK LOADS Jib Tack, 000 kg
  mainCunninghamT: number | null // RIG LOADS Main Cunningham, 000 kg
  bowspritTackT: number | null // TACK LOADS Bowsprit Tack, 000 kg (reaching/downwind)
  gsTackT: number | null // TACK LOADS GS (gennaker-staysail) Tack, 000 kg (reaching/downwind)
  upperDeflectorCylStroke: string | null // "% retracted", e.g. "95%"
  lowerDeflectorCylStroke: string | null
}

export interface RigTune {
  revision: string | null
  sheetDate: string | null
  columns: RigColumn[]
}

const X_LABEL_MAX = 280 // anything left of this is a row label / unit, not a value
const X_MAX_LOADS = 1055 // drop the far-right "MAX LOADS" column
const COL_TOL = 40 // px tolerance when binning a value to a column centre
const ROW_TOL = 3 // px bucket when grouping items into a visual row

interface Row { y: number; items: RigItem[] }

function groupRows(items: RigItem[]): Row[] {
  const buckets = new Map<number, RigItem[]>()
  for (const it of items) {
    const key = Math.round(it.y / ROW_TOL) * ROW_TOL
    if (!buckets.has(key)) buckets.set(key, [])
    buckets.get(key)!.push(it)
  }
  return Array.from(buckets.entries())
    .map(([y, its]) => ({ y, items: its.sort((a: RigItem, b: RigItem) => a.x - b.x) }))
    .sort((a, b) => b.y - a.y) // top → bottom (PDF y origin is bottom-left)
}

const labelOf = (r: Row): string => r.items.map((i) => i.str).join(' ').trim()

// Value items = those to the right of the label/unit gutter, left of MAX LOADS.
function valueItems(r: Row): RigItem[] {
  return r.items.filter((i) => i.x >= X_LABEL_MAX && i.x <= X_MAX_LOADS)
}

const num = (s: string): number | null => {
  const v = parseFloat(s.replace(/,/g, ''))
  return Number.isNaN(v) ? null : v
}

// Cluster x positions (1-D) into column centres. Greedy: sorted, split when the
// gap to the previous point exceeds `gap`.
function clusterCentres(xs: number[], gap = 30): number[] {
  if (!xs.length) return []
  const sorted = [...xs].sort((a, b) => a - b)
  const groups: number[][] = [[sorted[0]]]
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - sorted[i - 1] > gap) groups.push([])
    groups[groups.length - 1].push(sorted[i])
  }
  return groups.map((g) => g.reduce((a, b) => a + b, 0) / g.length)
}

// Nearest column index for an x, or -1 if none within tolerance.
function colOf(x: number, centres: number[]): number {
  let best = -1
  let bestD = COL_TOL
  for (let c = 0; c < centres.length; c++) {
    const d = Math.abs(x - centres[c])
    if (d < bestD) { bestD = d; best = c }
  }
  return best
}

// Map a row's values onto the column centres (string per column).
function rowByCol(r: Row | undefined, centres: number[]): (string | null)[] {
  const out: (string | null)[] = new Array(centres.length).fill(null)
  if (!r) return out
  for (const it of valueItems(r)) {
    const c = colOf(it.x, centres)
    if (c >= 0 && out[c] == null) out[c] = it.str.trim()
  }
  return out
}

const find = (rows: Row[], re: RegExp): Row | undefined => rows.find((r) => re.test(labelOf(r)))

// The "Cylinder Stroke" row that sits just below a given section banner
// (UPPER DEFLECTOR / LOWER DEFLECTOR), found by y position.
function strokeRowUnder(rows: Row[], bannerRe: RegExp): Row | undefined {
  // Match the real section banner ("UPPER DEFLECTOR  Setup deflector length …"),
  // not the small cylinder-reference table at the top of the page ("Upper
  // Deflector 340 3 …"), which lacks the "Setup deflector" caption.
  const banner = rows.find((r) => bannerRe.test(labelOf(r)) && /Setup\s+deflector/i.test(labelOf(r)))
  if (!banner) return undefined
  return rows
    .filter((r) => r.y < banner.y && /Cylinder\s+Stroke/i.test(labelOf(r)))
    .sort((a, b) => b.y - a.y)[0]
}

// Split header labels that merged into one run ("MOFO & GS   MOF0 & GS") and
// spread them across the columns they cover, so each column gets its own label.
function headsailLabels(headsailRow: Row | undefined, centres: number[]): (string | null)[] {
  const out: (string | null)[] = new Array(centres.length).fill(null)
  if (!headsailRow) return out
  // Nearest column to an x, ignoring the tolerance cap (header runs sit a little
  // left of their first column).
  const nearestCol = (x: number): number => {
    let best = 0
    for (let c = 1; c < centres.length; c++) if (Math.abs(x - centres[c]) < Math.abs(x - centres[best])) best = c
    return best
  }
  for (const it of headsailRow.items) {
    if (it.x < X_LABEL_MAX) continue // skip the "Headsail" row label
    // PDF often merges 2–3 column headers into one run with 2+ spaces between
    // them ("BRO & J1    BRO & J3 & GS  BRO & J3 & GS"); single-space gaps inside
    // a label ("Jib & GS") stay intact.
    const parts = it.str.split(/\s{2,}/).map((p) => p.trim()).filter(Boolean)
    let col = nearestCol(it.x)
    for (const p of parts) {
      while (col < out.length && out[col] != null) col++ // next free column
      if (col < out.length) out[col] = p
      col++
    }
  }
  return out
}

// Parse one table block (a page that has a Headsail row).
function parseBlock(rows: Row[]): RigColumn[] {
  const headsailRow = find(rows, /^Headsail\b/i)
  if (!headsailRow) return []
  const mainsailRow = find(rows, /^Mainsail\b/i)
  const typeRow = find(rows, /\b(UPWIND|REACHING|DOWNWIND)\b/i)

  const twsRow = find(rows, /Approx\.?\s*TWS\s*@\s*MH/i) || find(rows, /^Approx\.\s*TWS\b/i)
  const rakeRow = find(rows, /^Rake\b/i)
  const mbPosRow = find(rows, /^Mastbase Position\b/i)
  const shimRow = find(rows, /^Shim Stack\b/i)
  // RIG LOADS "Mastbase" (000 kg) — the bare "Mastbase" row, not "...Position".
  const mbLoadRow = rows.find((r) => /^Mastbase\b/i.test(labelOf(r)) && /000\s*kg/i.test(labelOf(r)))
  const headstayRow = find(rows, /^Headstay\b/i)
  const jibTackRow = find(rows, /^Jib Tack\b/i)
  const mainCunnRow = find(rows, /^Main Cunningham\b/i)
  const bowspritRow = find(rows, /^Bowsprit Tack\b/i)
  const gsTackRow = find(rows, /^G\s*\/?\s*S\s+Tack\b/i) || find(rows, /Gennaker\s+Staysail\s+Tack/i)
  const upperStrokeRow = strokeRowUnder(rows, /UPPER\s+DEFLECTOR/i)
  const lowerStrokeRow = strokeRowUnder(rows, /LOWER\s+DEFLECTOR/i)

  // Column centres from the dense, one-token-per-column anchor rows.
  const anchorXs: number[] = []
  for (const r of [mbPosRow, shimRow, mbLoadRow]) {
    if (r) for (const it of valueItems(r)) anchorXs.push(it.x)
  }
  const centres = clusterCentres(anchorXs)
  if (!centres.length) return []

  const mains = rowByCol(mainsailRow, centres)
  const heads = headsailLabels(headsailRow, centres)
  const tws = rowByCol(twsRow, centres)
  const rake = rowByCol(rakeRow, centres)
  const mbPos = rowByCol(mbPosRow, centres)
  const shim = rowByCol(shimRow, centres)
  const mbLoad = rowByCol(mbLoadRow, centres)
  const headstay = rowByCol(headstayRow, centres)
  const jibTack = rowByCol(jibTackRow, centres)
  const mainCunn = rowByCol(mainCunnRow, centres)
  const bowsprit = rowByCol(bowspritRow, centres)
  const gsTack = rowByCol(gsTackRow, centres)
  const upper = rowByCol(upperStrokeRow, centres)
  const lower = rowByCol(lowerStrokeRow, centres)

  // Section per column: split reaching vs downwind by the DOWNWIND banner x.
  let downwindX = Infinity
  if (typeRow) {
    const dw = typeRow.items.find((i) => /DOWNWIND/i.test(i.str))
    if (dw) downwindX = dw.x - 30
  }
  const isUpwind = !!typeRow && /UPWIND/i.test(labelOf(typeRow))

  const cols: RigColumn[] = []
  for (let c = 0; c < centres.length; c++) {
    // skip empty columns (no data at all)
    if (!mbPos[c] && !shim[c] && !mbLoad[c] && !tws[c] && !heads[c]) continue
    const section: RigColumn['section'] = isUpwind ? 'upwind' : centres[c] >= downwindX ? 'downwind' : 'reaching'
    cols.push({
      section,
      x: centres[c],
      mainsail: mains[c],
      headsail: heads[c],
      twsAtMh: tws[c],
      twsMhKn: null, // filled by backfillTws() once every block is parsed
      rakeDeg: rake[c] != null ? num(rake[c]!) : null,
      mastbasePosition: mbPos[c],
      shimStack: shim[c],
      mastbaseLoadT: mbLoad[c] != null ? num(mbLoad[c]!) : null,
      headstayT: headstay[c] != null ? num(headstay[c]!) : null,
      jibTackT: jibTack[c] != null ? num(jibTack[c]!) : null,
      mainCunninghamT: mainCunn[c] != null ? num(mainCunn[c]!) : null,
      bowspritTackT: bowsprit[c] != null ? num(bowsprit[c]!) : null,
      gsTackT: gsTack[c] != null ? num(gsTack[c]!) : null,
      upperDeflectorCylStroke: upper[c],
      lowerDeflectorCylStroke: lower[c],
    })
  }
  return cols
}

function parseMeta(pages: RigPage[]): { revision: string | null; sheetDate: string | null } {
  // The revision table on page 1: "P3   10-Jun-26   Jarrad   Compete summary…"
  const rows = pages.length ? groupRows(pages[0].items) : []
  let revision: string | null = null
  let sheetDate: string | null = null
  for (const r of rows) {
    const t = labelOf(r)
    const m = t.match(/\b(P\d+)\b\s+(\d{1,2}-[A-Za-z]{3}-\d{2})/)
    if (m) { revision = m[1]; sheetDate = m[2] } // keep the last (highest) revision row
  }
  return { revision, sheetDate }
}

export function parseRigTune(pages: RigPage[]): RigTune {
  const meta = parseMeta(pages)
  const columns: RigColumn[] = []
  for (const page of pages) {
    const rows = groupRows(page.items)
    if (!find(rows, /^Headsail\b/i)) continue // not a table page
    columns.push(...parseBlock(rows))
  }
  backfillTws(columns)
  return { revision: meta.revision, sheetDate: meta.sheetDate, columns }
}

// A real TWS in knots: the reaching/downwind "Approx. TWS" cells carry text like
// "Light Wind", "Uprange" or "35AWA" (an apparent-wind ANGLE) — never read those
// as a wind speed.
function twsKn(s: string | null): number | null {
  if (s == null) return null
  const t = String(s).trim()
  if (/awa/i.test(t)) return null
  const m = t.match(/^(\d+(?:\.\d+)?)/)
  return m ? Number(m[1]) : null
}

// The REACHING/DOWNWIND block is a continuation of the UPWIND table — the blocks
// share one column grid (same x centres), so a reaching column carries the TWS of
// the upwind column it sits under. Backfill `twsMhKn` accordingly: upwind columns
// use their own "Approx TWS @ MH", the rest inherit from the x-aligned upwind one.
function backfillTws(columns: RigColumn[]): void {
  const upwind = columns.filter((c) => c.section === 'upwind')
  for (const c of columns) {
    const own = twsKn(c.twsAtMh)
    if (c.section === 'upwind' || own != null) { c.twsMhKn = own; continue }
    let best: RigColumn | null = null; let bd = Infinity
    for (const u of upwind) {
      const d = Math.abs(u.x - c.x)
      if (d < bd) { bd = d; best = u }
    }
    c.twsMhKn = best && bd <= COL_TOL ? twsKn(best.twsAtMh) : null
  }
}
