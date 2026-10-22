import { describe, it, expect } from 'vitest'
import {
  parseMetar, parseFfvl, isoFromFfvl, to10m, obs10mKn, ageMinutes, isStale, withinNm, OBS_SOURCES,
  parseMfCsv, parseMfMarine, parseMfStationList, latestPerStation, isoFromMf,
  parseNdbc, parseNdbcStations, ndbcIsBuoy,
  parseNdbcHistory, toObsPoints, withinHours, parsePioupiou,
} from '../windObs'

// Captured live from aviationweather.gov on 2026-10-18, bbox around St Tropez.
// Trimmed to the fields the adapter reads, values untouched.
const METAR_LIVE = [
  { icaoId: 'LFMD', obsTime: 1792306800, wdir: 360, wspd: 5, lat: 43.544, lon: 6.953, elev: 2, name: 'Cannes/Mandelieu Arpt, PA, FR' },
  { icaoId: 'LFMC', obsTime: 1792306800, wdir: 'VRB', wspd: 1, lat: 43.383, lon: 6.386, elev: 79, name: 'Le Luc Arpt, PA, FR' },
  { icaoId: 'LFTH', obsTime: 1792306800, wdir: 320, wspd: 6, wgst: 18, lat: 43.094, lon: 6.146, elev: 3, name: 'Toulon/Hyères Arpt, PA, FR' },
]

describe('parseMetar', () => {
  it('reads the live payload', () => {
    const o = parseMetar(METAR_LIVE)
    expect(o.map((x) => x.id)).toEqual(['metar:LFMD', 'metar:LFMC', 'metar:LFTH'])
    expect(o[0]).toMatchObject({ source: 'metar', twsKn: 5, twdDeg: 360, heightM: 10, surface: 'land', elevM: 2 })
    expect(o[0].t).toBe('2026-10-18T07:00:00.000Z')
    expect(o[2].gustKn).toBe(18)
  })

  it('does not point a VARIABLE wind at north', () => {
    // wdir comes back as the STRING "VRB" — Number("VRB") is NaN, and a NaN that
    // reaches the map draws a barb pointing somewhere definite and wrong.
    const vrb = parseMetar(METAR_LIVE)[1]
    expect(vrb.twdDeg).toBeNull()
    expect(vrb.twsKn).toBe(1)          // the SPEED is still a real measurement
  })

  it('reports a northerly as 360, not 0 — caught live at Cannes', () => {
    // wdir 360 through a bare modulo becomes 0, and the tooltip reads "from 0°".
    // 000 is only ever calm in a METAR, so the two must not collapse together.
    expect(parseMetar(METAR_LIVE)[0].twdDeg).toBe(360)
    expect(parseMetar([{ icaoId: 'N', obsTime: 1792306800, wdir: 0, wspd: 7, lat: 43, lon: 6 }])[0].twdDeg).toBe(360)
  })

  it('treats 00000KT as calm, not as a northerly', () => {
    const calm = parseMetar([{ icaoId: 'XXXX', obsTime: 1792306800, wdir: 0, wspd: 0, lat: 43, lon: 6 }])[0]
    expect(calm.twsKn).toBe(0)
    expect(calm.twdDeg).toBeNull()
  })

  it('drops rows that carry no wind at all, and survives junk', () => {
    expect(parseMetar([{ icaoId: 'NOWIND', obsTime: 1792306800, lat: 43, lon: 6 }])).toHaveLength(0)
    expect(parseMetar([{ icaoId: 'NOPOS', obsTime: 1792306800, wspd: 9 }])).toHaveLength(0)
    expect(parseMetar([])).toHaveLength(0)
    expect(parseMetar(null as never)).toHaveLength(0)
    expect(parseMetar([null, 'x', 42] as never)).toHaveLength(0)
  })
})

