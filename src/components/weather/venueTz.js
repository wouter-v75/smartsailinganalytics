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
