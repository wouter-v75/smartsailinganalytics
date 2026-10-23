// The small open feeds: sailing clubs, a coastwatch station and the national
// coastal-monitoring piers.
//
// WHY A FILE OF ITS OWN. These are four unrelated formats with nothing in
// common but being free to read — no key, no token, no permission. Each is one
// club's or one agency's own idea of how to publish a wind reading, so each
// gets its own parser and they are kept together rather than lengthening
// windObs.ts by a quarter.
//
// WHAT THEY ADD. Hill Head and Netley cover the north shore from Titchfield to
// Southampton Water, where the Davis stations are gardens and the Port-Log
// masts are inside the docks. Hengistbury Head watches the western approach.
// The CCO piers are a professional network over open water.
//
// EVERY ONE OF THESE STATES ITS OWN UNIT, in words, in the payload. None of
// them is assumed: a Cumulus station can be configured in mph, km/h or m/s as
// easily as knots, and the station below happens to be in knots TODAY. So the
// stated unit is what converts, and an unrecognised one is refused.
//
// THE CLOCKS DIFFER AND NONE OF THEM IS OBVIOUS, which for this project is the
// expensive kind of detail:
//
//   Hill Head   "2026-10-23T06:50:00"      LOCAL (Europe/London), no marker
//   Netley      1792734552                 epoch seconds, genuinely UTC
//   Cumulus     "23/10/2026 06:40:00"      LOCAL, and dd/mm/yyyy not mm/dd
//   CCO         "23-10-2026 05:40"         GMT, said so in the column header
//
// Hill Head was settled by measurement: its newest row read 06:50 while UTC
// was 05:52 and London 06:52. Cumulus the same way. CCO says "Time (GMT)" in
// the table header and the value agreed with UTC, in October, so they publish
// GMT year-round rather than switching to BST.

import {
  OBS_SOURCES, knFromUnit, type WindObs,
} from './windObs'
import { wallClockToUtcMs } from './tzWallClock'

const UK = 'Europe/London'
const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.trim()) : NaN
  return Number.isFinite(n) ? n : null
}
const deg = (v: number | null): number | null => (v == null ? null : ((v % 360) + 360) % 360)

export interface ClubStation {
  id: string
  name: string
  lat: number
  lon: number
  surface: 'sea' | 'land'
  /** Ground elevation, metres. NOT the anemometer height. */
  elevM?: number | null
}

// ---------------------------------------------------------------------------
// Hill Head Sailing Club
// ---------------------------------------------------------------------------
//
// day.json carries a rounded `latestArchiveRecord` AND `dayWindData`, 288 rows
// of [time, speed, gust, direction] at five minutes — a full 24 hours.
//
// The ARRAY is what is parsed, because it has the precision the record has
// rounded away: the newest row read 15.641572 / 21.724406 / 90 where the
// record said "16 knots" / "22 knots" / "90°". That agreement, at the same
// timestamp, is what identified the column order and the unit at once.
//
// The record is still read, for ONE thing: it is the only place the feed says
// what unit it is in, in words. If that ever stops saying knots the whole
// payload is refused rather than converted on an assumption.
export function parseHillHead(payload: unknown, st: ClubStation, nowMs: number = Date.now()): WindObs[] {
  if (!payload || typeof payload !== 'object') return []
  const p = payload as Record<string, unknown>

  const latest = p.latestArchiveRecord && typeof p.latestArchiveRecord === 'object'
    ? (p.latestArchiveRecord as Record<string, unknown>) : null
  const unitWord = typeof latest?.windSpeed === 'string'
    ? /([a-z/]+)\s*$/i.exec(latest.windSpeed.trim())?.[1] ?? '' : ''
  // knFromUnit knows "knots"; anything else and we stop here.
  if (knFromUnit(1, unitWord) == null) return []

  const rows = p.dayWindData
  if (!Array.isArray(rows)) return []

  const out: WindObs[] = []
  for (const r of rows) {
    if (!Array.isArray(r) || r.length < 4) continue
    const ms = localStampToUtcMs(typeof r[0] === 'string' ? r[0] : '')
    if (ms == null || ms > nowMs + 600_000) continue
    const twsKn = knFromUnit(num(r[1]), unitWord)
    if (twsKn == null) continue
    out.push({
      id: st.id, source: 'beacon', name: st.name, lat: st.lat, lon: st.lon,
      heightM: null, elevM: st.elevM ?? null, surface: st.surface,
      twsKn, twdDeg: deg(num(r[3])), gustKn: knFromUnit(num(r[2]), unitWord),
      t: new Date(ms).toISOString(), trust: OBS_SOURCES.beacon.trust,
    })
  }
  return out
}

