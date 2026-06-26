// src/lib/sailScanParse.ts
// ─────────────────────────────────────────────────────────────────────────────
// Parse SailScan trim-stripe reports (already extracted to spaced text via
// pdfText.extractPdfText) into structured scans for the sail_scans table.
//
// Three report layouts are supported, auto-detected:
//
//  1. north-app  — the new North Sails phone-app export (single A4 page):
//        Sail: <name>
//        Image: <file>  Image Time: 2026-06-23 15:38:40
//        Stripe Draft Camber Entry Exit Front% Back%
//        75% 41.3 13.7 33 -21 81.1 71.5
//        …
//        TWS 9
//     One scan. No Twist column.
//
//  2. thesailcloud-relative (single sail) — the older sailscan.thesailcloud.com
//     "Onboard Sail (Relative)" PDF. Header table (Image/Date/Tags/Sails) then
//     one section per metric (Camber [%], Draft [%], Twist [°], Fore Camber [%],
//     Back Camber [%], Entry Angle [°], Exit Angle [°]); each section lists the
//     75/50/25 values. One scan.
//
//  3. thesailcloud-relative (two sails) — same layout but every metric section
//     has TWO value columns (two overlaid scans), plus a "Generic Measurements"
//     table (TWA/TWS/AWA/BSP per image). → TWO scans, one per column.
//
// All layouts normalise to the same ParsedStripe / ParsedScan shape so the API
// route can insert one sail_scans row per scan. Pure + dependency-free.
// ─────────────────────────────────────────────────────────────────────────────

export interface ParsedStripe {
  pos: number // stripe height %: 75 foot / 50 mid / 25 head
  draft: number | null
  camber: number | null
  twist: number | null
  entry: number | null
  exit: number | null
  fore: number | null // fore (front) camber %
  back: number | null // back camber %
}

export type SailType = 'main' | 'headsail' | null

export interface ParsedScan {
  source: 'north' | 'thesailcloud'
  format: 'north-app' | 'north-sailscan' | 'thesailcloud-relative'
  sailName: string | null // best-effort sail code/name from the report
  sailType: SailType // main | headsail (jib) — from the sail/image name
  sailCode: string | null // North "Code:" (e.g. "J1.5 A", "MN A 2026")
  oeNumber: string | null // North order number "OE#:" (e.g. "ODE17508-002")
  imageName: string | null // full image / capture name — richest identifier
  capturedAt: string | null // ISO 8601 UTC — the report's local stamp converted to UTC
  capturedLocal: string | null // the report's wall-clock stamp as written (no zone)
  tags: string | null
  venue: string | null
  event: string | null
  tws: number | null
  twa: number | null
  awa: number | null
  bsp: number | null
  // measured rig loads at capture (NS Sailscan report only)
  forestayT: number | null
  rakeDeg: number | null
  jibTackT: number | null
  stripes: ParsedStripe[]
  summary: { maxCamberPct: number | null; draftPositionPct: number | null }
}

export interface ParsedReport {
  format: 'north-app' | 'north-sailscan' | 'thesailcloud-relative' | 'unknown'
  scans: ParsedScan[]
}

export interface ParseOpts {
  // IANA zone the report's date/time column is recorded in. SailScan stamps
  // capture time in venue-local time; Northstar venues are CET/CEST, so we
  // default to Europe/Oslo. Override per-report if a venue is elsewhere.
  tz?: string
}

const DEFAULT_TZ = 'Europe/Oslo'

const num = (s: string | undefined | null): number | null => {
  if (s == null) return null
  const v = parseFloat(String(s).replace(',', '.'))
  return Number.isNaN(v) ? null : v
}

// Deepest camber + the draft % at that stripe → quick summary for list views.
function summarise(stripes: ParsedStripe[]): { maxCamberPct: number | null; draftPositionPct: number | null } {
  let maxCamberPct: number | null = null
  let draftPositionPct: number | null = null
  for (const s of stripes) {
    if (s.camber != null && (maxCamberPct === null || s.camber > maxCamberPct)) {
      maxCamberPct = s.camber
      draftPositionPct = s.draft
    }
  }
  return { maxCamberPct, draftPositionPct }
}

