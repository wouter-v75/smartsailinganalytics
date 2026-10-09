// logV3Parse.ts — Expedition's `!`-header log export (seen from Expedition
// 12.9.2 on the Northstar 76, and from Baraka GP in October 2026).
//
// Two `!`-prefixed header lines carry a channel map, positionally aligned after
// the leading `!Boat` / `!boat` token:
//
//   !Boat,Utc,BSP,AWA,AWS,TWA,TWS,TWD,Course,…,Lat,Lon,COG,SOG,…
//   !boat,0,1,2,3,4,5,6,9,…,48,49,50,51,…
//   !v12.9.2
//   !log=v3
//
// Line 1 gives the channel LABELS, line 2 the channel NUMBERS. The list is of
// the channels this boat LOGS, not of every channel Expedition knows: the N76
// header above jumps 6 → 9 because it does not log 7 or 8, and Baraka's does
// log them. That is what makes the two lines alignable at all, and it is
// checked rather than assumed — see ANCHORS below.
//
// Rows come in two shapes and the file says which:
//
//   SPARSE (`!log=v3`)  0,134328055744581987,163,43.169903,164,5.643753,…
//                       `channel,value,channel,value,…` — each row names the
//                       channels it carries, so rows may hold any subset. The
//                       first row of the N76 file has only the timestamp and
//                       the four mark coordinates, no instruments at all.
//   DENSE               134328055744581987,0.00,-146.51,12.4098,…
//                       one value per label, in header order.
//
// WHY EXPAND RATHER THAN PARSE. The labels are the SAME ones the fixed-column
// flat-OLE export uses, so every field mapping, alias override, unit rule and
// the Windows-FILETIME decoding already exist in flatLogParse. Rewriting them
// here would duplicate that logic and let the two drift. Instead we rewrite
// either shape into the fixed-column layout that parser already understands and
// hand it over.
//
// Before this existed, isFlatOleLog() rejected the file outright on `first line
// starts with "!"`, so detectLogFormat fell through to the legacy NMEA parser and
// produced ZERO rows — the log uploaded, the session showed a "log" badge, and
// Analytics rendered an empty chart with nothing to explain why.

import { normLabel } from './logProfile'

const isInt = (s: string) => /^\d+$/.test(s.trim())

// Expedition channel numbers that are FIXED across boats, read off two
// unrelated files (the N76's 2026-09 export and Baraka GP's 2026-10 one).
//
// They are the integrity check on the alignment. Pairing two header lines by
// position is only valid if they really are the same list in the same order; a
// line that lost an entry in the middle would still look perfectly well-formed
// and would shift every field after the gap onto its neighbour's values — heel
// read as trim, TWS as TWA, silently. So the pairing has to AGREE with these
// before it is used, and a disagreement refuses the file rather than guessing.
const ANCHORS: Record<string, number> = {
  utc: 0, bsp: 1, awa: 2, aws: 3, twa: 4, tws: 5, twd: 6,
  lat: 48, lon: 49, cog: 50, sog: 51,
}
const MIN_ANCHORS = 2

export interface LogV3Header {
  /** Channel labels that HAVE a channel number, aligned to `channels`. */
  labels: string[]
  /** Channel numbers, positionally aligned to `labels`. */
  channels: number[]
  /** Every label on line 1, mapped or not — the column order of a dense file. */
  allLabels: string[]
  /**
   * Labels with no channel number, because line 2 was shorter than line 1.
   * Baraka GP's export does this: 352 labels, 194 numbers, the number line
   * ending in a dangling comma. Those channels cannot be read from a SPARSE
   * file (nothing says which number they are) but are read in full from a dense
   * one. Surfaced so a caller can say which instruments are missing and why,
   * rather than leaving someone to wonder where their targets went.
   */
  unmapped: string[]
  /** Index of the first non-`!` line. */
  dataStart: number
}

/** Drop trailing empty cells — a line ending in a comma is still well-formed. */
const cells = (s: string) => {
  const out = s.split(',').map((x) => x.trim())
  while (out.length && out[out.length - 1] === '') out.pop()
  return out
}

