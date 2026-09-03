// logV3Parse.ts — Expedition `!log=v3` export (seen from Expedition 12.9.2).
//
// This variant writes SPARSE rows of `channel,value,channel,value,…` against a
// channel map carried in two `!`-prefixed header lines, instead of one value per
// column:
//
//   !Boat,Utc,BSP,AWA,AWS,TWA,TWS,TWD,Course,…,Lat,Lon,COG,SOG,…
//   !boat,0,1,2,3,4,5,6,9,…,48,49,50,51,…
//   !v12.9.2
//   !log=v3
//   0,134328055744581987,163,43.169903,164,5.643753,…
//   0,134328055775865592,1,0.000000,2,-146.51,3,12.4098,…
//
// Line 1 gives the channel LABELS, line 2 the channel NUMBERS, positionally
// aligned after the leading `!Boat` / `!boat` token. Each data row then names the
// channels it carries, so rows may hold any subset — the first row above has only
// the timestamp and the four mark coordinates, no instruments at all.
//
// WHY EXPAND RATHER THAN PARSE. The labels are the SAME ones the fixed-column
// flat-OLE export uses, so every field mapping, alias override, unit rule and the
// Windows-FILETIME decoding already exist in flatLogParse. Rewriting them here
// would duplicate that logic and let the two drift. Instead we rewrite v3 into the
// fixed-column layout that parser already understands and hand it over.
//
// Before this existed, isFlatOleLog() rejected the file outright on `first line
// starts with "!"`, so detectLogFormat fell through to the legacy NMEA parser and
// produced ZERO rows — the log uploaded, the session showed a "log" badge, and
// Analytics rendered an empty chart with nothing to explain why.

const isInt = (s: string) => /^\d+$/.test(s.trim())

export interface LogV3Header {
  labels: string[]              // channel labels, in the order the header lists them
  channels: number[]            // channel numbers, positionally aligned to `labels`
  dataStart: number             // index of the first non-`!` line
}

// Read the two header lines. Returns null when this is not a v3 export.
export function parseLogV3Header(text: string): LogV3Header | null {
  if (!text) return null
  const lines = text.replace(/\r/g, '').split('\n')
  let labels: string[] | null = null
  let channels: number[] | null = null
  let i = 0
  for (; i < lines.length; i++) {
    const l = lines[i].trim()
    if (!l) continue
    if (!l.startsWith('!')) break            // headers all precede the data
    const parts = l.slice(1).split(',')
    if (parts.length < 3) continue           // `!v12.9.2`, `!log=v3` — not a map
    const rest = parts.slice(1).map((x) => x.trim())   // drop the `Boat`/`boat` token
    if (!labels) { labels = rest; continue }
    if (rest.every(isInt)) { channels = rest.map(Number); i++; break }
  }
  if (!labels || !channels) return null
  // A mismatched pair means we cannot trust the alignment — refuse rather than
  // silently map values onto the wrong fields.
  if (labels.length !== channels.length) return null
  // Skip any remaining header lines before the data.
  while (i < lines.length && (!lines[i].trim() || lines[i].trim().startsWith('!'))) i++
  return { labels, channels, dataStart: i }
}

export function isLogV3(text: string): boolean {
  return parseLogV3Header(text) !== null
}

// Rewrite a v3 export as fixed-column CSV: one header line of labels, then one
// value per column per row. Absent channels CARRY FORWARD the last seen value —
// at ~1 Hz with nearly every channel present on every row, a gap means "unchanged"
// far more often than "invalid", and blanking would punch holes in every chart.
// (Flip `carryForward` to false to emit blanks instead.)
export function expandLogV3(text: string, opts: { carryForward?: boolean } = {}): string {
  const carry = opts.carryForward !== false
  const h = parseLogV3Header(text)
  if (!h) return text
  const lines = text.replace(/\r/g, '').split('\n')

  const idxOfChannel = new Map<number, number>()
  h.channels.forEach((c, i) => idxOfChannel.set(c, i))

  const out: string[] = [h.labels.join(',')]
  const last: string[] = new Array(h.labels.length).fill('')

  for (let i = h.dataStart; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim() || line.trim().startsWith('!')) continue
    const t = line.split(',')
    const cells: string[] = carry ? last.slice() : new Array(h.labels.length).fill('')
    let sawAny = false
    // pairs: channel, value
    for (let k = 0; k + 1 < t.length; k += 2) {
      const ch = t[k].trim()
      if (!isInt(ch)) continue
      const at = idxOfChannel.get(Number(ch))
      if (at === undefined) continue          // channel not in the header map
      cells[at] = t[k + 1].trim()
      sawAny = true
    }
    if (!sawAny) continue
    if (carry) for (let j = 0; j < cells.length; j++) last[j] = cells[j]
    out.push(cells.join(','))
  }
  return out.join('\n')
}