// Pull a TWS estimate out of a free-text tag string like "15-16Kn TWS" or
// "6-7Kn TWS" → midpoint; "9Kn" → 9.
function twsFromTags(tags: string | null): number | null {
  if (!tags) return null
  const range = tags.match(/(\d+(?:[.,]\d+)?)\s*-\s*(\d+(?:[.,]\d+)?)\s*kn/i)
  if (range) return (num(range[1])! + num(range[2])!) / 2
  const single = tags.match(/(\d+(?:[.,]\d+)?)\s*kn/i)
  if (single) return num(single[1])
  return null
}

// Best-effort sail code from an image / capture name (e.g. "J1.5 2024_First…"
// → "J1.5", "A2 light" → "A2").
function sailCodeFromName(name: string | null): string | null {
  if (!name) return null
  const m = name.match(/^\s*([A-Za-z]+\d+(?:\.\d+)?)/)
  return m ? m[1] : name.split(/[_\s]/)[0] || null
}

const pad2 = (n: number): string => String(n).padStart(2, '0')

// Offset (ms) of an IANA zone at a given UTC instant, via Intl — DST-aware and
// independent of the server's own timezone.
function tzOffsetMs(atUtcMs: number, tz: string): number {
  const d = new Date(atUtcMs)
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
  const p: Record<string, string> = {}
  for (const part of dtf.formatToParts(d)) p[part.type] = part.value
  let hour = +p.hour
  if (hour === 24) hour = 0
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, hour, +p.minute, +p.second)
  return asUTC - atUtcMs
}

// Interpret Y/M/D h:m:s as wall-clock time in `tz` and return the UTC instant.
function wallClockToUtcMs(Y: number, Mo: number, D: number, h: number, mi: number, s: number, tz: string): number {
  const guess = Date.UTC(Y, Mo - 1, D, h, mi, s)
  return guess - tzOffsetMs(guess, tz)
}

// Parse a report date (+ optional time) string into both the raw local
// wall-clock (as written) and the UTC ISO instant. Time defaults to local noon
// when the report only carries a date (or a truncated one).
function parseStamp(dateStr: string | null, timeStr: string | null, tz: string): { utc: string | null; local: string | null } {
  if (!dateStr) return { utc: null, local: null }
  const dm = dateStr.match(/(\d{4})-(\d{2})-(\d{2})/)
  if (!dm) return { utc: null, local: null }
  const Y = +dm[1], Mo = +dm[2], D = +dm[3]
  let h = 12, mi = 0, s = 0
  if (timeStr) {
    const tm = timeStr.match(/(\d{2}):(\d{2})(?::(\d{2}))?/)
    if (tm) { h = +tm[1]; mi = +tm[2]; s = tm[3] ? +tm[3] : 0 }
  }
  const local = `${dm[1]}-${dm[2]}-${dm[3]}T${pad2(h)}:${pad2(mi)}:${pad2(s)}`
  const utcMs = wallClockToUtcMs(Y, Mo, D, h, mi, s, tz)
  return { utc: Number.isNaN(utcMs) ? null : new Date(utcMs).toISOString(), local }
}

// main | headsail (jib) from the sail/image name. Jibs/headsails are coded with
// a leading "J" (J1, J1.5, J2, J0…); Northstar72 mains are coded "IMN…", others
// "M"/"GM"/"Main".
function classifySailType(name: string | null): SailType {
  if (!name) return null
  const s = name.trim()
  if (/^imn/i.test(s) || /^(gm|m)\d/i.test(s) || /^main/i.test(s) || /\bmain(sail)?\b/i.test(s)) return 'main'
  if (/^j/i.test(s) || /\b(jib|genoa|headsail|staysail)\b/i.test(s)) return 'headsail'
  return null
}