describe('to10m', () => {
  it('leaves a 10 m reading alone', () => {
    expect(to10m(12, 10, 'land')).toBeCloseTo(12, 12)
    expect(to10m(12, 10, 'sea')).toBeCloseTo(12, 12)
  })

  it('scales a mast reading DOWN and a low one UP', () => {
    expect(to10m(12, 20, 'land')!).toBeLessThan(12)
    expect(to10m(12, 4, 'land')!).toBeGreaterThan(12)
  })

  it('corrects less over water, because the sea is smoother', () => {
    // Same 20 m mast: over a rough land surface the profile is steeper, so the
    // step down to 10 m is bigger.
    const land = 12 - to10m(12, 20, 'land')!
    const sea = 12 - to10m(12, 20, 'sea')!
    expect(land).toBeGreaterThan(sea)
  })

  it('refuses to correct what it cannot know', () => {
    // A guessed height is worse than no correction: it looks like a measurement.
    expect(to10m(12, null, 'land')).toBeNull()
    expect(to10m(12, 0, 'land')).toBeNull()
    expect(to10m(null, 10, 'land')).toBeNull()
    expect(to10m(-1, 10, 'land')).toBeNull()
    expect(to10m(12, 0.001, 'land')).toBeNull()      // below the roughness length
  })

  it('obs10mKn is null for a station with no published height', () => {
    const [beacon] = parseFfvl([{ idbalise: 7, latitude: 43.1, longitude: 6.2, vitesseVentMoy: 37, directVentMoy: 270, date: '2026-10-18 09:00:00' }])
    expect(beacon.heightM).toBeNull()
    expect(obs10mKn(beacon)).toBeNull()
    expect(beacon.twsKn).toBeCloseTo(37 * 0.539957, 6)   // as measured, still there
  })
})

describe('parseFfvl', () => {
  it('converts km/h to knots and joins the metadata on balise id', () => {
    const o = parseFfvl(
      [{ idbalise: 12, latitude: 43.12, longitude: 6.14, vitesseVentMoy: 18.52, vitesseVentMax: 27.78, directVentMoy: 315, date: '2026-10-18 09:05:00' }],
      [{ idBalise: 12, nom: 'Hyères plage', altitude: 4 }],
    )
    expect(o).toHaveLength(1)
    expect(o[0].name).toBe('Hyères plage')
    expect(o[0].elevM).toBe(4)
    expect(o[0].twsKn).toBeCloseTo(10, 2)
    expect(o[0].gustKn).toBeCloseTo(15, 2)
    expect(o[0].source).toBe('beacon')
  })

  it('still reports a beacon whose metadata is missing', () => {
    const o = parseFfvl([{ idbalise: 99, latitude: 43, longitude: 6, vitesseVentMoy: 10, date: '2026-10-18 09:05:00' }])
    expect(o[0].name).toBe('FFVL 99')
    expect(o[0].elevM).toBeNull()
  })
})

describe('isoFromFfvl', () => {
  it('does not read a zone-less local stamp as UTC', () => {
    // Paris is +2 in October BST/CEST; read as UTC the beacon looks 2 h fresher
    // than it is, then goes abruptly stale. Same trap as the log exports.
    expect(isoFromFfvl('2026-10-18 09:05:00', 2)).toBe('2026-10-18T07:05:00.000Z')
    expect(isoFromFfvl('2026-10-18 09:05:00', 0)).toBe('2026-10-18T09:05:00.000Z')
  })
  it('returns null rather than an Invalid Date', () => {
    expect(isoFromFfvl('not a time')).toBeNull()
  })
})

describe('age and staleness', () => {
  const now = Date.parse('2026-10-18T09:00:00Z')
  const at = (iso: string) => parseMetar([{ icaoId: 'A', obsTime: Date.parse(iso) / 1000, wdir: 10, wspd: 10, lat: 43, lon: 6 }])[0]

  it('measures age in minutes', () => {
    expect(ageMinutes(at('2026-10-18T08:30:00Z'), now)).toBeCloseTo(30, 6)
  })
  it('calls a station stale once it is lying rather than reporting', () => {
    expect(isStale(at('2026-10-18T08:30:00Z'), now)).toBe(false)
    expect(isStale(at('2026-10-18T06:00:00Z'), now)).toBe(true)
  })
})

describe('withinNm', () => {
  it('keeps the nearby stations, nearest first, and drops the far ones', () => {
    const o = parseMetar(METAR_LIVE)
    // Measured from point 1: Le Luc 14.3 nm, Cannes 20.1, Hyeres 25.6.
    const near = withinNm(o, 43.275, 6.678, 30)          // point 1, St Tropez
    expect(near.map((x) => x.id)).toEqual(['metar:LFMC', 'metar:LFMD', 'metar:LFTH'])
    expect(withinNm(o, 43.275, 6.678, 15).map((x) => x.id)).toEqual(['metar:LFMC'])
    expect(withinNm(o, 43.275, 6.678, 1)).toHaveLength(0)
    const d = near.map((x) => Math.hypot((x.lat - 43.275) * 60, (x.lon - 6.678) * 60 * Math.cos(43.275 * Math.PI / 180)))
    expect([...d].sort((a, b) => a - b)).toEqual(d)
  })
})

