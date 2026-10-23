import { describe, expect, it } from 'vitest'
import {
  parseHillHead, parseNetley, parseCumulus, parseCcoLatest, parseClubFeed,
  CLUB_FEEDS, type ClubStation,
} from '../windObsClubs'
import { OBS_SOURCES } from '../windObs'
import { clubsNear } from '../obsSources'

// 23 Oct 2026, 05:55 UTC — the moment these payloads were captured, so "now"
// for every test is the real "now" they were read at.
const NOW = Date.parse('2026-10-23T05:55:00Z')
const ST: ClubStation = { id: 'club:x', name: 'Test SC', lat: 50.8, lon: -1.3, surface: 'sea' }

describe('Hill Head SC', () => {
  // Captured verbatim. The last dayWindData row and latestArchiveRecord carry
  // the SAME timestamp, which is what identified the column order and unit:
  // 15.641572 -> "16 knots", 21.724406 -> "22 knots", 90 -> "90°".
  const day = {
    latestArchiveRecord: {
      dateTime: '2026-10-23T06:50:00',
      windSpeed: '16 knots', windDirection: '90&#176;', windDirectionOrdinal: 'E',
      windGust: '22 knots', pressure: '982.7 mbar',
    },
    dayWindData: [
      ['2026-10-23T06:45:00', 19.986454, 22.593382, 112.5],
      ['2026-10-23T06:50:00', 15.641572, 21.724406, 90],
    ],
  }

  it('reads the array, not the rounded record', () => {
    const out = parseHillHead(day, ST, NOW)
    expect(out).toHaveLength(2)
    const last = out[out.length - 1]
    expect(last.twsKn).toBeCloseTo(15.641572, 5)
    expect(last.gustKn).toBeCloseTo(21.724406, 5)
    expect(last.twdDeg).toBe(90)
    // The record rounds to what the array says, which is the cross-check.
    expect(Math.round(last.twsKn)).toBe(16)
    expect(Math.round(last.gustKn as number)).toBe(22)
  })

  it('reads the stamp as Europe/London, not UTC', () => {
    // 06:50 BST is 05:50 UTC. Read as UTC it would be an hour in the future,
    // which is the shape of the mistake this project keeps paying for.
    const out = parseHillHead(day, ST, NOW)
    expect(out[1].t).toBe('2026-10-23T05:50:00.000Z')
    expect(out[0].t).toBe('2026-10-23T05:45:00.000Z')
  })

  it('also reads a winter stamp correctly, when London is UTC', () => {
    const winter = {
      ...day,
      dayWindData: [['2026-01-15T06:50:00', 10, 12, 180]],
    }
    expect(parseHillHead(winter, ST, Date.parse('2026-01-15T07:00:00Z'))[0].t)
      .toBe('2026-01-15T06:50:00.000Z')
  })

  it('honours the unit the record states in words', () => {
    const mph = { ...day, latestArchiveRecord: { ...day.latestArchiveRecord, windSpeed: '16 mph' } }
    expect(parseHillHead(mph, ST, NOW)[1].twsKn).toBeCloseTo(15.641572 * 0.868976, 4)
  })

  it('refuses the whole payload when the unit word is not one we know', () => {
    const odd = { ...day, latestArchiveRecord: { ...day.latestArchiveRecord, windSpeed: '16 cubits' } }
    expect(parseHillHead(odd, ST, NOW)).toEqual([])
    expect(parseHillHead({ ...day, latestArchiveRecord: undefined }, ST, NOW)).toEqual([])
  })

  it('skips malformed rows and refuses rubbish', () => {
    const messy = { ...day, dayWindData: [['x', 1, 2, 3], [1, 2], null, ['2026-10-23T06:50:00', 'n/a', 2, 3]] }
    expect(parseHillHead(messy, ST, NOW)).toEqual([])
    expect(parseHillHead(null, ST, NOW)).toEqual([])
    expect(parseHillHead({ dayWindData: 'nope' }, ST, NOW)).toEqual([])
  })
})

