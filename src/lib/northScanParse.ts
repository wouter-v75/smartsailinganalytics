// src/lib/northScanParse.ts
// ─────────────────────────────────────────────────────────────────────────────
// Parse a North Sails SailScan report (extracted PDF text) into the structured
// shape our sail_scans table stores. Pure + dependency-free so it's unit
// testable; the PDF→text step happens in the API route.
//
// North report layout (text):
//   TWS 9
//   Sail: <name>
//   Image: scan_….jpg Image Time: 2026-06-23 15:38:40
//   Stripe Draft Camber Entry Exit Front% Back%
//   75% 41.3 13.7 33 -21 81.1 71.5      (foot)
//   50% 33.1 13.9 40 -19 80.8 67.3      (mid)
//   25% 32.1 11.4 35 -15 80.3 67.3      (head)
//
// Column order is Draft, Camber, Entry, Exit, Front%, Back%. North omits Twist
// (we store null). pos = stripe height %: 75 foot / 50 mid / 25 head.
// ─────────────────────────────────────────────────────────────────────────────

export interface ParsedStripe {
  pos: number
  camber: number
  draft: number
  twist: number | null
  entry: number
  exit: number
  fore: number
  back: number
}

export interface ParsedNorthScan {
  sailName: string | null
  tws: number | null
  capturedAt: string | null // ISO 8601, best-effort (report time is local)
  imageRef: string | null
  stripes: ParsedStripe[]
  summary: { maxCamberPct: number | null; draftPositionPct: number | null }
}

const num = (s: string): number => parseFloat(s)

export function parseNorthScan(rawText: string): ParsedNorthScan {
  const text = (rawText || '').replace(/ /g, ' ') // nbsp → space

  const twsM = text.match(/\bTWS\s+(-?\d+(?:\.\d+)?)/i)
  const sailM = text.match(/\bSail:\s*(\S.*?)\s*(?:Image:|Image\s+Time:|\n|$)/i)
  const imgM = text.match(/\bImage:\s*(\S+)/i)
  const timeM = text.match(/Image\s*Time:\s*(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)/i)

  // Stripe rows: pos% + 6 numbers (Draft Camber Entry Exit Front% Back%).
  const rowRe =
    /\b(75|50|25)\s*%\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/g

  const stripes: ParsedStripe[] = []
  let m: RegExpExecArray | null
  while ((m = rowRe.exec(text)) !== null) {
    stripes.push({
      pos: num(m[1]),
      draft: num(m[2]),
      camber: num(m[3]),
      entry: num(m[4]),
      exit: num(m[5]),
      fore: num(m[6]),
      back: num(m[7]),
      twist: null, // North report omits twist
    })
  }
  // de-dupe by pos (the table can appear twice — list + chart page)
  const seen = new Set<number>()
  const uniq = stripes.filter((s) => (seen.has(s.pos) ? false : (seen.add(s.pos), true)))
  uniq.sort((a, b) => a.pos - b.pos) // 25 head → 75 foot

  let capturedAt: string | null = null
  if (timeM) {
    const d = new Date(`${timeM[1]}T${timeM[2]}`)
    if (!Number.isNaN(d.getTime())) capturedAt = d.toISOString()
  }

  // summary: deepest camber + its position label
  let maxCamberPct: number | null = null
  let draftPositionPct: number | null = null
  for (const s of uniq) {
    if (maxCamberPct === null || s.camber > maxCamberPct) {
      maxCamberPct = s.camber
      draftPositionPct = s.draft
    }
  }

  return {
    sailName: sailM ? sailM[1].trim() : null,
    tws: twsM ? num(twsM[1]) : null,
    capturedAt,
    imageRef: imgM ? imgM[1] : null,
    stripes: uniq,
    summary: { maxCamberPct, draftPositionPct },
  }
}
