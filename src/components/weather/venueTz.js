// Venue time, not the viewer's.
//
// The Weather tab used the DEVICE timezone for every model request and every
// label, so a Newport forecast made on a laptop in Amsterdam printed Amsterdam
// times: "10:00–15:00 local" meant 04:00–09:00 in Newport. It went unnoticed at
// Porto Cervo only because the viewer and the venue shared a zone.
//
// Everyone now sees the clock the racing runs on — the race committee, the tide
// and the sea breeze all keep venue time — resolved from point 1's coordinates.
// Open-Meteo answers `timezone=auto` with the IANA zone for any location (e.g.
// America/New_York), which saves bundling a timezone map. One tiny request per
// new point-1 position, cached; a failure is not cached, so it retries.

const cache = new Map()
const keyFor = (lat, lon) => `${Math.round(lat * 10) / 10},${Math.round(lon * 10) / 10}`

export function isValidTz(tz) {
  if (!tz || typeof tz !== 'string') return false
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true } catch { return false }
}

export function deviceTz() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' } catch { return 'UTC' }
}

/** IANA timezone at (lat, lon), or null if it could not be determined. */
export function resolveVenueTz(lat, lon, fetchImpl) {
  const f = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null)
  if (lat == null || lon == null || Number.isNaN(Number(lat)) || Number.isNaN(Number(lon)) || !f) {
    return Promise.resolve(null)
  }
  const k = keyFor(Number(lat), Number(lon))
  if (cache.has(k)) return cache.get(k)
  const p = (async () => {
    try {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
        '&hourly=temperature_2m&forecast_days=1&timezone=auto'
      const res = await f(url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const j = await res.json()
      if (!isValidTz(j?.timezone)) throw new Error('no usable timezone')
      return j.timezone
    } catch {
      cache.delete(k)           // never pin a failure; the next call retries
      return null
    }
  })()
  cache.set(k, p)
  return p
}

/** "EDT", "CEST", "UTC" — a readable zone name for labels, never a bare "GMT+2" when a name exists. */
export function tzAbbrev(tz, date = new Date()) {
  const name = (locale) => {
    try {
      return new Intl.DateTimeFormat(locale, { timeZone: tz, timeZoneName: 'short' })
        .formatToParts(date).find((p) => p.type === 'timeZoneName')?.value || ''
    } catch { return '' }
  }
  // en-US names the Americas (EDT), en-GB names Europe (CEST); take whichever is a name.
  for (const n of [name('en-US'), name('en-GB')]) if (n && !/^(GMT|UTC)[+-]/.test(n)) return n
  return name('en-GB') || name('en-US') || tz
}

/** For tests only. */
export function _clearVenueTzCache() { cache.clear() }

// ── Wall-clock model times ──────────────────────────────────────────────────
// Open-Meteo is asked for times IN the venue zone, and answers with zone-less
// wall-clock strings: "2026-09-13T09:00" already means 09:00 in Newport. The bug
// this fixes: `new Date("2026-09-13T09:00")` reads such a string in the BROWSER's
// zone, and formatting that Date in the venue's zone moved it again — Newport seen
// from Amsterdam labelled the 09:00 forecast "03:00", and the table's 08–18 window
// actually showed 14:00–24:00. Harmless only while viewer and venue shared a zone.
// Read the digits instead; only a string that carries a zone is converted.

const HAS_ZONE = /(Z|[+-]\d{2}:?\d{2})$/

/** Hour (0–23) of a model time, in the venue's zone. */
export function wallHour(t, tz) {
  if (typeof t !== 'string' || t.length < 13) return NaN
  if (!HAS_ZONE.test(t)) return Number(t.slice(11, 13))
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz || 'UTC', hour: '2-digit', hourCycle: 'h23' }).format(new Date(t)))
}

/** YYYY-MM-DD of a model time, in the venue's zone. */
export function wallDay(t, tz) {
  if (typeof t !== 'string' || t.length < 10) return ''
  if (!HAS_ZONE.test(t)) return t.slice(0, 10)
  return new Date(t).toLocaleDateString('en-CA', { timeZone: tz || 'UTC' })
}

/** Month (1-12) of a model time, in the venue's zone. */
export function wallMonth(t, tz) {
  const d = wallDay(t, tz)
  return d.length >= 7 ? Number(d.slice(5, 7)) : NaN
}

/** Format a model time for display without shifting it. `opts` as for toLocaleString. */
export function formatWall(t, tz, opts = {}) {
  if (typeof t !== 'string' || !t) return ''
  if (!HAS_ZONE.test(t)) {
    // A Date whose UTC fields ARE the wall-clock digits, printed in UTC: no shift.
    const d = new Date(`${t.length <= 16 ? `${t}:00` : t.slice(0, 19)}Z`)
    return d.toLocaleString('en-GB', { ...opts, timeZone: 'UTC' })
  }
  return new Date(t).toLocaleString('en-GB', { ...opts, timeZone: tz || 'UTC' })
}

/**
 * A model time as a NAIVE venue wall-clock stamp, "YYYY-MM-DDTHH:MM".
 *
 * This is the x value for a Plotly date axis, and its being a STRING is the
 * whole point. Measured against plotly 2.24.1 (the version the app loads):
 *
 *   a naive stamp  -> parsed as a calendar value and printed straight back,
 *                     so the axis reads exactly what you passed, in any zone
 *   a Date object  -> printed in the BROWSER's zone
 *
 * The second line is what broke the charts, because the models arrive in two
 * different time shapes and `new Date()` treats them differently:
 *
 *   Open-Meteo "2026-11-05T14:00"  no zone -> Date at BROWSER 14:00 -> "14:00"
 *   SSA-Race   "2026-11-05T14:00Z"  UTC    -> Date at 14:00Z        -> browser clock
 *
 * So the Open-Meteo curves were right BY ACCIDENT — the browser zone cancels
 * between the parse and the print — and the SSA-Race curves were drawn in the
 * VIEWER's clock. On a comparison panel that put them hours apart on one axis;
 * on the Boundary-layer chart, where SSA-Race is the only source there is, the
 * entire series was in the viewer's clock and nothing was there to disagree
 * with it. A stamp removes the accident along with the bug.
 */
export function wallStamp(t, tz) {
  if (typeof t !== 'string' || t.length < 13) return null
  if (!HAS_ZONE.test(t)) return t.slice(0, 16)
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(t))
  const g = (k) => p.find((x) => x.type === k)?.value || ''
  const day = `${g('year')}-${g('month')}-${g('day')}`
  if (day.length !== 10) return null
  return `${day}T${g('hour')}:${g('minute')}`
}

/**
 * The racing window as naive venue wall-clock stamps, for a chart's opening
 * x-range.
 *
 * The old version built it from `new Date().setHours(10)` — the BROWSER's
 * 10:00 on the BROWSER's today. Two errors in one line at a venue nine hours
 * away: the hours were the viewer's, and late in a European evening the date
 * was already tomorrow at a venue still sailing yesterday afternoon.
 */
export function racingWindowIn(tz, now = new Date(), from = 10, to = 16) {
  const { day } = nowInTz(tz, now)
  const p2 = (n) => String(n).padStart(2, '0')
  return [`${day}T${p2(from)}:00`, `${day}T${p2(to)}:00`]
}

/** The venue's current wall-clock date and hour — "now" for picking a row or frame. */
export function nowInTz(tz, now = new Date()) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(now)
  const g = (k) => p.find((x) => x.type === k)?.value || ''
  return { day: `${g('year')}-${g('month')}-${g('day')}`, hour: Number(g('hour')) }
}
