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
  /** The stripe as the report NAMED it ("Stripe 1"), when it names rather than
   *  measures. See `posIsIndex`. */
  label?: string
}

export type SailType = 'main' | 'headsail' | null

export interface ParsedScan {
  source: 'north' | 'thesailcloud' | 'sailvision'
  format: 'north-app' | 'north-sailscan' | 'north-comparison' | 'thesailcloud-relative' | 'sailvision'
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
  /**
   * The report's own total twist, degrees — foot stripe to head stripe.
   *
   * Kept as reported rather than recomputed, because it is the one figure that
   * CHECKS the parse: it equals the sum of the pairwise twists on every page of
   * the Baraka report, so a mismatch means a stripe row was dropped or misread.
   */
  twistTotalDeg: number | null
  /** The report's free-text trim notes, verbatim and possibly several lines. */
  notes: string | null
  /**
   * TRUE when `stripes[].pos` came from the BOAT'S CONVENTION, not the report.
   *
   * North prints each stripe's height in the report ("75%", "50%", "25%"), so
   * there `pos` is read off the page. Sail Vision prints only "Stripe 1".."Stripe
   * 4" and states no heights anywhere — but the stripes are a property of the
   * sail, not of the report, and on Baraka they are counted FROM THE BOTTOM at
   * 25 / 50 / 75 / 87 % of hoist (Wouter, 2026-10-14). So the heights are known;
   * they just are not in the file.
   *
   * Flagged rather than silently filled because the mapping is index → height by
   * convention, and a boat whose sails are striped differently would need a
   * different one. The direction is independently corroborated by the report: the
   * pairwise twists sum exactly to `Twist (total)` on every page, and twist is
   * referenced from the foot, so Stripe 1 is the foot-most.
   */
  posFromConvention?: boolean
  stripes: ParsedStripe[]
  summary: { maxCamberPct: number | null; draftPositionPct: number | null }
}

export interface ParsedReport {
  format: 'north-app' | 'north-sailscan' | 'north-comparison' | 'thesailcloud-relative'
    | 'sailvision' | 'unknown'
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
  // North "Sail Comparison" — two scans side by side; the stripe table merges
  // both into "LEFT / RIGHT" cells. Check before the single north-app layout
  // (it shares the "Image Time" / "Stripe Draft Camber" markers).
  if (/\bSail\s+Comparison\b/i.test(text)) return 'north-comparison'
  // Baraka's analyst. Named before the North checks: its stripe header is
  // "Stripe Draft position Camber …", which the north-app test would not match
  // today, but "Stripe Draft" is one edit away from matching it by accident.
  if (/Sail\s+Vision\s+analysis\s+report/i.test(text)) return 'sailvision'
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
      // Not in this report format.
      twistTotalDeg: null,
      notes: null,
      stripes,
      summary: summarise(stripes),
    },
  ]
}

// ── North "Sail Comparison" format ───────────────────────────────────────────
// Two scans of (usually) the same sail on two tacks/conditions. The stripe table
// merges both as "LEFT / RIGHT" cells, each value rendered twice by the PDF
// (e.g. "47.1 / 46.447.1 46.4"). We read the clean slash pair per metric with a
// PDF (e.g. "47.1 / 46.447.1 46.4"). The render is "L / <R-glued-to-dupL> dupR",
// so the clean RIGHT value is the *trailing* duplicate token — we capture
// `L / <glued> R` and take L (leading) and R (trailing). This also fixes glued
// integers like "15 / 1515 15" (entry/exit) → L 15 │ R 15, not 1515. The loads
// line carries two values each (TWS 9 12 / FORESTAY 10 10
// / RAKE 4.25 4.25); the two metadata + comment blocks appear in left→right
// order. Emits TWO ParsedScans; photos are mapped to scans by the import layer.
const blankStripe = (pos: number): ParsedStripe => ({ pos, draft: null, camber: null, twist: null, entry: null, exit: null, fore: null, back: null })