describe('OBS_SOURCES', () => {
  it('ranks our own boat above a buoy above a rooftop', () => {
    expect(OBS_SOURCES.ours.trust).toBeGreaterThan(OBS_SOURCES.buoy.trust)
    expect(OBS_SOURCES.buoy.trust).toBeGreaterThan(OBS_SOURCES.metar.trust)
    expect(OBS_SOURCES.metar.trust).toBeGreaterThan(OBS_SOURCES.pws.trust)
  })
  it('gives every source a distinct colour, since that is the whole legend', () => {
    const cols = Object.values(OBS_SOURCES).map((s) => s.colour)
    expect(new Set(cols).size).toBe(cols.length)
  })
})

// ── Météo-France marine ─────────────────────────────────────────────────────
// Captured live from DPObs v2 /liste-bouees on 2026-10-22 by
// scripts/mf-obs-probe.ts. Header and rows verbatim — including the EMPTY pmer
// cell in the first row, which is the whole reason parseMfCsv may not coerce a
// blank to zero.
const MF_BUOY_CSV = [
  'lat;lon;geo_id_wmo;geo_id_wigos;name;reference_time;insert_time;validity_time;t;td;u;dd;ff;pmer;tmer;haut_vag;per_moy_vag;dir_vag;rafper;per',
  '16.23;-59.16;4100230;0-250-0-97110001;BOUEE_ANTILLES;2026-10-21T02:08:05Z;2026-10-21T02:03:20Z;2026-10-21T02:00:00Z;302.15;297.95;78.0;110.0;3.9;;302.75;1.4;6.0;65.0;5.6;-10',
  '16.23;-59.16;4100230;0-250-0-97110001;BOUEE_ANTILLES;2026-10-21T14:08:04Z;2026-10-21T14:03:22Z;2026-10-21T13:00:00Z;302.25;297.85;77.0;100.0;2.1;101470.0;302.75;1.3;7.0;60.0;3.4;-10',
].join('\n')

// /liste-bateaux, same day. Note it really IS a list: no position, no wind.
const MF_SHIP_LIST_CSV = [
  'geo_id_wmo;geo_id_wigos;name',
  'ADFBKUM;0-22000-0-ADFBKUM;AKNOUL',
  'CNGUSYM;0-22000-0-CNGUSYM;COTES DE LA MANCHE',
].join('\n')

describe('parseMfCsv', () => {
  it('reads the live semicolon header', () => {
    const rows = parseMfCsv(MF_BUOY_CSV)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ lat: 16.23, lon: -59.16, dd: 110, ff: 3.9, rafper: 5.6 })
  })

  it('leaves an EMPTY cell absent rather than reading it as zero', () => {
    // Number('') is 0. A missing sea-level pressure silently becoming 0 Pa is
    // exactly the kind of thing that is never noticed.
    const [first, second] = parseMfCsv(MF_BUOY_CSV)
    expect('pmer' in first).toBe(false)
    expect(second.pmer).toBe(101470)
  })

  it('keeps an id as a STRING, whether it looks numeric or not', () => {
    // geo_id_wmo is "4100230" for a buoy and "ADFBKUM" for a ship. Coercing the
    // first would eat a leading zero and make the two kinds behave differently.
    expect(parseMfCsv(MF_BUOY_CSV)[0].geo_id_wmo).toBe('4100230')
    expect(parseMfCsv(MF_SHIP_LIST_CSV)[0].geo_id_wmo).toBe('ADFBKUM')
  })

  it('survives junk', () => {
    expect(parseMfCsv('')).toHaveLength(0)
    expect(parseMfCsv('only;a;header')).toHaveLength(0)
    expect(parseMfCsv(null as never)).toHaveLength(0)
  })
})