/** "2026-10-23T06:50:00" or "2026-10-23 06:50:00", read as UK wall time. */
function localStampToUtcMs(s: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(s.trim())
  if (!m) return null
  const ms = wallClockToUtcMs(+m[1], +m[2], +m[3], +m[4], +m[5], m[6] ? +m[6] : 0, UK)
  return Number.isFinite(ms) ? ms : null
}

// ---------------------------------------------------------------------------
// Netley Sailing Club
// ---------------------------------------------------------------------------
//
// The tidiest feed here, and the only one with nothing to work out:
//
//   {"cells":{"unixEpochSeconds":1792734552,"knotsAverage":7,"knotsGust":8,
//             "bearing":39}}
//
// Epoch seconds, so genuinely UTC with no zone to get wrong, and the unit is
// in the FIELD NAMES — which is why those names are required rather than
// read past. A feed that renamed `knotsAverage` to `windAverage` would be
// telling us it had stopped promising knots.
export function parseNetley(payload: unknown, st: ClubStation, nowMs: number = Date.now()): WindObs[] {
  if (!payload || typeof payload !== 'object') return []
  const cells = (payload as { cells?: unknown }).cells
  if (!cells || typeof cells !== 'object') return []
  const c = cells as Record<string, unknown>
  if (!('knotsAverage' in c)) return []

  const secs = num(c.unixEpochSeconds)
  const twsKn = knFromUnit(num(c.knotsAverage), 'knots')
  if (secs == null || secs <= 0 || twsKn == null) return []
  const ms = secs * 1000
  if (ms > nowMs + 600_000) return []

  return [{
    id: st.id, source: 'beacon', name: st.name, lat: st.lat, lon: st.lon,
    heightM: null, elevM: st.elevM ?? null, surface: st.surface,
    twsKn, twdDeg: deg(num(c.bearing)),
    gustKn: 'knotsGust' in c ? knFromUnit(num(c.knotsGust), 'knots') : null,
    t: new Date(ms).toISOString(), trust: OBS_SOURCES.beacon.trust,
  }]
}

