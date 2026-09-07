import { describe, it, expect } from 'vitest'
import { detectLogFormat, parseLog } from '../logParse'
import { isFlatLocalLog, isFlatOleLog } from '../flatLogParse'

// Verbatim from the navigator's own layout (2026-09-07, Porto Cervo). Header
// trimmed to the columns the assertions use; the row values are unedited.
const HEAD = 'Datetime,Lat,Lon,TWD,TWS,TWA,AWS,AWA,HDG,COG,SOG,BSP,Heel,Trim,Leeway,PolBsp%,Targ_Twa,' +
  'TmStbd,TmPort,Forestay,UpDfclt%,LwDfclt%,Mainsheet,Cunningham,Vang,Shims,PortRudder,StbdRudder,' +
  'V1_P,V1_S,KeelAngle,TargHeel,JibIO%\n'
const ROW = (t: string, heel: string) =>
  `${t},41.1412552,9.5516942,84,6.2,35,8.8,22,50,62,2.95,2.8,${heel},0,-0.1,37.6,43,4.95,0,6.05,100.07,65.28,0.24,0.01,-0.21,-10,25.11,20.99,8.23,7.56,-0.04,11.08,13.2`
const FILE = HEAD + [ROW('2026-09-07 10:20:38', ''), ROW('2026-09-07 10:20:40', '-2.8')].join('\n') + '\n'

describe('detection', () => {
  it('recognises the navigator layout and does not confuse it with flat-OLE', () => {
    expect(isFlatLocalLog(FILE)).toBe(true)
    expect(isFlatOleLog(FILE)).toBe(false)   // no Utc column
    expect(detectLogFormat(FILE)).toBe('flat-local')
  })

  it('does not claim a Utc-column export — that one is already UTC', () => {
    const ole = 'Utc,Lat,Lon,BSP,TWS\n45900.5,41.1,9.5,7,12\n'
    expect(isFlatLocalLog(ole)).toBe(false)
    expect(detectLogFormat(ole)).toBe('flat-ole')
  })
})

describe('the clock', () => {
  it('treats Datetime as LOCAL and converts to true UTC', () => {
    // The first row reads 10:20:38 — one second after the 7 Sept event file's
    // DayStart at 10:20:37, which is venue-local. Reading it as UTC would put the
    // whole log two hours late and silently desync every video overlay against it.
    const p = parseLog(FILE, { tzOffsetMin: 120 })
    expect(new Date(p.rows[0].utc).toISOString()).toBe('2026-09-07T08:20:38.000Z')
  })

  it('follows the session offset rather than assuming one', () => {
    expect(new Date(parseLog(FILE, { tzOffsetMin: 0 }).rows[0].utc).toISOString()).toBe('2026-09-07T10:20:38.000Z')
    expect(new Date(parseLog(FILE, { tzOffsetMin: -300 }).rows[0].utc).toISOString()).toBe('2026-09-07T15:20:38.000Z')
  })

  it('does not let the VIEWER machine timezone leak into a bare stamp', () => {
    // Parsed field by field rather than through Date(), which would read an
    // unzoned string in whatever zone the laptop happens to be set to.
    const p = parseLog(FILE, { tzOffsetMin: 0 })
    expect(new Date(p.rows[1].utc).toISOString()).toBe('2026-09-07T10:20:40.000Z')
  })
})

describe('the navigator names his columns his own way', () => {
  const r: any = parseLog(FILE, { tzOffsetMin: 120 }).rows[1]

  it('maps his rudder, deflector, keel and jib columns', () => {
    expect(r.ruddP).toBe(25.11)        // PortRudder, not RUDD_P
    expect(r.ruddS).toBe(20.99)        // StbdRudder
    expect(r.upDflctPct).toBe(100.07)  // UpDfclt% — the alias list had this transposed
    expect(r.jibInOut).toBe(13.2)      // JibIO%
    expect(r.keelAng).toBe(-0.04)      // KeelAngle, not KeelAng
    expect(r.ttbPort).toBe(0)          // TmPort
    expect(r.ttbStbd).toBe(4.95)       // TmStbd
  })

  it('lands everything the sail-scan window and windweight read', () => {
    for (const f of ['tws','twa','aws','awa','bsp','heel','trim','forestay','leeway','keelAng',
      'shims','mainsheetLoad','cunninghamLoad','vang','ruddP','ruddS','v1p','v1s',
      'upDflctPct','lwDflctPct','jibInOut','targHeel','twaTarg','vsPerfPct','lat','lon'])
      expect(r[f], `${f} missing`).not.toBeNull()
  })

  it('leaves a blank cell null rather than guessing zero', () => {
    const first: any = parseLog(FILE, { tzOffsetMin: 120 }).rows[0]
    expect(first.heel).toBeNull()      // empty in that row
    expect(first.bsp).toBe(2.8)        // …but its neighbours still read
  })
})