describe('parseMfMarine', () => {
  it('reads the live buoy row', () => {
    const o = parseMfMarine(parseMfCsv(MF_BUOY_CSV), 'buoy')
    expect(o).toHaveLength(2)
    expect(o[0]).toMatchObject({
      id: 'mf-buoy:4100230', source: 'buoy', name: 'BOUEE_ANTILLES',
      lat: 16.23, lon: -59.16, surface: 'sea', twdDeg: 110,
    })
    expect(o[0].twsKn).toBeCloseTo(3.9 * 1.943844, 6)      // 7.6 kn
    expect(o[0].gustKn!).toBeCloseTo(5.6 * 1.943844, 6)    // rafper, not fxi
    expect(o[0].t).toBe('2026-10-21T02:00:00.000Z')
    expect(o[0].trust).toBe(OBS_SOURCES.buoy.trust)
  })

  it('publishes no anemometer height, and sits at sea level', () => {
    // No height = no correction (to10m refuses it), which is the honest answer:
    // MF does not say how high a buoy's anemometer is. elevM is 0 because the
    // thing floats — its ground level IS the water the race is on.
    const [o] = parseMfMarine(parseMfCsv(MF_BUOY_CSV), 'buoy')
    expect(o.heightM).toBeNull()
    expect(o.elevM).toBe(0)
    expect(obs10mKn(o)).toBeNull()
  })

  it('reads the same shape as a ship when told to', () => {
    const [o] = parseMfMarine(parseMfCsv(MF_BUOY_CSV), 'ship')
    expect(o.id).toBe('mf-ship:4100230')
    expect(o.trust).toBe(OBS_SOURCES.ship.trust)
    expect(OBS_SOURCES.ship.trust).toBeLessThan(OBS_SOURCES.buoy.trust)
  })

  it('names a ship from the list, which is all the list carries', () => {
    const meta = parseMfStationList(MF_SHIP_LIST_CSV)
    const row = [{ geo_id_wmo: 'CNGUSYM', lat: 49.9, lon: -1.2, ff: 6, dd: 250, validity_time: '2026-10-21T13:00:00Z' }]
    const [o] = parseMfMarine(row, 'ship', meta)
    expect(o.name).toBe('COTES DE LA MANCHE')
  })

  it('REFUSES a speed that implies the wrong unit', () => {
    // The corroboration that ff is m/s is that t comes back as 302.15 K and pmer
    // as 101470 Pa — the feed is SI throughout. If it were ever km/h, every
    // speed would be 3.6x too big and still plausible in light airs.
    const fast = parseMfCsv(MF_BUOY_CSV.replace(';3.9;;', ';70;;'))
    expect(parseMfMarine(fast, 'buoy').filter((o) => o.t.endsWith('02:00:00.000Z'))).toHaveLength(0)
  })

  it('drops an implausible GUST without losing the mean wind', () => {
    const [o] = parseMfMarine([{ geo_id_wmo: 'X', lat: 16, lon: -59, ff: 3.9, rafper: 99, validity_time: '2026-10-21T02:00:00Z' }], 'buoy')
    expect(o.gustKn).toBeNull()
    expect(o.twsKn).toBeCloseTo(3.9 * 1.943844, 6)
  })

  it('treats calm as calm, not as a southerly', () => {
    const [o] = parseMfMarine([{ geo_id_wmo: 'X', lat: 16, lon: -59, ff: 0, dd: 180, validity_time: '2026-10-21T02:00:00Z' }], 'buoy')
    expect(o.twsKn).toBe(0)
    expect(o.twdDeg).toBeNull()
  })

  it('survives junk and drops rows with no wind, id or position', () => {
    expect(parseMfMarine([], 'buoy')).toHaveLength(0)
    expect(parseMfMarine(null as never, 'buoy')).toHaveLength(0)
    expect(parseMfMarine([null, 'x', 7] as never, 'buoy')).toHaveLength(0)
    expect(parseMfMarine([{ lat: 16, lon: -59, ff: 5, validity_time: '2026-10-21T02:00:00Z' }], 'buoy')).toHaveLength(0)
    expect(parseMfMarine([{ geo_id_wmo: 'X', ff: 5, validity_time: '2026-10-21T02:00:00Z' }], 'buoy')).toHaveLength(0)
  })
})

