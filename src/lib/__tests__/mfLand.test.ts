import { describe, expect, it } from 'vitest'
import { parseMfCsv, parseMfStationList, parseMfLand, OBS_SOURCES } from '../windObs'

// Station list in the shape /liste-stations answers with. Cap Camarat is the
// one this was written for: Meteo-France 83101001, 107 m on the headland.
const LIST = [
  'Id_station;Nom_usuel;Latitude;Longitude;Altitude',
  '83101001;CAP CAMARAT;43.186833;6.683333;107',
  '83069001;LE LUC;43.384833;6.387167;80',
  '83031003;CAVALAIRE;43.173000;6.533000;4',
].join('\n')

/** One /station/infrahoraire-6m row. No geography — that comes from the list. */
const obsCsv = (over: Record<string, string> = {}) => {
  const f: Record<string, string> = {
    numer_sta: '83101001',
    validity_time: '2026-10-23T05:30:00Z',
    ff: '9.1',
    dd: '128',
    fxi: '11.4',
    t: '287.3',
    pres: '98120',
    ...over,
  }
  const keys = Object.keys(f)
  return [keys.join(';'), keys.map((k) => f[k]).join(';')].join('\n')
}

describe('parseMfStationList', () => {
  it('carries the altitude, which land stations publish and buoys do not', () => {
    const meta = parseMfStationList(LIST)
    expect(meta.size).toBe(3)
    const cc = meta.get('83101001')!
    expect(cc.name).toBe('CAP CAMARAT')
    expect(cc.lat).toBeCloseTo(43.186833, 5)
    expect(cc.lon).toBeCloseTo(6.683333, 5)
    // 107 m on a headland is not a sea-level wind, and this is the field the
    // pipeline already understands for that.
    expect(cc.alt).toBe(107)
  })
})

describe('parseMfLand', () => {
  const meta = parseMfStationList(LIST)

  it('reads ff as m/s, dd as degrees and fxi as the gust', () => {
    const [o] = parseMfLand(parseMfCsv(obsCsv()), meta)
    expect(o.twsKn).toBeCloseTo(9.1 * 1.943844, 4)
    expect(o.twdDeg).toBe(128)
    expect(o.gustKn).toBeCloseTo(11.4 * 1.943844, 4)
  })

  it('also accepts fx, which some stations use instead of fxi', () => {
    const [o] = parseMfLand(parseMfCsv(obsCsv({ fxi: '', fx: '12.0' })), meta)
    expect(o.gustKn).toBeCloseTo(12.0 * 1.943844, 4)
  })

  it('takes position and altitude from the station list, since the row has none', () => {
    const [o] = parseMfLand(parseMfCsv(obsCsv()), meta)
    expect(o.lat).toBeCloseTo(43.186833, 5)
    expect(o.lon).toBeCloseTo(6.683333, 5)
    expect(o.elevM).toBe(107)
    expect(o.name).toBe('CAP CAMARAT')
    expect(o.id).toBe('mf-land:83101001')
  })

  it('files it as a land synop station', () => {
    const [o] = parseMfLand(parseMfCsv(obsCsv()), meta)
    expect(o.source).toBe('synop')
    expect(o.surface).toBe('land')
    expect(o.trust).toBe(OBS_SOURCES.synop.trust)
    expect(o.heightM).toBe(OBS_SOURCES.synop.heightM)
  })

  it('refuses a timestamp with no zone marker rather than shifting it', () => {
    // The mistake this project keeps paying for. isoFromMf refuses an
    // unmarked stamp, so the station goes quiet VISIBLY instead of reading an
    // hour out.
    expect(parseMfLand(parseMfCsv(obsCsv({ validity_time: '2026-10-23 05:30:00' })), meta)).toEqual([])
    expect(parseMfLand(parseMfCsv(obsCsv({ validity_time: 'nonsense' })), meta)).toEqual([])
  })

  it('drops a row with no wind, which is what a station without an anemometer looks like', () => {
    expect(parseMfLand(parseMfCsv(obsCsv({ ff: '' })), meta)).toEqual([])
  })

  it('keeps the mean when direction or gust are absent', () => {
    const [o] = parseMfLand(parseMfCsv(obsCsv({ dd: '', fxi: '' })), meta)
    expect(o.twsKn).toBeCloseTo(9.1 * 1.943844, 4)
    expect(o.twdDeg).toBeNull()
    expect(o.gustKn).toBeNull()
  })

  it('refuses a station it has no position for', () => {
    const unknown = parseMfCsv(obsCsv({ numer_sta: '99999999' }))
    expect(parseMfLand(unknown, meta)).toEqual([])
  })

  it('refuses an implausible speed', () => {
    expect(parseMfLand(parseMfCsv(obsCsv({ ff: '200' })), meta)).toEqual([])
  })

  it('wraps a direction into 0..360', () => {
    expect(parseMfLand(parseMfCsv(obsCsv({ dd: '365' })), meta)[0].twdDeg).toBeCloseTo(5, 6)
  })

  it('survives rubbish', () => {
    expect(parseMfLand([], meta)).toEqual([])
    expect(parseMfLand([null, 'x', 7] as unknown[], meta)).toEqual([])
    expect(parseMfLand(parseMfCsv(''), meta)).toEqual([])
  })

  it('returns one observation per row, so a station history comes through whole', () => {
    const multi = [
      'numer_sta;validity_time;ff;dd',
      '83101001;2026-10-23T05:00:00Z;8.0;120',
      '83101001;2026-10-23T05:06:00Z;8.5;124',
      '83101001;2026-10-23T05:12:00Z;9.0;128',
    ].join('\n')
    const out = parseMfLand(parseMfCsv(multi), meta)
    expect(out).toHaveLength(3)
    expect(out.map((o) => o.t)).toEqual([
      '2026-10-23T05:00:00.000Z', '2026-10-23T05:06:00.000Z', '2026-10-23T05:12:00.000Z',
    ])
  })
})
