import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseWeatherfile, OBS_SOURCES, WEATHERFILE_FUTURE_TOL_SEC } from '../windObs'
import { WEATHERFILE_STATIONS, type WeatherfileStation } from '../windObsWeatherfile'
import { weatherfileNear, weatherfileObs } from '../obsSources'

const LYM: WeatherfileStation = {
  locId: 'GBR00001', name: 'Lymington Starting Platform', lat: 50.74033, lon: -1.507113, surface: 'sea',
}

// Rows copied from the live feed on 23 Oct 2026. The 05:10 one is the anchor:
// Windycator published 17.7 kn / 22.1 kn gust / 128 deg for this station at
// this minute, having read it independently, so these three numbers are what
// pin the units to m/s. If a future change to the conversion breaks this test
// the conversion is wrong, not the test.
const ROW_0510 = {
  createts: '2026-10-23 05:10:02', date: '2026-10-23', lat: 50.74, lng: -1.5071,
  loc_id: 'GBR00001', smp: 300, time: '05:10:00', ts: '2026-10-23 05:10:00',
  twmu: 24.91, vlt2: 12.65,
  wda: 128, wdb: 110, wdv: 140,
  wsa: 9.10, wsh: 11.37, wsl: 7.2,
}
const ROW_0005 = {
  createts: '2026-10-23 00:05:02', date: '2026-10-23', lat: 50.74, lng: -1.5071,
  loc_id: 'GBR00001', smp: 300, time: '00:05:00', ts: '2026-10-23 00:05:00',
  twmu: 24.91, vlt2: 12.65, wda: 176, wdb: 166, wdv: 184, wsa: 13.29, wsh: 16.73, wsl: 9.78,
}
const NOW = Date.parse('2026-10-23T05:35:00Z')
const payload = (rows: unknown[]) => ({ status: 'ok', data: rows, token: 'PUBLIC' })

afterEach(() => { vi.unstubAllGlobals(); delete process.env.WEATHERFILE_TOKEN })

describe('parseWeatherfile', () => {
  it('reproduces Windycator’s independent read of the same minute, to 0.1 kn', () => {
    const [o] = parseWeatherfile(payload([ROW_0510]), LYM, NOW)
    expect(o.twsKn).toBeCloseTo(17.7, 1)
    expect(o.gustKn).toBeCloseTo(22.1, 1)
    expect(o.twdDeg).toBe(128)
  })

  it('reads ts as UTC, which nothing in the payload says', () => {
    // An hour out here is the mistake this project keeps paying for. The clock
    // was settled by cross-match: Windycator stamped this row 06:10+01:00.
    const [o] = parseWeatherfile(payload([ROW_0510]), LYM, NOW)
    expect(o.t).toBe('2026-10-23T05:10:00.000Z')
  })

  it('ignores wdb and wdv, which bracket the direction rather than mean it', () => {
    const [o] = parseWeatherfile(payload([ROW_0510]), LYM, NOW)
    expect(o.twdDeg).not.toBe(ROW_0510.wdb)
    expect(o.twdDeg).not.toBe(ROW_0510.wdv)
  })

  it('returns every row, in the order given, so one call fills the graph', () => {
    const out = parseWeatherfile(payload([ROW_0005, ROW_0510]), LYM, NOW)
    expect(out).toHaveLength(2)
    expect(out.map((o) => o.t)).toEqual(['2026-10-23T00:05:00.000Z', '2026-10-23T05:10:00.000Z'])
  })

  it('describes the station the way the rest of the pipeline expects', () => {
    const [o] = parseWeatherfile(payload([ROW_0510]), LYM, NOW)
    expect(o.id).toBe('wf:GBR00001')
    expect(o.name).toBe('Lymington Starting Platform')
    expect(o.source).toBe('beacon')
    expect(o.trust).toBe(OBS_SOURCES.beacon.trust)
    expect(o.surface).toBe('sea')
    expect(o.lat).toBeCloseTo(50.74033, 5)
    expect(o.lon).toBeCloseTo(-1.507113, 5)
  })

  it('claims no anemometer height — a platform rail is not a clubhouse roof', () => {
    const [o] = parseWeatherfile(payload([ROW_0510]), LYM, NOW)
    expect(o.heightM).toBeNull()
    expect(o.elevM).toBeNull()
  })

  describe('a reading cannot be from the future', () => {
    it('refuses a row an hour ahead, which is what local-time stamps look like', () => {
      const local = { ...ROW_0510, ts: '2026-10-23 06:30:00' }
      expect(parseWeatherfile(payload([local]), LYM, NOW)).toEqual([])
    })

    it('allows the small lead a clock skew produces', () => {
      const slightly = { ...ROW_0510, ts: '2026-10-23 05:37:00' }
      expect(parseWeatherfile(payload([slightly]), LYM, NOW)).toHaveLength(1)
      expect(WEATHERFILE_FUTURE_TOL_SEC).toBeGreaterThan(0)
      expect(WEATHERFILE_FUTURE_TOL_SEC).toBeLessThan(3600)
    })
  })

  describe('partial rows', () => {
    it('drops a row with no mean rather than inventing one', () => {
      expect(parseWeatherfile(payload([{ ...ROW_0510, wsa: null }]), LYM, NOW)).toEqual([])
    })

    it('keeps the mean when the gust is missing', () => {
      const [o] = parseWeatherfile(payload([{ ...ROW_0510, wsh: null }]), LYM, NOW)
      expect(o.twsKn).toBeCloseTo(17.7, 1)
      expect(o.gustKn).toBeNull()
    })

    it('keeps the mean when the direction is missing', () => {
      const [o] = parseWeatherfile(payload([{ ...ROW_0510, wda: null }]), LYM, NOW)
      expect(o.twdDeg).toBeNull()
      expect(o.twsKn).toBeCloseTo(17.7, 1)
    })

    it('refuses an implausible speed and a bad timestamp', () => {
      expect(parseWeatherfile(payload([{ ...ROW_0510, wsa: 300 }]), LYM, NOW)).toEqual([])
      expect(parseWeatherfile(payload([{ ...ROW_0510, ts: 'not a time' }]), LYM, NOW)).toEqual([])
      expect(parseWeatherfile(payload([{ ...ROW_0510, ts: null }]), LYM, NOW)).toEqual([])
    })

    it('survives the shapes a feed change could produce', () => {
      expect(parseWeatherfile(null, LYM, NOW)).toEqual([])
      expect(parseWeatherfile({ status: 'error', message: 'Token not found' }, LYM, NOW)).toEqual([])
      expect(parseWeatherfile({ data: 'nope' }, LYM, NOW)).toEqual([])
      expect(parseWeatherfile(payload([null, 'x', 7]), LYM, NOW)).toEqual([])
    })
  })
})