describe('latestPerStation', () => {
  it('keeps the newest reading per buoy, not both', () => {
    // The live file held the SAME buoy at 02:00 and 13:00. Drawing both puts
    // this morning's wind on the map beside this afternoon's.
    const all = parseMfMarine(parseMfCsv(MF_BUOY_CSV), 'buoy')
    expect(all).toHaveLength(2)
    const latest = latestPerStation(all)
    expect(latest).toHaveLength(1)
    expect(latest[0].t).toBe('2026-10-21T13:00:00.000Z')
    expect(latest[0].twsKn).toBeCloseTo(2.1 * 1.943844, 6)
  })

  it('leaves distinct stations alone', () => {
    const a = parseMfMarine([{ geo_id_wmo: 'A', lat: 1, lon: 1, ff: 5, validity_time: '2026-10-21T02:00:00Z' }], 'buoy')
    const b = parseMfMarine([{ geo_id_wmo: 'B', lat: 2, lon: 2, ff: 5, validity_time: '2026-10-21T02:00:00Z' }], 'buoy')
    expect(latestPerStation([...a, ...b])).toHaveLength(2)
  })
})

describe('isoFromMf', () => {
  it('keeps a zoned stamp', () => {
    expect(isoFromMf('2026-10-21T02:00:00Z')).toBe('2026-10-21T02:00:00.000Z')
    expect(isoFromMf('2026-10-21T04:00:00+02:00')).toBe('2026-10-21T02:00:00.000Z')
  })
  it('REFUSES a zone-less stamp rather than assuming UTC', () => {
    // CLAUDE.md's standing trap: every other clock in this project is venue-local
    // even when it is called UTC. If MF ever drops the Z, silence beats a reading
    // that is two hours out and looks fresh.
    expect(isoFromMf('2026-10-21 02:00:00')).toBeNull()
    expect(isoFromMf('not a time')).toBeNull()
  })
})

describe('parseMfStationList', () => {
  it('reads the live ship list', () => {
    const m = parseMfStationList(MF_SHIP_LIST_CSV)
    expect(m.size).toBe(2)
    expect(m.get('ADFBKUM')).toEqual({ name: 'AKNOUL', lat: undefined, lon: undefined })
  })
  it('returns an empty map rather than throwing on junk', () => {
    expect(parseMfStationList('').size).toBe(0)
    expect(parseMfStationList('nothing;useful\n1;2\n').size).toBe(0)
    expect(parseMfStationList(null as never).size).toBe(0)
  })
})

// ── NDBC ────────────────────────────────────────────────────────────────────
// Captured live from www.ndbc.noaa.gov/data/latest_obs/latest_obs.txt on
// 2026-10-22. Verbatim, including 46222 — a Waverider in San Pedro Bay with MM
// in every wind column, which is most of what is in this file.
const NDBC_LIVE = [
  '#STN       LAT      LON  YYYY MM DD hh mm WDIR WSPD   GST WVHT  DPD APD MWD   PRES  PTDY  ATMP  WTMP  DEWP  VIS   TIDE',
  '#text      deg      deg   yr mo day hr mn degT  m/s   m/s   m   sec sec degT   hPa   hPa  degC  degC  degC  nmi     ft',
  '46088    48.332 -123.179 2026 10 22 08 50 260   6.0   8.0  0.6   4  3.2 242 1012.8    MM  10.6    MM   9.7   MM     MM',
  '46222    33.614 -118.314 2026 10 22 08 56  MM    MM    MM  1.5  12  6.0 254     MM    MM    MM  22.8    MM   MM     MM',
  'FRDW1    48.545 -123.012 2026 10 22 08 36  MM   0.0   1.0   MM  MM   MM  MM 1013.3    MM   7.9    MM    MM   MM     MM',
  'SISW1    48.321 -122.831 2026 10 22 08 50 270   7.2   8.8   MM  MM   MM  MM 1012.5    MM  10.7    MM   9.7   MM     MM',
].join('\n')

const NDBC_STATIONS_LIVE = [
  '# STATION_ID | OWNER | TTYPE | HULL | NAME | PAYLOAD | LOCATION | TIMEZONE | FORECAST | NOTE',
  '#',
  '46088|N|3-meter discus buoy w/ seal cage|3D02|NEW DUNGENESS - 17 NM NE of Port Angeles, WA',
  '46222|R|Waverider Buoy||San Pedro, CA (092)',
  'frdw1|O|Water Level Observation Network||9449880 - Friday Harbor, WA',
  'sisw1|N|C-MAN Station||Smith Island, WA',
].join('\n')