describe('Netley SC', () => {
  const live = { cells: { unixEpochSeconds: 1792734552, knotsAverage: 7, knotsGust: 8, bearing: 39 } }

  it('reads epoch seconds as UTC, with no zone to get wrong', () => {
    const [o] = parseNetley(live, ST, NOW)
    expect(o.t).toBe('2026-10-23T05:49:12.000Z')
    expect(o.twsKn).toBe(7)
    expect(o.gustKn).toBe(8)
    expect(o.twdDeg).toBe(39)
    expect(o.trust).toBe(OBS_SOURCES.beacon.trust)
  })

  it('requires the field name that promises knots', () => {
    // A rename is the feed telling us it stopped promising knots.
    const renamed = { cells: { unixEpochSeconds: 1792734552, windAverage: 7, bearing: 39 } }
    expect(parseNetley(renamed, ST, NOW)).toEqual([])
  })

  it('refuses a missing or impossible clock', () => {
    expect(parseNetley({ cells: { knotsAverage: 7 } }, ST, NOW)).toEqual([])
    expect(parseNetley({ cells: { unixEpochSeconds: 0, knotsAverage: 7 } }, ST, NOW)).toEqual([])
    // An hour into the future.
    expect(parseNetley({ cells: { unixEpochSeconds: NOW / 1000 + 3600, knotsAverage: 7 } }, ST, NOW)).toEqual([])
  })

  it('keeps the mean when there is no gust', () => {
    const [o] = parseNetley({ cells: { unixEpochSeconds: 1792734552, knotsAverage: 7, bearing: 39 } }, ST, NOW)
    expect(o.gustKn).toBeNull()
  })
})

describe('Cumulus websitedata.json', () => {
  const hh = {
    location: 'NCI Hengistbury Head',
    update: '23/10/2026 06:40:00',
    windunit: 'kts',
    stationtype: 'Davis WeatherLink Live with a Vantage Pro2 Sensor Suite (wind direction unreliable when wind is in S ro SE)',
    altitude: '38 m',
    wspeed: '13.6', wgust: '23.5', avgbearing: '36', wdir: 'NE',
  }
  const headland: ClubStation = { ...ST, id: 'club:hengistbury', surface: 'land', elevM: 38 }

  it('reads the mean, gust and bearing', () => {
    const [o] = parseCumulus(hh, headland, NOW)
    expect(o.twsKn).toBeCloseTo(13.6, 3)
    expect(o.gustKn).toBeCloseTo(23.5, 3)
    expect(o.twdDeg).toBe(36)
  })

  it('reads dd/mm/yyyy as UK wall time, not mm/dd and not UTC', () => {
    // 23/10 is 23 October. Read as mm/dd it is not a date at all; read as UTC
    // it is an hour late.
    const [o] = parseCumulus(hh, headland, NOW)
    expect(o.t).toBe('2026-10-23T05:40:00.000Z')
  })

  it('honours windunit, because Cumulus is configured per station', () => {
    const mph = { ...hh, windunit: 'mph' }
    expect(parseCumulus(mph, headland, NOW)[0].twsKn).toBeCloseTo(13.6 * 0.868976, 4)
    const mps = { ...hh, windunit: 'm/s' }
    expect(parseCumulus(mps, headland, NOW)[0].twsKn).toBeCloseTo(13.6 * 1.943844, 4)
  })

  it('refuses a unit it does not know rather than assuming knots', () => {
    expect(parseCumulus({ ...hh, windunit: 'furlongs' }, headland, NOW)).toEqual([])
    expect(parseCumulus({ ...hh, windunit: undefined }, headland, NOW)).toEqual([])
  })

  it('records the headland elevation, which is not an anemometer height', () => {
    const [o] = parseCumulus(hh, headland, NOW)
    expect(o.elevM).toBe(38)
    expect(o.heightM).toBeNull()
  })

  it('refuses an unparseable or future update stamp', () => {
    expect(parseCumulus({ ...hh, update: 'just now' }, headland, NOW)).toEqual([])
    expect(parseCumulus({ ...hh, update: '23/10/2026 09:40:00' }, headland, NOW)).toEqual([])
  })
})