// Normalise for prefix matching: lowercase, drop spaces and trailing ellipsis.
const norm = (s: string): string => s.toLowerCase().replace(/\.+$/, '').replace(/\s+/g, '')

// Length of the shared leading run between two normalised strings.
function commonPrefixLen(a: string, b: string): number {
  const n = Math.min(a.length, b.length)
  let i = 0
  while (i < n && a[i] === b[i]) i++
  return i
}

// ── Format detection ─────────────────────────────────────────────────────────
export function detectFormat(text: string): ParsedReport['format'] {
  if (/SailScan:\s*Onboard\s+Sail/i.test(text) || /thesailcloud/i.test(text) || /Draft\s+Stripes/i.test(text)) {
    return 'thesailcloud-relative'
  }
  if (/Image\s*Time:/i.test(text) || /Stripe\s+Draft\s+Camber/i.test(text)) {
    return 'north-app'
  }
  return 'unknown'
}

// ── North formats (header-aware) ─────────────────────────────────────────────
// Handles both North inputs going forward:
//   • NS App input  — "Stripe Draft Camber Entry Exit Front% Back%" (no Twist)
//   • NS Sailscan   — "Stripe Draft Camber Twist Entry Exit Front% Back%" plus a
//     Head twist row, an 87% main stripe, and rig loads (TWS/FORESTAY/RAKE/JIB
//     TACK T) + OE#/Code metadata.
// The metric column order is read from the header line, so a stripe row's values
// map to the right fields regardless of whether Twist is present.

// header token → ParsedStripe field
const NORTH_COL_FIELD: Record<string, keyof ParsedStripe> = {
  draft: 'draft', camber: 'camber', twist: 'twist', entry: 'entry', exit: 'exit',
  front: 'fore', frontpct: 'fore', fore: 'fore', back: 'back', backpct: 'back',
}