describe('parseNdbcStations', () => {
  it('reads the pipe table and lowercases the id', () => {
    // The observations say SISW1 and the table says sisw1. Join on the raw case
    // and every station silently loses its name and its type.
    const m = parseNdbcStations(NDBC_STATIONS_LIVE)
    expect(m.get('sisw1')).toEqual({ ttype: 'C-MAN Station', name: 'Smith Island, WA' })
    expect(m.get('46088')!.ttype).toBe('3-meter discus buoy w/ seal cage')
    expect(m.get('SISW1')).toBeUndefined()
  })
})

describe('ndbcIsBuoy', () => {
  it('believes TTYPE where there is one', () => {
    expect(ndbcIsBuoy('46088', '3-meter discus buoy w/ seal cage')).toBe(true)
    expect(ndbcIsBuoy('46222', 'Waverider Buoy')).toBe(true)
    expect(ndbcIsBuoy('SISW1', 'C-MAN Station')).toBe(false)
    // A tide gauge on a pier is not floating, whatever its neighbours are.
    expect(ndbcIsBuoy('FRDW1', 'Water Level Observation Network')).toBe(false)
    expect(ndbcIsBuoy('OILP1', 'Oil Platform')).toBe(false)
  })
  it('falls back to the id shape with no metadata', () => {
    expect(ndbcIsBuoy('46088')).toBe(true)
    expect(ndbcIsBuoy('SISW1')).toBe(false)
  })
})

describe('parseNdbc', () => {
  const meta = parseNdbcStations(NDBC_STATIONS_LIVE)

  it('drops the stations with no anemometer', () => {
    // 46222 is a Waverider: MM in every wind column. Most of this file is like
    // that — 14 stations within 25 nm of San Pedro, 8 with wind.
    const ids = parseNdbc(NDBC_LIVE, meta).map((o) => o.id)
    expect(ids).not.toContain('ndbc:46222')
    expect(ids).toEqual(['ndbc:46088', 'ndbc:FRDW1', 'ndbc:SISW1'])
  })

  it('reads a buoy as floating, in knots, at the stamped UTC minute', () => {
    const [b] = parseNdbc(NDBC_LIVE, meta)
    expect(b).toMatchObject({
      id: 'ndbc:46088', source: 'buoy', surface: 'sea', elevM: 0,
      lat: 48.332, lon: -123.179, twdDeg: 260,
      name: 'NEW DUNGENESS - 17 NM NE of Port Angeles, WA',
    })
    expect(b.twsKn).toBeCloseTo(6.0 * 1.943844, 6)     // 11.7 kn
    expect(b.gustKn!).toBeCloseTo(8.0 * 1.943844, 6)
    expect(b.t).toBe('2026-10-22T08:50:00.000Z')
    expect(b.trust).toBe(OBS_SOURCES.buoy.trust)
  })

  it('does NOT call a lighthouse or a tide gauge a buoy', () => {
    // Trust 9 and elevM 0 would claim this instrument floats at sea level. It is
    // bolted to a pier at Friday Harbor.
    const o = parseNdbc(NDBC_LIVE, meta)
    const frd = o.find((x) => x.id === 'ndbc:FRDW1')!
    const sis = o.find((x) => x.id === 'ndbc:SISW1')!
    expect(frd.source).toBe('synop')
    expect(frd.surface).toBe('land')
    expect(frd.elevM).toBeNull()
    expect(sis.source).toBe('synop')
    expect(sis.trust).toBe(OBS_SOURCES.synop.trust)
    expect(sis.twsKn).toBeCloseTo(7.2 * 1.943844, 6)   // 14.0 kn at Smith Island
  })

  it('treats MM direction as unknown, and 0 kn as calm', () => {
    const frd = parseNdbc(NDBC_LIVE, meta).find((x) => x.id === 'ndbc:FRDW1')!
    expect(frd.twsKn).toBe(0)
    expect(frd.twdDeg).toBeNull()      // the row really does say MM
  })

  it('corrects nothing, because NDBC does not publish anemometer height', () => {
    // ~4 m on a discus buoy, 10-30 m on a lighthouse. Guessing is worse than
    // leaving it as measured — same contract as the Météo-France buoys.
    for (const o of parseNdbc(NDBC_LIVE, meta)) {
      expect(o.heightM).toBeNull()
      expect(obs10mKn(o)).toBeNull()
    }
  })

  it('still works with no station table at all', () => {
    const o = parseNdbc(NDBC_LIVE)
    expect(o.find((x) => x.id === 'ndbc:46088')!.source).toBe('buoy')    // id shape
    expect(o.find((x) => x.id === 'ndbc:SISW1')!.source).toBe('synop')
    expect(o.find((x) => x.id === 'ndbc:SISW1')!.name).toBe('SISW1')     // code, not name
  })

  it('survives junk', () => {
    expect(parseNdbc('')).toHaveLength(0)
    expect(parseNdbc(null as never)).toHaveLength(0)
    expect(parseNdbc('#only headers\n#second')).toHaveLength(0)
    expect(parseNdbc('SHORT 1 2 3')).toHaveLength(0)
  })
})

