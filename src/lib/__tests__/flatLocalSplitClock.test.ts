// `UtcDate` + `UtcTime`: the navigator layout that splits the timestamp across two
// cells. Before it was recognised, detectLogFormat fell through to flat-NMEA and the
// NMEA parser returned ZERO ROWS without throwing — so four September 2026 days, every
// one of them a lidar day, could not be imported and said nothing about it. A silent
// empty parse is the worst possible failure for a backfill, which is why this is
// pinned down.

import { describe, it, expect } from 'vitest'
import { detectLogFormat, parseLog } from '../logParse'
import { isFlatLocalLog, isFlatOleLog, hasSplitLocalClock } from '../flatLogParse'

/** The real 171-column `_LSB` shape, cut down to what detection and parsing read. */
const SPLIT = [
  'UtcDate,UtcTime,Lat,Lon,MagVar,TWD,TWS,TWA,AWS,AWA,HDG,COG,SOG,BSP,Heel,Trim,MN_CA_25,JIB_CA_25',
  '2026-09-12,11:34:42,41.1623783,9.5603786,3.06,332,5.8,-148,3.4,-68,120,122,6.77,6.21,1.3,0,11.2,9.4',
  '2026-09-12,11:34:43,41.1623800,9.5603800,3.06,333,5.9,-147,3.5,-67,121,123,6.80,6.25,1.4,0,11.3,9.5',
].join('\n')

/** Same day, the one-column `Datetime` layout, for comparison. */
const SINGLE = [
  'Datetime,Lat,Lon,TWD,TWS,TWA,AWS,AWA,Heading,COG,SOG,BoatSpeed,Heel,Trim',
  '2026-09-12 11:34:42,41.1623783,9.5603786,332,5.8,-148,3.4,-68,120,122,6.77,6.21,1.3,0',
].join('\n')

describe('detection', () => {
  it('reads the split pair as flat-local, not flat-NMEA', () => {
    expect(detectLogFormat(SPLIT)).toBe('flat-local')
    expect(isFlatLocalLog(SPLIT)).toBe(true)
  })

  it('does not mistake it for flat-OLE — neither cell is called just `Utc`', () => {
    expect(isFlatOleLog(SPLIT)).toBe(false)
  })

  it('still reads the single-column layout', () => {
    expect(detectLogFormat(SINGLE)).toBe('flat-local')
  })

  it('needs BOTH halves — one alone is not a clock', () => {
    expect(hasSplitLocalClock(['utcdate', 'lat', 'lon'])).toBe(false)
    expect(hasSplitLocalClock(['utctime', 'lat', 'lon'])).toBe(false)
    expect(hasSplitLocalClock(['utcdate', 'utctime'])).toBe(true)
  })

  it('a real `Utc` column still wins — flat-OLE is not hijacked', () => {
    const ole = 'Utc,Lat,Lon,BSP,TWS\n2026-09-12 11:34:42,41.16,9.56,6.2,5.8'
    expect(isFlatOleLog(ole)).toBe(true)
    expect(detectLogFormat(ole)).toBe('flat-ole')
  })
})

describe('parsing', () => {
  it('produces rows — the regression that mattered was ZERO of them', () => {
    const r = parseLog(SPLIT)
    expect(r.rows.length).toBe(2)
  })

  it('joins the two cells into one instant, a second apart', () => {
    const r = parseLog(SPLIT)
    expect(r.rows[1].utc - r.rows[0].utc).toBe(1000)
  })

  it('reads the clock as LOCAL, exactly as the single-column layout does', () => {
    // Identical wall-clock in both layouts must give the identical instant, or the
    // two exports of one day would disagree about when the boat was where.
    expect(parseLog(SPLIT).rows[0].utc).toBe(parseLog(SINGLE).rows[0].utc)
  })

  it('keeps position at full precision — the whole point of the backfill', () => {
    const r = parseLog(SPLIT)
    expect(r.rows[0].lat).toBeCloseTo(41.1623783, 7)
    expect(r.rows[0].lon).toBeCloseTo(9.5603786, 7)
  })

  it('reads the short-name channels this layout uses (BSP/HDG, not BoatSpeed/Heading)', () => {
    const r = parseLog(SPLIT)
    expect(r.rows[0].bsp).toBeCloseTo(6.21, 2)
    expect(r.rows[0].hdg).toBe(120)
    expect(r.rows[0].tws).toBeCloseTo(5.8, 1)
  })

  it('carries the lidar columns through, under the key the cloud stores', () => {
    // The parser normalises `MN_Ca25` to `mnCa25` — the same shape measKey() builds
    // in lidarTables, which is how a phase's stored lidar mean is addressed.
    const r = parseLog(SPLIT) as unknown as { rows: Record<string, unknown>[] }
    expect(r.rows[0].mnCa25).toBeCloseTo(11.2, 1)
    expect(r.rows[0].jibCa25).toBeCloseTo(9.4, 1)
  })

  it('skips a row missing either half rather than inventing an instant', () => {
    const holed = [
      'UtcDate,UtcTime,Lat,Lon,BSP,TWS',
      '2026-09-12,11:34:42,41.16,9.56,6.2,5.8',
      '2026-09-12,,41.16,9.56,6.2,5.8',
      ',11:34:44,41.16,9.56,6.2,5.8',
      '2026-09-12,11:34:45,41.16,9.56,6.2,5.8',
    ].join('\n')
    expect(parseLog(holed).rows.length).toBe(2)
  })
})