// ---------------------------------------------------------------------------
// Cumulus websitedata.json (NCI Hengistbury Head, and most club sites)
// ---------------------------------------------------------------------------
//
// Cumulus is the software behind a great many amateur stations, so this parser
// is worth more than the one station it is pointed at — any site publishing
// `websitedata.json` fits it.
//
// `windunit` states the unit and IS honoured, because Cumulus is configured
// per station: this one says "kts" and the next may well say "mph".
//
// It also carries `stationtype`, which at Hengistbury reads "Davis WeatherLink
// Live with a Vantage Pro2 Sensor Suite (wind direction unreliable when wind
// is in S ro SE)" — the operator telling you, in the metadata, that the vane
// is shadowed over part of the compass. That is left as a note rather than
// acted on: dropping the direction for one sector would be a judgement about
// somebody else's station, and the reading is still theirs to publish. It is
// `elevM` that is worth recording — 38 m up on a headland is not a sea-level
// reading, and that is the field the rest of the pipeline already understands.
export function parseCumulus(payload: unknown, st: ClubStation, nowMs: number = Date.now()): WindObs[] {
  if (!payload || typeof payload !== 'object') return []
  const p = payload as Record<string, unknown>
  const unit = typeof p.windunit === 'string' ? p.windunit : ''
  const twsKn = knFromUnit(num(p.wspeed), unit)
  if (twsKn == null) return []

  // "23/10/2026 06:40:00" — dd/mm/yyyy, UK wall time.
  const m = /^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?/.exec(
    typeof p.update === 'string' ? p.update.trim() : '')
  if (!m) return []
  const ms = wallClockToUtcMs(+m[3], +m[2], +m[1], +m[4], +m[5], m[6] ? +m[6] : 0, UK)
  if (!Number.isFinite(ms) || ms > nowMs + 600_000) return []

  return [{
    id: st.id, source: 'beacon', name: st.name, lat: st.lat, lon: st.lon,
    heightM: null, elevM: st.elevM ?? null, surface: st.surface,
    twsKn, twdDeg: deg(num(p.avgbearing)), gustKn: knFromUnit(num(p.wgust), unit),
    t: new Date(ms).toISOString(), trust: OBS_SOURCES.beacon.trust,
  }]
}

// ---------------------------------------------------------------------------
// Channel Coastal Observatory — the national coastal-monitoring piers
// ---------------------------------------------------------------------------
//
// There is no numeric API: `dispgraphMet.php` returns a PNG of a graph. What
// there IS, is a "Latest Met Data" table in the page, and it is unusually
// well-behaved for something that has to be scraped:
//
//   <tr class="charts_header"><th>Time (GMT)</th>…<th>Wind Speed (knots)</th>
//     <th>Wind Speed (ms<sup>-1</sup>)</th><th>Gust Speed (knots)</th>…
//   <tr><td>23-10-2026 05:40</td><td>980.2</td><td>30.5</td><td>15.7</td>…
//
// COLUMNS ARE FOUND BY HEADER TEXT, never by position — a scraper that counts
// to the third cell breaks silently the day somebody inserts a column, and
// breaks into a plausible wrong number rather than an error.
//
// AND IT CHECKS ITSELF. The table publishes wind in knots AND in m/s, which is
// a free tripwire: 30.5 / 15.7 = 1.9427 against 1.943844. If the two columns
// ever stop agreeing, something has been misread and the row is refused. No
// other feed here can be checked without going outside it.
const CCO_TOL = 0.02 // 2% between the knots and m/s columns