// ── history ─────────────────────────────────────────────────────────────────
// Captured from www.ndbc.noaa.gov/data/realtime2/46088.txt on 2026-10-22.
// Note the header: NO LAT/LON, so every column sits two places left of where it
// is in latest_obs.txt.
const NDBC_HISTORY = [
  '#YY  MM DD hh mm WDIR WSPD GST  WVHT   DPD   APD MWD   PRES  ATMP  WTMP  DEWP  VIS PTDY  TIDE',
  '#yr  mo dy hr mn degT m/s  m/s     m   sec   sec degT   hPa  degC  degC  degC  nmi  hPa    ft',
  '2026 10 22 08 50 260  6.0  8.0   0.6     4   3.2 242 1012.8  10.6    MM   9.7   MM   MM    MM',
  '2026 10 22 08 40 260  6.0  7.0    MM    MM    MM  MM 1012.7  10.6  10.9   9.7   MM   MM    MM',
  '2026 10 22 08 30 250  5.0   MM    MM    MM    MM  MM 1012.8  10.6  10.8   9.6   MM   MM    MM',
].join('\n')

describe('parseNdbcHistory', () => {
  it('reads the 10-minute trace, oldest first', () => {
    const p = parseNdbcHistory(NDBC_HISTORY)
    expect(p).toHaveLength(3)
    expect(p[0].t).toBe('2026-10-22T08:30:00.000Z')
    expect(p[2].t).toBe('2026-10-22T08:50:00.000Z')
    expect(p[2].twsKn).toBeCloseTo(6.0 * 1.943844, 6)
    expect(p[2].gustKn!).toBeCloseTo(8.0 * 1.943844, 6)
    expect(p[2].twdDeg).toBe(260)
  })

  it('leaves a missing gust null rather than zero', () => {
    expect(parseNdbcHistory(NDBC_HISTORY)[0].gustKn).toBeNull()
  })

  it('REFUSES a latest_obs row, which has two extra columns', () => {
    // Read with history indices, latest_obs puts the station id where the YEAR
    // goes. 46088 is not a year, and the guard is what stops a silent misread.
    const latestObsRow = '46088    48.332 -123.179 2026 10 22 08 50 260   6.0   8.0  0.6'
    expect(parseNdbcHistory(latestObsRow)).toHaveLength(0)
  })

  it('and parseNdbc REFUSES a history row, which is the same trap backwards', () => {
    // With latest_obs indices, a history row's MONTH becomes the latitude and
    // its DAY the longitude — a confident buoy at 10N 22E, in the Sahara.
    const historyRow = '2026 10 22 08 50 260  6.0  8.0   0.6     4   3.2 242 1012.8'
    expect(parseNdbc(historyRow)).toHaveLength(0)
  })
})

describe('withinHours', () => {
  const NOW = Date.parse('2026-10-22T09:00:00Z')
  const pts = parseNdbcHistory(NDBC_HISTORY)

  it('keeps what is inside the window', () => {
    expect(withinHours(pts, 6, NOW)).toHaveLength(3)
    expect(withinHours(pts, 0.4, NOW)).toHaveLength(2)   // 08:30 is 30 min back
  })

  it('drops a stamp from the FUTURE, which is a timezone, not a forecast', () => {
    const future = [{ t: '2026-10-22T11:00:00Z', twsKn: 10, gustKn: null, twdDeg: 90 }]
    expect(withinHours(future, 6, NOW)).toHaveLength(0)
  })

  it('survives an unparseable stamp', () => {
    expect(withinHours([{ t: 'nope', twsKn: 10, gustKn: null, twdDeg: 90 }], 6, NOW)).toHaveLength(0)
  })
})