function parseSailComparison(text: string, tz: string): ParsedScan[] {
  const lines = text.split('\n')

  // Metric column order from the header (Twist present in NS Sailscan).
  let cols: (keyof ParsedStripe)[] = []
  const headerLine = lines.find((l) => /\bStripe\b\s+Draft\b/i.test(l))
  if (headerLine) {
    const toks = headerLine.replace(/.*\bStripe\b\s*/i, '').trim().split(/\s+/)
    cols = toks.map((t) => NORTH_COL_FIELD[t.toLowerCase().replace(/%/g, 'pct').replace(/[^a-z]/g, '')]).filter(Boolean) as (keyof ParsedStripe)[]
  }
  const order = cols.length ? cols : (['draft', 'camber', 'twist', 'entry', 'exit', 'fore', 'back'] as (keyof ParsedStripe)[])

  // Stripe rows → split each "L / R" pair into the two scans, in column order.
  const leftByPos = new Map<number, ParsedStripe>()
  const rightByPos = new Map<number, ParsedStripe>()
  const rowRe = /^\s*(87|75|50|25)\s*%\s+(.+)$/
  // Each metric renders as "L / <R-glued-to-dupL> dupR" → L = leading clean
  // token, R = trailing clean duplicate (so glued ints like "1515" don't poison R).
  const pairRe = /(-?\d+(?:\.\d+)?)\s*\/\s*\S+\s+(-?\d+(?:\.\d+)?)/g
  for (const line of lines) {
    const m = line.match(rowRe)
    if (!m) continue
    const pos = num(m[1])!
    if (leftByPos.has(pos)) continue
    const Ls: (number | null)[] = []
    const Rs: (number | null)[] = []
    let mm: RegExpExecArray | null
    pairRe.lastIndex = 0
    while ((mm = pairRe.exec(m[2]))) { Ls.push(num(mm[1])); Rs.push(num(mm[2])) }
    const L = blankStripe(pos)
    const R = blankStripe(pos)
    const setL = L as unknown as Record<string, number | null>
    const setR = R as unknown as Record<string, number | null>
    order.forEach((f, i) => { if (i < Ls.length) { setL[f as string] = Ls[i]; setR[f as string] = Rs[i] } })
    leftByPos.set(pos, L)
    rightByPos.set(pos, R)
  }
  const leftStripes = Array.from(leftByPos.values()).sort((a, b) => a.pos - b.pos)
  const rightStripes = Array.from(rightByPos.values()).sort((a, b) => a.pos - b.pos)
  if (!leftStripes.length) return []

  // Shared metadata (same sail) + the two image names / capture times in order.
  const sailM = text.match(/\bSail:\s*(\S.*?)\s*(?:Code:|Image:|Image\s+Time:|\n|$)/i)
  const codeM = text.match(/\bCode:\s*(\S.*?)\s*(?:Image:|\n|$)/i)
  const oeM = text.match(/\bOE#:\s*(\S+)/i)
  const sailName = sailM ? sailM[1].trim() : null
  const sailCode = codeM ? codeM[1].trim() : null
  const oeNumber = oeM ? oeM[1].trim() : null

  const imgs = Array.from(text.matchAll(/\bImage:\s*(\S+)/gi)).map((x) => x[1])
  const times = Array.from(text.matchAll(/Image\s*Time:\s*(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)/gi))

  // Loads line: two values each (left, right).
  const two = (re: RegExp): [number | null, number | null] => {
    const mt = text.match(re)
    return mt ? [num(mt[1]), num(mt[2])] : [null, null]
  }
  const [twsL, twsR] = two(/\bTWS\s+(-?\d+(?:[.,]\d+)?)\s+(-?\d+(?:[.,]\d+)?)/i)
  const [foreL, foreR] = two(/\bFORESTAY\s+(-?\d+(?:[.,]\d+)?)\s+(-?\d+(?:[.,]\d+)?)/i)
  const [rakeL, rakeR] = two(/\bRAKE\s+(-?\d+(?:[.,]\d+)?)\s+(-?\d+(?:[.,]\d+)?)/i)

  // Two comment blocks (left, right), each starting with a "[code]:" marker.
  let commentBlocks: string[] = []
  const cIdx = text.search(/\bComments\b/i)
  if (cIdx >= 0) {
    const body = text.slice(cIdx + 8).split(/\n\s*Charts\b/i)[0]
    commentBlocks = body.split(/\n(?=\s*\[)/).map((s) => s.trim()).filter(Boolean)
  }

  const sailType = classifySailType(sailName) || classifySailType(sailCode) || classifySailType(imgs[0] || null)

  const mkScan = (side: 0 | 1, stripes: ParsedStripe[], tws: number | null, fore: number | null, rake: number | null): ParsedScan => {
    const tm = times[side]
    const stamp = parseStamp(tm ? tm[1] : null, tm ? tm[2] : null, tz)
    const tags = commentBlocks[side] || null
    return {
      source: 'north',
      format: 'north-comparison',
      sailName,
      sailType,
      sailCode,
      oeNumber,
      imageName: imgs[side] || null,
      capturedAt: stamp.utc,
      capturedLocal: stamp.local,
      tags,
      venue: null,
      event: null,
      tws: tws ?? twsFromTags(tags),
      twa: null,
      awa: null,
      bsp: null,
      forestayT: fore,
      rakeDeg: rake,
      jibTackT: null,
      // Not in this report format.
      twistTotalDeg: null,
      notes: null,
      stripes,
      summary: summarise(stripes),
    }
  }

  return [
    mkScan(0, leftStripes, twsL, foreL, rakeL),
    mkScan(1, rightStripes, twsR, foreR, rakeR),
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
      // Not in this report format.
      twistTotalDeg: null,
      notes: null,
      stripes,
      summary: summarise(stripes),
    })
  }
  return scans
}

