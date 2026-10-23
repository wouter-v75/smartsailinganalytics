import { describe, expect, it } from 'vitest'
import { parseMfCsv, parseMfStationList, parseMfLand, OBS_SOURCES } from '../windObs'

// BOTH FIXTURES ARE THE REAL HEADERS, taken off the live API on 23 Oct 2026
// by scripts/mf-land-probe.ts. They were invented before that and both were
// wrong in ways that silently emptied the source, so they are copied now
// rather than reasoned about:
//
//   /liste-stations          Id_station;Id_omm;Nom_usuel;Latitude;Longitude;Altitude;Date_ouverture;Pack
//   /station/infrahoraire-6m lat;lon;geo_id_insee;reference_time;insert_time;validity_time;t;td;u;dd;ff;ddraf10;raf10;rr_per;…
//
// The two do not agree on what to call the station, and the gust is raf10.
const LIST = [
  'Id_station;Id_omm;Nom_usuel;Latitude;Longitude;Altitude;Date_ouverture;Pack',
  '83101001;;CAP CAMARAT;43.2005;6.6745;107;1982-04-01;RADOME',
  '83031001;07591;LE LUC;43.384833;6.387167;80;1950-01-01;RADOME',
  '83042001;;COGOLIN_SAPC;43.25;6.53;10;2000-01-01;SAPC',
].join('\n')

/**
 * One /station/infrahoraire-6m row for Cap Camarat, which is a WIND-ONLY
 * station: its row carries dd, ff, ddraf10 and raf10 and no temperature at
 * all, where Le Luc's carries t, td, u, pressure and the rest.
 */
const obsCsv = (over: Record<string, string> = {}) => {
  const f: Record<string, string> = {
    lat: '43.2005',
    lon: '6.6745',
    geo_id_insee: '83101001',
    reference_time: '2026-10-23T05:30:00Z',
    insert_time: '2026-10-23T05:31:12Z',
    validity_time: '2026-10-23T05:30:00Z',
    dd: '128',
    ff: '9.1',
    ddraf10: '131',
    raf10: '11.4',
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
    expect(cc.lat).toBeCloseTo(43.2005, 4)
    expect(cc.lon).toBeCloseTo(6.6745, 4)
    // 107 m on a headland is not a sea-level wind, and this is the field the
    // pipeline already understands for that.
    expect(cc.alt).toBe(107)
  })
})

describe('parseMfLand', () => {
  const meta = parseMfStationList(LIST)

  it('reads ff as m/s, dd as degrees and RAF10 as the gust', () => {
    const [o] = parseMfLand(parseMfCsv(obsCsv()), meta)
    expect(o.twsKn).toBeCloseTo(9.1 * 1.943844, 4)
    expect(o.twdDeg).toBe(128)
    // raf10, not fxi/fx/rafper. Getting this wrong loses the gust silently.
    expect(o.gustKn).toBeCloseTo(11.4 * 1.943844, 4)
  })

  it('finds the station by geo_id_insee, which is what the rows carry', () => {
    // The list says Id_station and the rows say geo_id_insee. This was the bug
    // that returned nothing for every station in the network.
    const [o] = parseMfLand(parseMfCsv(obsCsv()), meta)
    expect(o.id).toBe('mf-land:83101001')
    expect(o.name).toBe('CAP CAMARAT')
    expect(o.elevM).toBe(107)
  })

  it('prefers the id the CALLER asked for over whatever the row calls itself', () => {
    // A per-station query already knows which station it asked for, and the
    // metadata is keyed on the list's id. Nothing promises the two strings
    // match, so the caller's wins.
    const odd = parseMfCsv(obsCsv({ geo_id_insee: '83101' }))
    // Left to itself the row is a nameless station with no altitude...
    const [loose] = parseMfLand(odd, meta)
    expect(loose.name).toBe('MF 83101')
    expect(loose.elevM).toBeNull()
    // ...and told which station was asked for, it is Cap Camarat on a headland.
    const [o] = parseMfLand(odd, meta, { stationId: '83101001' })
    expect(o.id).toBe('mf-land:83101001')
    expect(o.name).toBe('CAP CAMARAT')
    expect(o.elevM).toBe(107)
  })

  it('takes the altitude from the list, and the position from whichever has it', () => {
    // The rows DO carry lat/lon, unlike the ship feed. The altitude only ever
    // comes from the list.
    const [o] = parseMfLand(parseMfCsv(obsCsv()), meta)
    expect(o.lat).toBeCloseTo(43.2005, 4)
    expect(o.lon).toBeCloseTo(6.6745, 4)
    expect(o.elevM).toBe(107)
    const noPos = parseMfCsv(obsCsv({ lat: '', lon: '' }))
    expect(parseMfLand(noPos, meta)[0].lat).toBeCloseTo(43.2005, 4)
  })

  it('drops a rain-and-temperature station, which many of them are', () => {
    // COGOLIN_SAPC, LES ARCS and LES MAYONS answer with t and rr_per only.
    // Seven of the ten nearest to the Golfe de Saint-Tropez carry wind.
    const tempOnly = ['lat;lon;geo_id_insee;validity_time;t;rr_per',
      '43.25;6.53;83042001;2026-10-23T05:30:00Z;287.1;0'].join('\n')
    expect(parseMfLand(parseMfCsv(tempOnly), meta)).toEqual([])
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
    const [o] = parseMfLand(parseMfCsv(obsCsv({ dd: '', raf10: '' })), meta)
    expect(o.twsKn).toBeCloseTo(9.1 * 1.943844, 4)
    expect(o.twdDeg).toBeNull()
    expect(o.gustKn).toBeNull()
  })

  it('still parses a station missing from the list, using the row\u2019s own position', () => {
    // No name and no altitude, but a real reading is better than none.
    const [o] = parseMfLand(parseMfCsv(obsCsv({ geo_id_insee: '99999999' })), meta)
    expect(o.id).toBe('mf-land:99999999')
    expect(o.name).toBe('MF 99999999')
    expect(o.elevM).toBeNull()
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
      'lat;lon;geo_id_insee;validity_time;ff;dd',
      '43.2005;6.6745;83101001;2026-10-23T05:00:00Z;8.0;120',
      '43.2005;6.6745;83101001;2026-10-23T05:06:00Z;8.5;124',
      '43.2005;6.6745;83101001;2026-10-23T05:12:00Z;9.0;128',
    ].join('\n')
    const out = parseMfLand(parseMfCsv(multi), meta)
    expect(out).toHaveLength(3)
    expect(out.map((o) => o.t)).toEqual([
      '2026-10-23T05:00:00.000Z', '2026-10-23T05:06:00.000Z', '2026-10-23T05:12:00.000Z',
    ])
  })
})