describe('toObsPoints', () => {
  it('reduces a station\'s observations to a trace, oldest first', () => {
    const obs = parseMfMarine(parseMfCsv(MF_BUOY_CSV), 'buoy')
    const pts = toObsPoints(obs)
    expect(pts).toHaveLength(2)
    expect(pts[0].t).toBe('2026-10-21T02:00:00.000Z')
    expect(pts[1].t).toBe('2026-10-21T13:00:00.000Z')
    expect(Object.keys(pts[0]).sort()).toEqual(['gustKn', 't', 'twdDeg', 'twsKn'])
  })
})

// ── Pioupiou / Windbird ─────────────────────────────────────────────────────
// Captured from api.pioupiou.fr/v1/live-with-meta/all on 2026-10-22, verbatim.
const PIOU_LIVE = {
  doc: 'https://developers.pioupiou.fr/api/live/',
  license: 'https://developers.pioupiou.fr/data-licensing',
  data: [
    {
      id: 2217,
      meta: { name: 'ALRM 83', description: 'aéromodélisme Roquebrune', picture: null },
      location: { latitude: 43.474526, longitude: 6.615138, date: '2026-10-22T08:07:37.000Z', success: true, hdop: 1 },
      measurements: {
        date: '2026-10-22T15:25:56.000Z', pressure: null,
        wind_heading: 247.5, wind_speed_avg: 9.5, wind_speed_max: 20, wind_speed_min: 3.25,
      },
      status: { date: '2026-10-22T15:25:56.000Z', snr: -1, state: 'on' },
    },
  ],
}

describe('parsePioupiou', () => {
  it('reads the live station, km/h to knots', () => {
    const [o] = parsePioupiou(PIOU_LIVE)
    expect(o).toMatchObject({ id: 'piou:2217', source: 'beacon', name: 'ALRM 83', surface: 'land', twdDeg: 247.5 })
    expect(o.twsKn).toBeCloseTo(9.5 * 0.539957, 6)      // 5.1 kn
    expect(o.gustKn!).toBeCloseTo(20 * 0.539957, 6)     // 10.8 kn
    expect(o.t).toBe('2026-10-22T15:25:56.000Z')
    expect(o.trust).toBe(OBS_SOURCES.beacon.trust)
  })

  it('is a BEACON, not an official station and not a rooftop', () => {
    // Sited for a sport rather than for measurement, exactly like an FFVL
    // balise — so it shares that trust and that colour, and is visibly not one
    // of the airports or buoys.
    const [o] = parsePioupiou(PIOU_LIVE)
    expect(o.source).toBe('beacon')
    expect(OBS_SOURCES.beacon.trust).toBeLessThan(OBS_SOURCES.metar.trust)
    expect(OBS_SOURCES.beacon.trust).toBeGreaterThan(OBS_SOURCES.pws.trust)
    expect(o.heightM).toBeNull()      // mast height unpublished -> no correction
  })

  it('drops a station whose own GPS fix FAILED', () => {
    // A barb drawn at an unknown position is worse than no barb at all.
    const bad = { data: [{ ...PIOU_LIVE.data[0], location: { ...PIOU_LIVE.data[0].location, success: false } }] }
    expect(parsePioupiou(bad)).toHaveLength(0)
  })

  it('treats calm as calm, not as a westerly', () => {
    const calm = { data: [{ ...PIOU_LIVE.data[0], measurements: { ...PIOU_LIVE.data[0].measurements, wind_speed_avg: 0 } }] }
    const [o] = parsePioupiou(calm)
    expect(o.twsKn).toBe(0)
    expect(o.twdDeg).toBeNull()
  })

  it('survives junk and a station with no reading', () => {
    expect(parsePioupiou({ data: [] })).toHaveLength(0)
    expect(parsePioupiou(null)).toHaveLength(0)
    expect(parsePioupiou({ data: [null, 'x', 7] })).toHaveLength(0)
    const noWind = { data: [{ ...PIOU_LIVE.data[0], measurements: { date: '2026-10-22T15:25:56.000Z' } }] }
    expect(parsePioupiou(noWind)).toHaveLength(0)
  })
})