// ── Sail Vision ("Sail Vision analysis report") ──────────────────────────────
// Baraka's analyst exports one A4 PAGE PER SCAN, twenty in a file, in a layout
// that shares nothing with North's or thesailcloud's:
//
//     Sail Vision analysis report Page 1
//     IMG_6456.JPEG - J1.5 (Jib)
//     Captured 2026-10-11 09:51
//     Boat speed 5.6 kn     Wind strength 7.2 kn
//     Upwind angle 37.0 deg Runner load 1.9 t
//     Tack load 50.0 kg     Twist (total) 14.59 deg
//     Sail scan
//     Stripe Draft position Camber Entry angle Exit angle
//     Stripe 1 33.65% 13.28% 37.13 deg 17.57 deg
//     …
//     Twist: Stripe 1 to Stripe 2: 7.43 deg | Stripe 2 to Stripe 3: 7.16 deg
//     Notes: Inhauler car position: 1.5
//     eye up/down: 1
//
// FOUR THINGS THE REAL FILE DOES that a tidy reading of one page would miss:
//
//   • Any instrument value can be a bare "-". Every main has "Tack load -", and
//     one page (a dockside scan) has boat speed, wind, angle AND runner all "-".
//     A dash is NOT zero — 0.0 kn of wind appears elsewhere as a real reading.
//   • The image name can contain spaces, dots and brackets:
//     "WhatsApp Image 2026-10-10 at 4.40.43 PM (1).jpeg - Main 2 (Main)". Only
//     the LAST " - " separates the file from the sail, and the sail itself ends
//     in a bracketed type.
//   • The sail may carry no type at all ("IMG_6408.JPEG - Main").
//   • Notes are free text over several lines, or "None recorded", or the
//     wonderfully unhelpful "See top section".
//
// TWIST IS PAIRWISE, and this schema's per-stripe `twist` is an angle, so the
// pairs are accumulated from the foot — which is the convention twist is quoted
// in anyway. That the pairwise values sum EXACTLY to the reported
// "Twist (total)" on all twenty pages is what makes the accumulation safe, and
// it doubles as the parse's own check: a dropped stripe row breaks the sum.
// `twistTotalDeg` keeps the reported figure so a caller can verify rather than
// trust.

/**
 * Stripe index (1-based, from the foot) → height as % of hoist.
 *
 * NOT in the report — see `ParsedScan.posFromConvention`. Baraka's sails are
 * striped at 25/50/75 (three-stripe jibs) and 25/50/75/87 (four-stripe main),
 * counted from the bottom.
 */
export const SAILVISION_STRIPE_PCT: Record<number, number[]> = {
  3: [25, 50, 75],
  4: [25, 50, 75, 87],
}