describe('CCO latest-met table', () => {
  const table = (headers: string[], cells: string[]) => `
    <table class="table table-striped">
      <tr class="charts_header">${headers.map((h) => `<th>${h}</th>`).join('')}</tr>
      <tr>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>
    </table>`
  const HEAD = ['Time (GMT)', 'Air Pressure (mb)', 'Wind Speed (knots)', 'Wind Speed (ms<sup>-1</sup>)',
    'Gust Speed (knots)', 'Gust Speed (ms<sup>-1</sup>)', 'Wind direction (&#176;)', 'Rainfall (mm)']
  const CELLS = ['23-10-2026 05:40', '980.2', '30.5', '15.7', '39.1', '20.1', '140', '2.77']
  const pier: ClubStation = { ...ST, id: 'cco:sandown' }

  it('reads the row as published, in GMT', () => {
    const [o] = parseCcoLatest(table(HEAD, CELLS), pier, NOW)
    expect(o.twsKn).toBeCloseTo(30.5, 3)
    expect(o.gustKn).toBeCloseTo(39.1, 3)
    expect(o.twdDeg).toBe(140)
    expect(o.t).toBe('2026-10-23T05:40:00.000Z')
    expect(o.source).toBe('synop')
    expect(o.trust).toBe(OBS_SOURCES.synop.trust)
  })

  it('finds its columns by header text, so an inserted column changes nothing', () => {
    // A scraper that counts to the third cell breaks into a plausible WRONG
    // number the day somebody adds a column. This one must not.
    const head = ['Time (GMT)', 'Station', 'Air Pressure (mb)', 'Wind Speed (knots)',
      'Wind Speed (ms<sup>-1</sup>)', 'Gust Speed (knots)', 'Gust Speed (ms<sup>-1</sup>)',
      'Wind direction (&#176;)', 'Rainfall (mm)']
    const cells = ['23-10-2026 05:40', 'Sandown', '980.2', '30.5', '15.7', '39.1', '20.1', '140', '2.77']
    const [o] = parseCcoLatest(table(head, cells), pier, NOW)
    expect(o.twsKn).toBeCloseTo(30.5, 3)
    expect(o.twdDeg).toBe(140)
  })

  it('checks the knots column against the m/s column and refuses a mismatch', () => {
    // The table publishes the same measurement twice; disagreement is a
    // misread, and no other feed here can be checked from inside itself.
    const bad = [...CELLS]
    bad[3] = '9.9' // m/s that is not 30.5 kn
    expect(parseCcoLatest(table(HEAD, bad), pier, NOW)).toEqual([])
    // And agreement within rounding is fine.
    const ok = [...CELLS]
    ok[3] = '15.69'
    expect(parseCcoLatest(table(HEAD, ok), pier, NOW)).toHaveLength(1)
  })

  it('refuses the table if the header stops saying GMT', () => {
    // An hour is not visible in the number; the label is the only warning.
    const local = [...HEAD]
    local[0] = 'Time (local)'
    expect(parseCcoLatest(table(local, CELLS), pier, NOW)).toEqual([])
  })

  it('treats the feed’s own dash as no value', () => {
    const dashed = [...CELLS]
    dashed[4] = '-'
    dashed[5] = '-'
    const [o] = parseCcoLatest(table(HEAD, dashed), pier, NOW)
    expect(o.gustKn).toBeNull()
    expect(o.twsKn).toBeCloseTo(30.5, 3)
  })

  it('refuses rubbish and a missing table', () => {
    expect(parseCcoLatest('<html>no table</html>', pier, NOW)).toEqual([])
    expect(parseCcoLatest('', pier, NOW)).toEqual([])
    expect(parseCcoLatest(table(HEAD, ['bad date', '1', '2', '1.03', '3', '1.5', '4', '5']), pier, NOW)).toEqual([])
  })
})

describe('parseClubFeed', () => {
  it('routes each feed to its own parser', () => {
    const netley = CLUB_FEEDS.find((f) => f.kind === 'netley')!
    const out = parseClubFeed(netley, JSON.stringify(
      { cells: { unixEpochSeconds: 1792734552, knotsAverage: 7, knotsGust: 8, bearing: 39 } }), NOW)
    expect(out).toHaveLength(1)
    expect(out[0].name).toBe('Netley SC')
  })

  it('returns nothing for a body that is not the JSON it expected', () => {
    const netley = CLUB_FEEDS.find((f) => f.kind === 'netley')!
    expect(parseClubFeed(netley, '<html>503 Service Unavailable</html>', NOW)).toEqual([])
  })
})

describe('the club registry', () => {
  it('has unique ids, https urls and plausible positions', () => {
    const ids = CLUB_FEEDS.map((f) => f.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const f of CLUB_FEEDS) {
      expect(f.url.startsWith('https://'), `${f.id} is not https`).toBe(true)
      expect(f.lat).toBeGreaterThan(50.4)
      expect(f.lat).toBeLessThan(51.0)
      expect(f.lon).toBeGreaterThan(-2.1)
      expect(f.lon).toBeLessThan(-0.8)
    }
  })

  it('is found from the Solent and not from another venue', () => {
    expect(clubsNear(50.82, -1.25, 5).map((f) => f.name)).toContain('Hill Head SC')
    expect(clubsNear(33.72, -118.27, 40)).toEqual([])
  })
})
