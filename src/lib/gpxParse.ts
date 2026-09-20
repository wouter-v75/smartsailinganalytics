// src/lib/gpxParse.ts
// ─────────────────────────────────────────────────────────────────────────────
// GPX — the universal fallback.
//
// Every device in the dinghy world can produce one: phones (Open GPX Tracker,
// GPS Logger), Garmin and Apple watches, Velocitek Control Center's export, and
// most analysis tools. It is the format that makes "any tracker you already
// own" true, so it matters more than its crudeness suggests.
//
// What it does NOT carry, which is the whole reason the Vakaros path exists
// alongside it: no heading, no heel, no pitch, and usually no speed. So a GPX
// track gets COG and SOG DERIVED from consecutive positions, and they are
// marked derived — position-differenced speed is materially noisier than the
// Doppler SOG a GPS chip computes internally, and at low speed the derived
// course is close to meaningless.
//
// Three things worth knowing about real GPX in the wild:
//
//   • Time is ISO 8601 and usually ends in Z, but not always. A stamp with no
//     zone is read as UTC here, because that is what the spec says and guessing
//     local would reintroduce exactly the trap CLAUDE.md warns about.
//   • Garmin and others put speed and course in a <extensions> block under
//     several different namespaces. Where a <speed> or <course> element exists
//     at any nesting depth it is preferred over the differenced value.
//   • Tracks are split into <trkseg> segments across pauses. Segments are
//     concatenated, and the gap between them is left as a gap — findSegments
//     will break there on its own.
//
// Parsed with regular expressions rather than a DOM: this runs in Node (scripts,
// tests) as well as the browser, and pulling in an XML parser for a format this
// simple is not worth the dependency.
// ─────────────────────────────────────────────────────────────────────────────

const D = Math.PI / 180
const R_M = 6371000
const MS_TO_KN = 1.94384

export interface GpxRow {
  utc: number
  lat: number
  lon: number
  /** Knots. From <speed> when present, else differenced from position. */
  sog: number | null
  /** Degrees true. From <course> when present, else differenced. */
  cog: number | null
  /** Metres, when the file carries elevation. */
  ele: number | null
}

export interface GpxResult {
  rows: GpxRow[]
  startUtc: number
  endUtc: number
  rateHz: number | null
  /** Track or file name, when the file names itself. */
  name: string | null
  /** True when sog/cog were computed here rather than read from the file. */
  derivedMotion: boolean
  rejected: number
}

const EMPTY: GpxResult = {
  rows: [], startUtc: 0, endUtc: 0, rateHz: null, name: null,
  derivedMotion: false, rejected: 0,
}

export function isGpx(text: string): boolean {
  // A TRACK, not merely a GPX file. Most GPX in a sailor's folder is marks and
  // routes — 35 of 41 in one real Downloads folder — and those carry <wpt> or
  // <rtept> with no <trkpt> anywhere. Accepting them here would say the format
  // was understood and then produce no rows, which is the same mislabelling
  // that made every unrecognised CSV claim to be a legacy N72 log.
  const head = text.slice(0, 2000)
  return /<gpx[\s>]/i.test(head) && /<trkpt[\s>]/i.test(text.slice(0, 200000))
}

/** Bearing from a to b, degrees true. */
function bearing(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const φ1 = aLat * D, φ2 = bLat * D, Δλ = (bLon - aLon) * D
  const y = Math.sin(Δλ) * Math.cos(φ2)
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ)
  return (Math.atan2(y, x) / D + 360) % 360
}

function metres(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const dLat = (bLat - aLat) * D
  const dLon = (bLon - aLon) * D * Math.cos(((aLat + bLat) / 2) * D)
  return Math.hypot(dLat, dLon) * R_M
}