/** "-" and "" mean NOT MEASURED. Never 0: a real 0.0 appears in these reports. */
const dashNum = (s: string | undefined | null): number | null => {
  if (s == null) return null
  const t = String(s).trim()
  if (!t || t === '-' || t === '—') return null
  return num(t)
}

function parseSailVision(text: string, tz: string): ParsedScan[] {
  // One block per page. The marker line carries the page number and nothing
  // else worth keeping, so splitting ON it leaves each page's body behind.
  const blocks = text.split(/^.*Sail Vision analysis report.*$/m).slice(1)
  const scans: ParsedScan[] = []

  for (const block of blocks) {
    const lines = block.split('\n')

    // The image/sail line: the first line holding " - ". Split on the LAST one,
    // because the file name may contain spaces and brackets of its own.
    const headIdx = lines.findIndex((l) => l.includes(' - '))
    if (headIdx < 0) continue
    const head = lines[headIdx].trim()
    const cut = head.lastIndexOf(' - ')
    const imageName = head.slice(0, cut).trim() || null
    const sailRaw = head.slice(cut + 3).trim()
    // "Main 2 (Main)" → name "Main 2", type from the bracket. "Main" → no bracket.
    const typed = sailRaw.match(/^(.*?)\s*\(([^)]+)\)\s*$/)
    const sailName = (typed ? typed[1] : sailRaw).trim() || null
    const bracket = typed ? typed[2].trim() : null

    const stamp = block.match(/Captured\s+(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)/i)
    const when = parseStamp(stamp ? stamp[1] : null, stamp ? stamp[2] : null, tz)

    // A number OR a bare dash. The number branch is first so "-19.91" is read as
    // a value and not as "missing" followed by junk.
    const V = String.raw`(-?\d+(?:[.,]\d+)?|-)`
    const grab = (label: string, unit: string) =>
      dashNum((block.match(new RegExp(label + String.raw`\s+` + V + String.raw`\s*` + unit, 'i')) || [])[1])

    // THE INSTRUMENTS ARE NOT READ FROM THIS REPORT (Wouter, 2026-10-14). Boat
    // speed, wind strength, upwind angle, runner load and tack load are all
    // printed on the page and all of them are better in the Expedition log,
    // which is sampled continuously rather than typed in beside one frame. The
    // report's own wind shows why: page 17 of the 12 Oct file reads "Boat speed
    // 8.6 kn Wind strength 0.0 kn".
    //
    // Leaving `tws`/`twa` null is the ACTIVE choice, not an omission.
    // `sail_scans.tws_kn` is what bands a scan for the per-sail media view, so a
    // wrong wind files the scan under a breeze it was not shot in and it is
    // never found again; empty, the log supplies it. Same lesson as a photo's
    // instrument data, which is why that is read from the cloud log too.
    //
    // The TOTAL TWIST is not an instrument — it is the sail's shape, and it is
    // the one figure that CHECKS this parse. It is read.
    const twistTotalDeg = grab('Twist\\s*\\(total\\)', '(?:deg|$)')

    // Stripe rows, in the order the report prints them (foot first).
    const rowRe = /^\s*Stripe\s+(\d+)\s+(-?[\d.]+)\s*%\s+(-?[\d.]+)\s*%\s+(-?[\d.]+)\s*deg\s+(-?[\d.]+)\s*deg/
    const raw: { idx: number; draft: number | null; camber: number | null; entry: number | null; exit: number | null }[] = []
    for (const line of lines) {
      const m = line.match(rowRe)
      if (!m) continue
      raw.push({ idx: +m[1], draft: num(m[2]), camber: num(m[3]), entry: num(m[4]), exit: num(m[5]) })
    }
    if (!raw.length) continue
    raw.sort((a, b) => a.idx - b.idx)

    // Pairwise twists → twist accumulated from the foot stripe, which is 0 by
    // definition (everything is measured relative to it).
    const pair = new Map<number, number>()
    const twistLine = lines.find((l) => /^\s*Twist:/i.test(l)) || ''
    const pairRe = /Stripe\s+(\d+)\s+to\s+Stripe\s+(\d+):\s*(-?[\d.]+)\s*deg/gi
    for (let m = pairRe.exec(twistLine); m; m = pairRe.exec(twistLine)) {
      pair.set(+m[2], num(m[3]) ?? 0)
    }

    const pcts = SAILVISION_STRIPE_PCT[raw.length]
    let cum = 0
    const stripes: ParsedStripe[] = raw.map((r, i) => {
      if (i > 0) cum += pair.get(r.idx) ?? 0
      return {
        // The convention's height when the stripe count is one we know, and the
        // index when it is not — a five-stripe sail is a different sail, and
        // inventing a ladder for it is how incomparable numbers get compared.
        pos: pcts ? pcts[i] : r.idx,
        draft: r.draft,
        camber: r.camber,
        twist: raw.length > 1 ? Math.round(cum * 100) / 100 : null,
        entry: r.entry,
        exit: r.exit,
        fore: null,
        back: null,
        label: `Stripe ${r.idx}`,
      }
    })

    // Notes run from "Notes:" to the end of the page, over as many lines as the
    // trimmer felt like writing. Two phrasings mean "nothing here".
    const nIdx = lines.findIndex((l) => /^\s*Notes:/i.test(l))
    let notes: string | null = null
    if (nIdx >= 0) {
      const body = [lines[nIdx].replace(/^\s*Notes:\s*/i, ''), ...lines.slice(nIdx + 1)]
        .join('\n').trim()
      notes = body && !/^(none recorded|none|n\/a)$/i.test(body) ? body : null
    }

    scans.push({
      source: 'sailvision',
      format: 'sailvision',
      sailName,
      // The bracket is the report's own classification and beats guessing from
      // the name; "Main 2" would classify fine, but a sail called "Code 0 (Jib)"
      // would not.
      sailType: classifySailType(bracket) || classifySailType(sailName) || classifySailType(imageName),
      sailCode: null,
      oeNumber: null,
      imageName,
      capturedAt: when.utc,
      capturedLocal: when.local,
      tags: null,
      venue: null,
      event: null,
      // Every instrument null, on purpose — see the block above. The log is the
      // source for all of these, and this report is the source for the SHAPE.
      tws: null,
      twa: null,
      awa: null,
      bsp: null,
      forestayT: null,
      rakeDeg: null,
      jibTackT: null,
      twistTotalDeg,
      notes,
      posFromConvention: !!pcts,
      stripes,
      summary: summarise(stripes),
    })
  }
  return scans
}