// Read the two header lines. Returns null when this is not an Expedition
// `!`-header log, or when its alignment cannot be trusted.
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
    const parts = cells(l.slice(1))
    if (parts.length < 3) continue           // `!v12.9.2`, `!log=v3` — not a map
    const rest = parts.slice(1)              // drop the `Boat`/`boat` token
    if (!labels) { labels = rest; continue }
    if (rest.every(isInt)) { channels = rest.map(Number); i++; break }
  }
  if (!labels || !channels) return null

  // Pair as far as both lines go. A short number line costs the tail channels;
  // it cannot shift the ones before it, because alignment runs from the left.
  const n = Math.min(labels.length, channels.length)
  if (n < 2) return null
  const pairedLabels = labels.slice(0, n)
  const pairedChannels = channels.slice(0, n)

  // Strictly increasing is what a channel list is. Anything else is not one.
  for (let k = 1; k < pairedChannels.length; k++) {
    if (pairedChannels[k] <= pairedChannels[k - 1]) return null
  }

  // The alignment check. Every anchor the file carries must land on its known
  // channel number; two have to be present before the pairing is believed.
  let agreed = 0
  for (let k = 0; k < n; k++) {
    const want = ANCHORS[normLabel(pairedLabels[k])]
    if (want === undefined) continue
    if (want !== pairedChannels[k]) return null
    agreed++
  }
  if (agreed < MIN_ANCHORS) return null

  // Skip any remaining header lines before the data.
  while (i < lines.length && (!lines[i].trim() || lines[i].trim().startsWith('!'))) i++
  return {
    labels: pairedLabels,
    channels: pairedChannels,
    allLabels: labels,
    unmapped: labels.slice(n),
    dataStart: i,
  }
}

export function isLogV3(text: string): boolean {
  return parseLogV3Header(text) !== null
}

/**
 * Is this row `channel,value,…` pairs, or one value per label?
 *
 * The pairs test is self-validating and so goes first: every even cell must be
 * a whole number that the map knows. A dense row fails it the moment it reaches
 * a decimal — `41.135162` is not a channel number — which is why a real file
 * cannot be read as the wrong shape. Only a row of whole numbers as wide as the
 * header is genuinely ambiguous, and then the pairs reading is taken, because
 * that is the documented format.
 */
function looksLikePairs(t: string[], known: Set<number>): boolean {
  if (t.length < 2 || t.length % 2 !== 0) return false
  for (let k = 0; k < t.length; k += 2) {
    const c = t[k].trim()
    if (!isInt(c) || !known.has(Number(c))) return false
  }
  return true
}

// Rewrite the export as fixed-column CSV: one header line of labels, then one
// value per column per row.
//
// For SPARSE rows, absent channels CARRY FORWARD the last seen value — at ~1 Hz
// with nearly every channel present on every row, a gap means "unchanged" far
// more often than "invalid", and blanking would punch holes in every chart.
// (Flip `carryForward` to false to emit blanks instead.) A DENSE row already
// carries every column, so there is nothing to carry.
export function expandLogV3(text: string, opts: { carryForward?: boolean } = {}): string {
  const carry = opts.carryForward !== false
  const h = parseLogV3Header(text)
  if (!h) return text
  const lines = text.replace(/\r/g, '').split('\n')

  const idxOfChannel = new Map<number, number>()
  h.channels.forEach((c, i) => idxOfChannel.set(c, i))
  const known = new Set(h.channels)

  // Decide the shape once, from the first rows that could settle it, so one odd
  // line cannot flip the reading of the file half way down.
  let dense = false
  for (let i = h.dataStart; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim() || line.trim().startsWith('!')) continue
    const t = line.split(',')
    if (looksLikePairs(t, known)) break
    // Not pairs. One value per label — allowing for a trailing comma — is the
    // only other thing it can be; anything else is left to the row loop to skip.
    const w = cells(line).length
    if (w >= h.allLabels.length - 1 && w <= h.allLabels.length) { dense = true }
    break
  }

  if (dense) {
    const out: string[] = [h.allLabels.join(',')]
    for (let i = h.dataStart; i < lines.length; i++) {
      const line = lines[i]
      if (!line.trim() || line.trim().startsWith('!')) continue
      const t = cells(line)
      if (!t.length) continue
      // Pad or trim to the header width so every row lines up with the labels.
      while (t.length < h.allLabels.length) t.push('')
      out.push(t.slice(0, h.allLabels.length).join(','))
    }
    return out.join('\n')
  }

  const out: string[] = [h.labels.join(',')]
  const last: string[] = new Array(h.labels.length).fill('')

  for (let i = h.dataStart; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim() || line.trim().startsWith('!')) continue
    const t = line.split(',')
    const row: string[] = carry ? last.slice() : new Array(h.labels.length).fill('')
    let sawAny = false
    // pairs: channel, value
    for (let k = 0; k + 1 < t.length; k += 2) {
      const ch = t[k].trim()
      if (!isInt(ch)) continue
      const at = idxOfChannel.get(Number(ch))
      if (at === undefined) continue          // channel not in the header map
      row[at] = t[k + 1].trim()
      sawAny = true
    }
    if (!sawAny) continue
    if (carry) for (let j = 0; j < row.length; j++) last[j] = row[j]
    out.push(row.join(','))
  }
  return out.join('\n')
}
