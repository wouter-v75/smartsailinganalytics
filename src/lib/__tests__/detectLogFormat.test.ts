import { describe, it, expect } from 'vitest'
import { detectLogFormat, parseLog } from '../logParse'
// @ts-ignore — JS module
import { isFlatNmeaLog } from '../csvLogParse'

// A legacy N72 export: named Expedition header.
const NMEA_HEADER =
  'Pos[dddmm.mm],dd/mm/yy,hhmmss,Heel,Boatspeed,Aw_angle,c7,c8,c9,Tw_dirn,Tw_angle,' +
  'Tw_speed,c13,c14,c15,c16,c17,c18,Vmg,Ext_sog,c21,Vs_target,Vs_targ%,Twa_targ,' +
  'Vs_perf,Vs_perf%,c27,c28,Dst_line\n' +
  '5030.1234N 00120.5678W,08/02/26,11:56:40,5.1,6.2,32,0,0,0,265,42,12,0,0,0,0,0,0,4.1,6.3,0,6.5,95,42,6.4,97,0,0,0.5\n'

// A header-less legacy export: the parser reads it by fixed position.
const NMEA_HEADERLESS =
  ['5030.1234N 00120.5678W', '08/02/26', '11:56:40', ...Array(26).fill('0')].join(',') + '\n'

describe('isFlatNmeaLog', () => {
  it('recognises a named Expedition header', () => {
    expect(isFlatNmeaLog(NMEA_HEADER)).toBe(true)
  })

  it('recognises a header-less export by its NMEA position and width', () => {
    expect(isFlatNmeaLog(NMEA_HEADERLESS)).toBe(true)
  })

  it('rejects things that merely happen to be CSV', () => {
    expect(isFlatNmeaLog('lat,lon,wind_speed\n50.1,-1.2,12\n')).toBe(false)     // weather export
    expect(isFlatNmeaLog('twa,tws,bsp\n42,12,6.1\n')).toBe(false)               // a polar
    expect(isFlatNmeaLog('name,lat,lon\nmark 1,50.1,-1.2\n')).toBe(false)       // a route
    expect(isFlatNmeaLog('')).toBe(false)
  })

  it('rejects a wide CSV whose first column is not a position', () => {
    expect(isFlatNmeaLog(Array(30).fill('0').join(',') + '\n')).toBe(false)
  })
})

describe('detectLogFormat no longer guesses', () => {
  it('still identifies the legacy format it is meant to', () => {
    expect(detectLogFormat(NMEA_HEADER)).toBe('flat-nmea')
    expect(detectLogFormat(NMEA_HEADERLESS)).toBe('flat-nmea')
  })

  it('calls an unrecognised file unknown, not a legacy N72 log', () => {
    // The glob that found this: 151 weather exports, polars and route files all
    // identified as 'flat-nmea' because it was the fallback.
    expect(detectLogFormat('lat,lon,wind_speed\n50.1,-1.2,12\n')).toBe('unknown')
    expect(detectLogFormat('twa,tws\n42,12\n')).toBe('unknown')
    expect(detectLogFormat('')).toBe('unknown')
    expect(detectLogFormat('just some prose')).toBe('unknown')
  })

  it('still recognises every format that is actually supported', () => {
    expect(detectLogFormat(
      'timestamp,latitude,longitude,sog_kts,cog,hdg_true,heel,trim\r\n' +
      '2026-02-08T11:56:40.049+0100,39.5,2.5,0.4,266,245,-1.8,7.7\r\n')).toBe('vakaros-csv')
    expect(detectLogFormat(
      '<?xml version="1.0"?><gpx version="1.1"><trk><trkseg>' +
      '<trkpt lat="39.5" lon="2.5"><time>2026-02-08T11:00:00Z</time></trkpt>' +
      '</trkseg></trk></gpx>')).toBe('gpx')
  })

  it('returns an empty result for unknown rather than handing it to a parser', () => {
    const p = parseLog('lat,lon,wind_speed\n50.1,-1.2,12\n')
    expect(p.format).toBe('unknown')
    expect(p.rows).toEqual([])
    expect(p.startUtc).toBe(0)
  })
})