describe('weatherfileObs', () => {
  it('makes NO request and returns nothing without a token', async () => {
    // The structural-inertness claim, asserted rather than described: no key,
    // no traffic to somebody else's commercial API.
    delete process.env.WEATHERFILE_TOKEN
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    expect(await weatherfileObs()).toEqual([])
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('sends the token as the wf-tkn header and keeps only recent rows', async () => {
    process.env.WEATHERFILE_TOKEN = 'abc123'
    const recent = { ...ROW_0510, ts: new Date(Date.now() - 10 * 60_000).toISOString().slice(0, 19).replace('T', ' ') }
    const ancient = { ...ROW_0510, ts: '2026-10-20 05:10:00' }
    const seen: Array<{ url: string; tkn: string | undefined; method: string | undefined }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      seen.push({ url, tkn: (init.headers as Record<string, string>)['wf-tkn'], method: init.method })
      return { ok: true, status: 200, text: async () => JSON.stringify(payload([ancient, recent])) }
    }))
    const out = await weatherfileObs([LYM], 6)
    expect(seen).toHaveLength(1)
    expect(seen[0].method).toBe('POST')
    expect(seen[0].tkn).toBe('abc123')
    expect(seen[0].url).toContain('/loc/GBR00001/averages.json')
    // The three-day-old row is outside the six-hour window.
    expect(out).toHaveLength(1)
  })

  it('loses one station without losing the others', async () => {
    process.env.WEATHERFILE_TOKEN = 'abc123'
    const other: WeatherfileStation = { ...LYM, locId: 'GBR00002', name: 'Hurst Castle' }
    const fresh = { ...ROW_0510, ts: new Date(Date.now() - 5 * 60_000).toISOString().slice(0, 19).replace('T', ' ') }
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (
      url.includes('GBR00001')
        ? { ok: false, status: 503, text: async () => '' }
        : { ok: true, status: 200, text: async () => JSON.stringify(payload([fresh])) }
    )))
    const out = await weatherfileObs([LYM, other], 6)
    expect(out.map((o) => o.id)).toEqual(['wf:GBR00002'])
  })
})

describe('weatherfileNear', () => {
  it('finds the western Solent group from Lymington', () => {
    const near = weatherfileNear(50.74, -1.52, 5).map((s) => s.name)
    expect(near).toContain('Lymington Starting Platform')
    expect(near).toContain('Lymington Yacht Haven')
    expect(near).toContain('Yarmouth Pier')
    expect(near).toContain('Hurst Castle')
  })

  it('finds none at another venue', () => {
    expect(weatherfileNear(33.72, -118.27, 40)).toEqual([])
    expect(weatherfileNear(43.275, 6.678, 40)).toEqual([])
  })
})

describe('the station registry', () => {
  it('carries the four that close the western Solent', () => {
    const byId = new Map(WEATHERFILE_STATIONS.map((s) => [s.locId, s]))
    for (const id of ['GBR00001', 'GBR00002', 'GBR00003', 'GBR00008']) {
      expect(byId.has(id), `${id} missing from the registry`).toBe(true)
    }
  })

  it('leaves out the station that was eight days dead when it was built', () => {
    // A seasonal paraglider site: 48 requests a day for a reading the
    // staleness window drops anyway.
    expect(WEATHERFILE_STATIONS.some((s) => s.locId === 'GBR00158')).toBe(false)
  })

  it('has no duplicates and plausible positions in the Solent/Poole box', () => {
    const ids = WEATHERFILE_STATIONS.map((s) => s.locId)
    expect(new Set(ids).size).toBe(ids.length)
    for (const s of WEATHERFILE_STATIONS) {
      expect(s.name.trim()).not.toBe('')
      expect(s.lat).toBeGreaterThan(50.5)
      expect(s.lat).toBeLessThan(51.0)
      expect(s.lon).toBeGreaterThan(-2.1)
      expect(s.lon).toBeLessThan(-0.8)
      expect(['sea', 'land']).toContain(s.surface)
    }
  })
})