/**
 * Does the parse agree with the report's own arithmetic?
 *
 * `Twist (total)` is the foot-to-head twist and equals the sum of the pairwise
 * values, so the head stripe's accumulated twist must equal it. When it does
 * not, a stripe row or a twist pair was dropped — which is the one failure a
 * stripe table can suffer without looking wrong.
 */
export function sailVisionTwistCheck(scan: ParsedScan): { ok: boolean; reportedDeg: number | null; accumulatedDeg: number | null } {
  const reportedDeg = scan.twistTotalDeg
  const head = scan.stripes[scan.stripes.length - 1]
  const accumulatedDeg = head ? head.twist : null
  if (reportedDeg == null || accumulatedDeg == null) return { ok: true, reportedDeg, accumulatedDeg }
  return { ok: Math.abs(reportedDeg - accumulatedDeg) <= 0.05, reportedDeg, accumulatedDeg }
}

// ── Public entry point ───────────────────────────────────────────────────────
export function parseSailScanReport(rawText: string, opts: ParseOpts = {}): ParsedReport {
  const tz = opts.tz || DEFAULT_TZ
  const text = (rawText || '').replace(/ /g, ' ') // nbsp → space
  const format = detectFormat(text)
  let scans: ParsedScan[] = []
  if (format === 'sailvision') scans = parseSailVision(text, tz)
  else if (format === 'north-comparison') scans = parseSailComparison(text, tz)
  else if (format === 'north-app') scans = parseNorthApp(text, tz)
  else if (format === 'thesailcloud-relative') scans = parseThesailcloud(text, tz)
  // Report format follows the actual parsed scan (NS App vs NS Sailscan).
  return { format: (scans[0]?.format as ParsedReport['format']) || format, scans }
}