const TRKPT = /<(?:trkpt|rtept)\b[^>]*?\blat\s*=\s*"([^"]+)"[^>]*?\blon\s*=\s*"([^"]+)"[^>]*?(?:\/>|>([\s\S]*?)<\/(?:trkpt|rtept)>)/gi
const TAG = (body: string, tag: string): string | null => {
  const m = new RegExp(`<(?:\\w+:)?${tag}\\b[^>]*>([^<]*)<`, 'i').exec(body)
  return m ? m[1].trim() : null
}

/** ISO 8601; a stamp without a zone is UTC, per the GPX spec. */
export function parseGpxTime(s: string | null): number | null {
  if (!s) return null
  const hasZone = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)
  const t = Date.parse(hasZone ? s : `${s}Z`)
  return Number.isFinite(t) ? t : null
}

export function parseGpx(text: string): GpxResult {
  if (!text) return EMPTY
  const nameMatch = /<name\b[^>]*>([^<]*)<\/name>/i.exec(text)
  const name = nameMatch ? nameMatch[1].trim() || null : null

  const raw: Array<{ utc: number; lat: number; lon: number; sog: number | null; cog: number | null; ele: number | null }> = []
  let rejected = 0
  let sawSpeed = false

  TRKPT.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = TRKPT.exec(text)) !== null) {
    const lat = parseFloat(m[1]), lon = parseFloat(m[2])
    const body = m[3] || ''
    const utc = parseGpxTime(TAG(body, 'time'))
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || utc == null) { rejected++; continue }

    const speedRaw = TAG(body, 'speed')          // m/s, per the spec and Garmin
    const courseRaw = TAG(body, 'course') ?? TAG(body, 'heading')
    const eleRaw = TAG(body, 'ele')
    const sp = speedRaw != null ? parseFloat(speedRaw) : NaN
    const co = courseRaw != null ? parseFloat(courseRaw) : NaN
    if (Number.isFinite(sp)) sawSpeed = true

    raw.push({
      utc, lat, lon,
      sog: Number.isFinite(sp) ? sp * MS_TO_KN : null,
      cog: Number.isFinite(co) ? ((co % 360) + 360) % 360 : null,
      ele: eleRaw != null && Number.isFinite(parseFloat(eleRaw)) ? parseFloat(eleRaw) : null,
    })
  }

  if (!raw.length) return { ...EMPTY, name, rejected }
  raw.sort((a, b) => a.utc - b.utc)

  // Fill motion from consecutive positions where the file did not supply it.
  let derivedMotion = false
  const rows: GpxRow[] = raw.map((p, i) => {
    let { sog, cog } = p
    if (sog == null || cog == null) {
      const prev = raw[i - 1], next = raw[i + 1]
      const a = prev ?? p, b = next ?? p
      const dt = (b.utc - a.utc) / 1000
      if (dt > 0) {
        derivedMotion = true
        const d = metres(a.lat, a.lon, b.lat, b.lon)
        if (sog == null) sog = (d / dt) * MS_TO_KN
        // Below ~0.5 kn a differenced course is noise, so leave it null rather
        // than emit a bearing the GPS jitter invented.
        if (cog == null) cog = d / dt > 0.25 ? bearing(a.lat, a.lon, b.lat, b.lon) : null
      }
    }
    return { utc: p.utc, lat: p.lat, lon: p.lon, sog, cog, ele: p.ele }
  })

  const step = Math.max(1, Math.floor(rows.length / 2000))
  const dts: number[] = []
  for (let i = step; i < rows.length; i += step) dts.push((rows[i].utc - rows[i - step].utc) / step)
  dts.sort((a, b) => a - b)
  const medDt = dts.length ? dts[dts.length >> 1] : 0

  return {
    rows,
    startUtc: rows[0].utc,
    endUtc: rows[rows.length - 1].utc,
    rateHz: medDt > 0 ? Math.round((1000 / medDt) * 10) / 10 : null,
    name,
    derivedMotion: derivedMotion && !sawSpeed,
    rejected,
  }
}