export function parseCcoLatest(html: string, st: ClubStation, nowMs: number = Date.now()): WindObs[] {
  if (typeof html !== 'string') return []
  // Must start AT the <tr, not at the class name inside it — otherwise the
  // header row's opening tag is outside the match, the first row parsed is
  // the DATA row, and the column lookup finds no headers at all.
  const table = /<tr[^>]*charts_header[\s\S]{0,6000}?<\/table>/i.exec(html)
  if (!table) return []
  const rows = Array.from(table[0].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)).map((m) => m[1])
  if (rows.length < 2) return []

  const cells = (row: string, tag: 'th' | 'td') =>
    Array.from(row.matchAll(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'gi')))
      .map((m) => m[1].replace(/<[^>]*>/g, '').replace(/&#176;/g, '').replace(/&nbsp;/g, ' ').trim())

  const head = cells(rows[0], 'th')
  if (!head.length) return []
  const col = (re: RegExp) => head.findIndex((h) => re.test(h))
  const iTime = col(/^time/i)
  const iKn = col(/wind\s*speed\s*\(knots\)/i)
  const iMs = col(/wind\s*speed\s*\(ms/i)
  const iGust = col(/gust\s*speed\s*\(knots\)/i)
  const iDir = col(/wind\s*direction/i)
  if (iTime < 0 || iKn < 0) return []
  // The header must SAY GMT. If they ever switch to local time the label is
  // the only warning, and an hour is not visible in the number.
  if (!/\bGMT\b/i.test(head[iTime])) return []

  const out: WindObs[] = []
  for (const row of rows.slice(1)) {
    const td = cells(row, 'td')
    if (td.length < head.length) continue
    const dash = (v: string | undefined) => (v && v !== '-' ? num(v) : null)

    const kn = dash(td[iKn])
    if (kn == null) continue
    if (iMs >= 0) {
      const ms = dash(td[iMs])
      // Both columns are the same measurement; disagreement means a misread.
      if (ms == null || Math.abs(kn - ms * 1.943844) > Math.max(0.2, kn * CCO_TOL)) continue
    }

    const m = /^(\d{2})-(\d{2})-(\d{4})\s+(\d{2}):(\d{2})/.exec(td[iTime] || '')
    if (!m) continue
    const t = Date.UTC(+m[3], +m[2] - 1, +m[1], +m[4], +m[5])
    if (!Number.isFinite(t) || t > nowMs + 600_000) continue

    const twsKn = knFromUnit(kn, 'knots')
    if (twsKn == null) continue
    out.push({
      id: st.id, source: 'synop', name: st.name, lat: st.lat, lon: st.lon,
      heightM: null, elevM: st.elevM ?? null, surface: st.surface,
      twsKn, twdDeg: iDir >= 0 ? deg(dash(td[iDir])) : null,
      gustKn: iGust >= 0 ? knFromUnit(dash(td[iGust]), 'knots') : null,
      t: new Date(t).toISOString(), trust: OBS_SOURCES.synop.trust,
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

export interface ClubFeed extends ClubStation {
  url: string
  kind: 'hillhead' | 'netley' | 'cumulus' | 'cco'
}

export const CLUB_FEEDS: ClubFeed[] = [
  {
    kind: 'hillhead', id: 'club:hillhead', name: 'Hill Head SC',
    lat: 50.817812, lon: -1.240985, surface: 'sea',
    url: 'https://content1.hillheadsc.org.uk/scripts/file_loader.php?file-name=day.json',
  },
  {
    kind: 'netley', id: 'club:netley', name: 'Netley SC',
    lat: 50.864, lon: -1.341, surface: 'sea',
    url: 'https://netleysc.uk/anemometer/index.php?command=retrievecurrent',
  },
  {
    // 38 m up on the headland — recorded, because it is not a sea-level wind.
    kind: 'cumulus', id: 'club:hengistbury', name: 'NCI Hengistbury Head',
    lat: 50.715197, lon: -1.758855, surface: 'land', elevM: 38,
    url: 'https://hhnci.org.uk/conditions/websitedata.json',
  },
  {
    kind: 'cco', id: 'cco:sandown', name: 'Sandown Pier',
    lat: 50.65111, lon: -1.15316, surface: 'sea',
    url: 'https://coastalmonitoring.org/realtimedata/?chart=92&tab=met',
  },
  {
    // Three weeks silent when this was built. KEPT, where the dead WeatherFile
    // paraglider site was not, and the difference is the reason: this is a
    // maintained national network where a gap is a fault that gets fixed,
    // not a seasonal site that stops reporting out of season.
    kind: 'cco', id: 'cco:swanage', name: 'Swanage Pier',
    lat: 50.60939, lon: -1.94921, surface: 'sea',
    url: 'https://coastalmonitoring.org/realtimedata/?chart=93&tab=met',
  },
]

/** Parse a feed's body according to its kind. */
export function parseClubFeed(feed: ClubFeed, body: string, nowMs: number = Date.now()): WindObs[] {
  if (feed.kind === 'cco') return parseCcoLatest(body, feed, nowMs)
  let json: unknown
  try { json = JSON.parse(body) } catch { return [] }
  if (feed.kind === 'hillhead') return parseHillHead(json, feed, nowMs)
  if (feed.kind === 'netley') return parseNetley(json, feed, nowMs)
  return parseCumulus(json, feed, nowMs)
}