function parseNorthApp(text: string, tz: string): ParsedScan[] {
  const lines = text.split('\n')

  // Header: "Stripe Draft Camber [Twist] Entry Exit Front% Back%" → field order.
  let cols: (keyof ParsedStripe)[] = []
  const headerLine = lines.find((l) => /\bStripe\b\s+Draft\b/i.test(l))
  if (headerLine) {
    const toks = headerLine.replace(/.*\bStripe\b\s*/i, '').trim().split(/\s+/)
    cols = toks.map((t) => NORTH_COL_FIELD[t.toLowerCase().replace(/%/g, 'pct').replace(/[^a-z]/g, '')]).filter(Boolean) as (keyof ParsedStripe)[]
  }
  const hasTwist = cols.includes('twist')

  // Stripe rows: pos% then the numeric values, mapped by the header column order.
  const byPos = new Map<number, ParsedStripe>()
  const rowRe = /^\s*(87|75|50|25)\s*%\s+(.+)$/
  for (const line of lines) {
    const m = line.match(rowRe)
    if (!m) continue
    const pos = num(m[1])!
    if (byPos.has(pos)) continue
    const vals = (m[2].match(/-?\d+(?:\.\d+)?/g) || []).map((v) => num(v))
    const stripe: ParsedStripe = { pos, draft: null, camber: null, twist: null, entry: null, exit: null, fore: null, back: null }
    const set = stripe as unknown as Record<string, number | null>
    const order = cols.length ? cols : (['draft', 'camber', 'entry', 'exit', 'fore', 'back'] as (keyof ParsedStripe)[])
    order.forEach((f, i) => { if (i < vals.length) set[f as string] = vals[i] })
    byPos.set(pos, stripe)
  }
  const stripes = Array.from(byPos.values()).sort((a, b) => a.pos - b.pos)
  if (!stripes.length) return []

  // Metadata + loads.
  const twsM = text.match(/\bTWS\s+(-?\d+(?:[.,]\d+)?)/i)
  const foreM = text.match(/\bFORESTAY\s+(-?\d+(?:[.,]\d+)?)/i)
  const rakeM = text.match(/\bRAKE\s+(-?\d+(?:[.,]\d+)?)/i)
  const jibTkM = text.match(/\bJIB\s*TACK\s*T\s+(-?\d+(?:[.,]\d+)?)/i)
  const sailM = text.match(/\bSail:\s*(\S.*?)\s*(?:Code:|Image:|Image\s+Time:|\n|$)/i)
  const codeM = text.match(/\bCode:\s*(\S.*?)\s*(?:Image:|\n|$)/i)
  const oeM = text.match(/\bOE#:\s*(\S+)/i)
  const imgM = text.match(/\bImage:\s*(\S+)/i)
  const timeM = text.match(/Image\s*Time:\s*(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)/i)

  const sailName = sailM ? sailM[1].trim() : null
  const sailCode = codeM ? codeM[1].trim() : null
  const imageName = imgM ? imgM[1] : null
  const stamp = parseStamp(timeM ? timeM[1] : null, timeM ? timeM[2] : null, tz)
  // NS Sailscan reports carry the richer metadata (OE#/Code/loads); the simpler
  // app export does not.
  const isSailscan = !!(oeM || codeM || foreM || rakeM || hasTwist)

  return [
    {
      source: 'north',
      format: isSailscan ? 'north-sailscan' : 'north-app',
      sailName,
      sailType: classifySailType(sailName) || classifySailType(sailCode) || classifySailType(imageName),
      sailCode,
      oeNumber: oeM ? oeM[1].trim() : null,
      imageName,
      capturedAt: stamp.utc,
      capturedLocal: stamp.local,
      tags: null,
      venue: null,
      event: null,
      tws: twsM ? num(twsM[1]) : null,
      twa: null,
      awa: null,
      bsp: null,
      forestayT: foreM ? num(foreM[1]) : null,
      rakeDeg: rakeM ? num(rakeM[1]) : null,
      jibTackT: jibTkM ? num(jibTkM[1]) : null,
      stripes,
      summary: summarise(stripes),
    },
  ]
}

// ── Old thesailcloud "Onboard Sail (Relative)" format ────────────────────────
// Real metric titles always carry a bracketed unit ("Draft [%]", "Twist [°]").
// Requiring the "[" avoids matching the page banner "Draft Stripes".
const METRIC_FIELDS: Array<{ re: RegExp; field: keyof ParsedStripe }> = [
  { re: /^Fore\s+Camber\s*\[/i, field: 'fore' },
  { re: /^Back\s+Camber\s*\[/i, field: 'back' },
  { re: /^Camber\s*\[/i, field: 'camber' },
  { re: /^Draft\s*\[/i, field: 'draft' },
  { re: /^Twist\s*\[/i, field: 'twist' },
  { re: /^Entry\s+Angle\s*\[/i, field: 'entry' },
  { re: /^Exit\s+Angle\s*\[/i, field: 'exit' },
]

// Greedy max-overlap assignment of metadata rows to columns: each row goes to
// the column whose (truncated) name shares the longest leading run, one-to-one.
// A row with no strong column match is simply left unassigned (stays null) —
// this is what keeps a blank Generic-Measurements row from leaking onto the
// wrong sail in a two-sail report.
function assignByCol<T>(items: T[], nameOf: (t: T) => string, colNames: string[], minScore: number): Array<T | null> {
  const res: Array<T | null> = new Array(colNames.length).fill(null)
  const pairs: Array<{ s: number; c: number; it: T }> = []
  for (const it of items) {
    for (let c = 0; c < colNames.length; c++) {
      pairs.push({ s: commonPrefixLen(norm(nameOf(it)), norm(colNames[c] || '')), c, it })
    }
  }
  pairs.sort((a, b) => b.s - a.s)
  const usedItem = new Set<T>()
  for (const p of pairs) {
    if (p.s < minScore) break
    if (res[p.c] || usedItem.has(p.it)) continue
    res[p.c] = p.it
    usedItem.add(p.it)
  }
  return res
}

interface HeaderRow {
  name: string
  utc: string | null
  local: string | null
  tags: string | null
}

function parseThesailcloud(text: string, tz: string): ParsedScan[] {
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l.length)

  // 1) Header table rows: lines carrying a date (before the metric sections).
  //    name = text before the date; tags = text after it (sans trailing cols).
  const headerRows: HeaderRow[] = []
  const dateRe = /(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}(?::\d{2})?))?/
  let inHeader = false
  for (const line of lines) {
    if (/^Image\s+Date\s+Tags/i.test(line)) { inHeader = true; continue }
    if (/^Draft\s+Stripe/i.test(line) || /^Draft\s+Stripes/i.test(line)) break
    if (!inHeader) continue
    if (/^Image\s+Venue/i.test(line)) continue
    const dm = line.match(dateRe)
    if (!dm) continue
    const name = line.slice(0, dm.index).replace(/\.+$/, '').trim()
    let tags = line.slice(dm.index! + dm[0].length).trim()
    tags = tags
      .replace(/^\.+\s*/, '') // drop a leading ellipsis (truncated date seconds)
      .replace(/^\s*\d{1,2}:\d{0,2}\.*\s*/, '') // drop a truncated time leftover ("12:2…")
      .replace(/\s*\S*\.\.\.\s*$/g, '') // drop trailing truncated columns ("…T… J1…")
      .replace(/\s*\S*\.\.\.\s*$/g, '')
      .replace(/[\s,_-]+$/, '')
      .trim()
    const stamp = parseStamp(dm[1], dm[2] || null, tz)
    headerRows.push({ name, utc: stamp.utc, local: stamp.local, tags: tags || null })
  }

  // 2) Generic Measurements table (two-sail reports): TWA/TWS/AWA/BSP per image.
  const generic: Array<{ name: string; twa: number | null; tws: number | null; awa: number | null; bsp: number | null }> = []
  {
    let inGM = false
    for (const line of lines) {
      if (/^Image\s+TWA\s+TWS\s+AWA\s+BSP/i.test(line)) { inGM = true; continue }
      if (!inGM) continue
      if (/^sailscan\.|^Notes:|^Generic/i.test(line)) { inGM = false; continue }
      const gm = line.match(/^(.+?)\s+(-?\d+\.\d{2,})\s+(-?\d+\.\d{2,})\s+(-?\d+\.\d{2,})\s+(-?\d+\.\d{2,})\s*$/)
      if (gm) generic.push({ name: gm[1].trim(), twa: num(gm[2]), tws: num(gm[3]), awa: num(gm[4]), bsp: num(gm[5]) })
    }
  }

  // 3) Full (untruncated) image names from Notes / Venue-table lines.
  const fullNames: string[] = []
  for (const line of lines) {
    const nm = line.match(/^Notes:\s*(.+)$/i)
    if (nm) fullNames.push(nm[1].trim())
  }
  for (const g of generic) fullNames.push(g.name)

  // 4) Metric sections. For each, read its column-name header then the 75/50/25
  //    rows. Column order is consistent across sections → index identifies sail.
  let columnNames: string[] = []
  // stripeData[col] = Map<pos, ParsedStripe>
  const stripeData: Array<Map<number, ParsedStripe>> = []
  const ensureCol = (c: number) => {
    while (stripeData.length <= c) stripeData.push(new Map())
  }
  const ensureStripe = (c: number, pos: number): ParsedStripe => {
    ensureCol(c)
    let s = stripeData[c].get(pos)
    if (!s) { s = { pos, draft: null, camber: null, twist: null, entry: null, exit: null, fore: null, back: null }; stripeData[c].set(pos, s) }
    return s
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const metric = METRIC_FIELDS.find((mf) => mf.re.test(line))
    if (!metric) continue
    // Next line beginning with "Po" is the column header (Position + names).
    let j = i + 1
    while (j < lines.length && !/^Po/i.test(lines[j])) {
      if (/^(87|75|50|25)/.test(lines[j])) break // safety: rows started already
      j++
    }
    if (j < lines.length && /^Po/i.test(lines[j])) {
      const rest = lines[j].replace(/^Po\S*?\.\.\.\s*/i, '')
      const names = rest.match(/\S.*?\.\.\./g)
      if (names && names.length > columnNames.length) columnNames = names.map((s) => s.trim())
      j++
    }
    // Read up to three position rows (75/50/25).
    for (let k = j; k < lines.length; k++) {
      const rowM = lines[k].match(/^(87|75|50|25)[.\d]*\s+(.+)$/)
      if (!rowM) {
        // stop at next metric / section boundary
        if (METRIC_FIELDS.find((mf) => mf.re.test(lines[k])) || /^sailscan\.|^Draft\s+Strip|^Generic/i.test(lines[k])) break
        continue
      }
      const pos = num(rowM[1])!
      const vals = (rowM[2].match(/-?\d+(?:\.\d+)?/g) || []).map((v) => num(v))
      vals.forEach((v, c) => {
        ;(ensureStripe(c, pos) as unknown as Record<string, number | null>)[metric.field as string] = v
      })
    }
  }

  const colCount = Math.max(stripeData.length, columnNames.length, 1)

  // Column keys for metadata matching: prefer the per-section column names; fall
  // back to header-table names when a report has no metric column header.
  const colKeys: string[] = []
  for (let c = 0; c < colCount; c++) colKeys.push(columnNames[c] || headerRows[c]?.name || '')

  // One-to-one assignment so an absent row never leaks onto the wrong column.
  const headerByCol = assignByCol(headerRows, (h) => h.name, colKeys, 6)
  const genericByCol = assignByCol(generic, (g) => g.name, colKeys, 8)
  const matchFullName = (colName: string): string | null => {
    if (!fullNames.length) return colName.replace(/\.+$/, '').trim() || null
    const cn = norm(colName)
    let best = colName.replace(/\.+$/, '').trim()
    let bestScore = 0
    for (const f of fullNames) {
      const score = commonPrefixLen(cn, norm(f))
      if (score > bestScore) { bestScore = score; best = f }
    }
    return best || null
  }

  const scans: ParsedScan[] = []
  for (let c = 0; c < colCount; c++) {
    const stripes = Array.from(stripeData[c]?.values() || []).sort((a, b) => a.pos - b.pos)
    if (!stripes.length) continue
    const colName = colKeys[c]
    const hdr = headerByCol[c]
    const gm = genericByCol[c]
    const fullName = matchFullName(colName)
    const tags = hdr?.tags || null
    const tws = gm?.tws ?? twsFromTags(tags) ?? twsFromTags(fullName)
    const sailName = sailCodeFromName(fullName)
    scans.push({
      source: 'thesailcloud',
      format: 'thesailcloud-relative',
      sailName,
      sailType: classifySailType(sailName) || classifySailType(fullName),
      sailCode: null,
      oeNumber: null,
      imageName: fullName,
      capturedAt: hdr?.utc || null,
      capturedLocal: hdr?.local || null,
      tags,
      venue: null,
      event: null,
      tws,
      twa: gm?.twa ?? null,
      awa: gm?.awa ?? null,
      bsp: gm?.bsp ?? null,
      forestayT: null,
      rakeDeg: null,
      jibTackT: null,
      stripes,
      summary: summarise(stripes),
    })
  }
  return scans
}

// ── Public entry point ───────────────────────────────────────────────────────
export function parseSailScanReport(rawText: string, opts: ParseOpts = {}): ParsedReport {
  const tz = opts.tz || DEFAULT_TZ
  const text = (rawText || '').replace(/ /g, ' ') // nbsp → space
  const format = detectFormat(text)
  let scans: ParsedScan[] = []
  if (format === 'north-app') scans = parseNorthApp(text, tz)
  else if (format === 'thesailcloud-relative') scans = parseThesailcloud(text, tz)
  // Report format follows the actual parsed scan (NS App vs NS Sailscan).
  return { format: (scans[0]?.format as ParsedReport['format']) || format, scans }
}
