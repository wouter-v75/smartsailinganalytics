import { describe, expect, it } from 'vitest'
import { parseIspraWindCsv, ispraHeightFromDeployment, type IspraStation } from '../ispraRmn'
import { OBS_SOURCES } from '../windObs'

// Napoli as the LOD describes it: platform 40.84141/14.26919, anemometer
// height declared 10 m by hasSystemDeployment.
const NAPOLI: IspraStation = {
  slug: 'napoli', name: 'Napoli', lat: 40.84141, lon: 14.26919, heightM: 10,
}
const NOW = Date.parse('2026-10-23T12:00:00Z')

// Copied from rep.isprambiente.it/file/rmn/napoli_wind_201401.csv, including
// the NA-in-WD-at-low-speed rows, which are real and load-bearing.
const CSV = [
  'UTC;WS;WD',
  '2014-01-01 00:10:00;4.4;30',
  '2014-01-01 00:20:00;4.4;31',
  '2014-01-01 00:30:00;4.7;27',
  '2014-01-11 16:40:00;0.1;NA',
  '2014-01-11 16:50:00;0.2;NA',
].join('\n')

describe('parseIspraWindCsv', () => {
  it('reads the real file shape', () => {
    const out = parseIspraWindCsv(CSV, NAPOLI, NOW)
    expect(out).toHaveLength(5)
    expect(out[0].twsKn).toBeCloseTo(4.4 * 1.943844, 4)
    expect(out[0].twdDeg).toBe(30)
    expect(out[0].id).toBe('rmn:napoli')
    expect(out[0].name).toBe('Napoli')
  })

  it('reads the clock as UTC, because the schema names the column UTC', () => {
    const [o] = parseIspraWindCsv(CSV, NAPOLI, NOW)
    expect(o.t).toBe('2014-01-01T00:10:00.000Z')
  })

  it('KEEPS a calm with no direction instead of dropping the row', () => {
    // NA appears in WD exactly where WS is near zero — a vane with too little
    // wind to point, not a broken sensor. Dropping these would delete the
    // calms from a training set, and a calm is a real state of the course.
    const calms = parseIspraWindCsv(CSV, NAPOLI, NOW).filter((o) => o.twdDeg == null)
    expect(calms).toHaveLength(2)
    expect(calms[0].twsKn).toBeCloseTo(0.1 * 1.943844, 4)
  })

  it('drops a row with no SPEED', () => {
    const noSpeed = ['UTC;WS;WD', '2014-01-01 00:10:00;NA;30', '2014-01-01 00:20:00;;31'].join('\n')
    expect(parseIspraWindCsv(noSpeed, NAPOLI, NOW)).toEqual([])
  })

  it('honours the header order rather than assuming it', () => {
    const swapped = ['UTC;WD;WS', '2014-01-01 00:10:00;200;6.0'].join('\n')
    const [o] = parseIspraWindCsv(swapped, NAPOLI, NOW)
    expect(o.twdDeg).toBe(200)
    expect(o.twsKn).toBeCloseTo(6.0 * 1.943844, 4)
  })

  it('refuses a file whose header is not the one we expect', () => {
    // A level file fetched by mistake: UTC;Level. Silently reading column 2 as
    // wind would turn centimetres of tide into knots.
    const level = ['UTC;Level', '2014-03-01 00:00:00;10.5'].join('\n')
    expect(parseIspraWindCsv(level, NAPOLI, NOW)).toEqual([])
  })

  it('carries the DECLARED anemometer height, which no other source gives', () => {
    const [o] = parseIspraWindCsv(CSV, NAPOLI, NOW)
    expect(o.heightM).toBe(10)
  })

  it('files it as land, deliberately, because a port basin is not open sea', () => {
    const [o] = parseIspraWindCsv(CSV, NAPOLI, NOW)
    expect(o.surface).toBe('land')
    expect(o.source).toBe('synop')
    expect(o.trust).toBe(OBS_SOURCES.synop.trust)
  })

  it('reports no gust, because the feed has none', () => {
    expect(parseIspraWindCsv(CSV, NAPOLI, NOW).every((o) => o.gustKn === null)).toBe(true)
  })

  it('refuses a future row and an unparseable stamp', () => {
    const bad = ['UTC;WS;WD', '2099-01-01 00:00:00;5;180', 'not a time;5;180'].join('\n')
    expect(parseIspraWindCsv(bad, NAPOLI, NOW)).toEqual([])
  })

  it('refuses an implausible speed', () => {
    const fast = ['UTC;WS;WD', '2014-01-01 00:10:00;200;180'].join('\n')
    expect(parseIspraWindCsv(fast, NAPOLI, NOW)).toEqual([])
  })

  it('wraps a direction into 0..360', () => {
    const wrap = ['UTC;WS;WD', '2014-01-01 00:10:00;5;365'].join('\n')
    expect(parseIspraWindCsv(wrap, NAPOLI, NOW)[0].twdDeg).toBeCloseTo(5, 6)
  })

  it('survives rubbish', () => {
    expect(parseIspraWindCsv('', NAPOLI, NOW)).toEqual([])
    expect(parseIspraWindCsv('   ', NAPOLI, NOW)).toEqual([])
    expect(parseIspraWindCsv('<html>404</html>', NAPOLI, NOW)).toEqual([])
  })
})

describe('ispraHeightFromDeployment', () => {
  it('reads the height ISPRA encode in the deployment URI', () => {
    expect(ispraHeightFromDeployment(
      'https://w3id.org/italia/env/ld/rmn/systemdeployment/na23_09_anemometer_measurement_height_10_m')).toBe(10)
  })

  it('handles a decimal written with an underscore', () => {
    expect(ispraHeightFromDeployment('.../x_measurement_height_10_5_m')).toBe(10.5)
  })

  it('returns null rather than a guess when the URI says nothing', () => {
    expect(ispraHeightFromDeployment('.../na23_09_tide_gauge_deployment')).toBeNull()
    expect(ispraHeightFromDeployment(null)).toBeNull()
    expect(ispraHeightFromDeployment('')).toBeNull()
  })

  it('rejects an implausible height', () => {
    expect(ispraHeightFromDeployment('.../x_measurement_height_900_m')).toBeNull()
  })
})
