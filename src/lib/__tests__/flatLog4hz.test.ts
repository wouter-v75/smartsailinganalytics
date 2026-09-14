import { describe, it, expect } from 'vitest'
import { parseFlatOleLog, lidarKeyOf, isLidarKey } from '../flatLogParse'
import { detectLogFormat } from '../logParse'

// The 2026-09 Northstar 76 4 Hz Expedition export header, verbatim (12 Sep 2026). `Utc` is
// ISO 8601 with offset and 7-digit fractions; the lidar stripes sit near the end.
const HDR_4HZ =
  'Utc,Local Time,MagVar,BowLat,BowLon,Stbd lat,Stbd lon,Port lat,Port lon,TmToGun,StTmToGun,StTmToS,BurnToCb,TmToLine,Burn,StTmToP,BurnToPin,BelowLn,BspToCb,BspToPin,BspToLine,Mk ID,Mk Name,Mk ShortName,Route,Mk Count,Mk Lat,Mk Lon,TWD,TWS,TWA,GWD,GWS,GWA,MWS,MWA,AWS,AWA,HDG,COG,Course,SOG,BSP,Heel,Trim,Leeway,DX900 Lwy,Set,Drift,PolBsp,PolBsp%,Targ Bsp,Targ Twa,NavPolBsp,NavTargBsp,NavTargTwa,StartBsp,StartTargBsp,StartTargTwa,Mk Time Perf,Mk Time Nav,Note Time Perf,Note Time GPS,TmStbd,TmPort,DistStbd,DistPort,Depth,Lat,Lon,DstToMk,BrgToMk,VMC,VMG,magicTWD,OppTackCog,TargOppTackCog,OppTackTwd,TargetOppTackTwd,OppTackCourse,TargetOppTackCourse,xWind-90,xWind+90,TwaToMark,AWD,Shadow,PredSet,PredDrift,PredGwd,PredGws,GwsDelta,GwdDelta,DriftDelta,SetDelta,ManSet,ManDrift,InstSet,InstDrift,CalcSet,CalcDrift,Twd5m,Tws5m,Forestay,JibTack,Bobstay,UpDfclt%,LwDfclt%,Mainsheet,Cunningham,Vang,Shims,eBSP,PortRudder,StbdRudder,V1 P,V1 S,EBarPort,EBarStbd,BspCorr,TwaCorr,TwsCorr,ToeIn,KeelAngle,TargHeel,TargKeel,TargTrim,JibIO%,JIB_SHEET,JIB_LUFF%,JIB_LEECH%,JIB_SAGx,JIB_SAGy,JIB_SAGz,JIB_CA_25,JIB_TW_25,JIB_DR_25,JIB_%_25,JIB_ENT_25,JIB_EXT_25,JIB_FRT_25,JIB_BCK_25,JIB_LED_25,JIB_TAL_25,JIB_CA_50,JIB_TW_50,JIB_DR_50,JIB_%_50,JIB_ENT_50,JIB_EXT_50,JIB_FRT_50,JIB_BCK_50,JIB_LED_50,JIB_TAL_50,JIB_CA_75,JIB_TW_75,JIB_DR_75,JIB_%_75,JIB_ENT_75,JIB_EXT_75,JIB_FRT_75,JIB_BCK_75,JIB_LED_75,JIB_TAL_75,SPI_SHEET,SPI_LUFF%,SPI_LEECH%,SPI_SAGx,SPI_SAGy,SPI_SAGz,SPI_CA_25,SPI_TW_25,SPI_DR_25,SPI_%_25,SPI_ENT_25,SPI_EXT_25,SPI_FRT_25,SPI_BCK_25,SPI_LED_25,SPI_TAL_25,SPI_CA_50,SPI_TW_50,SPI_DR_50,SPI_%_50,SPI_ENT_50,SPI_EXT_50,SPI_FRT_50,SPI_BCK_50,SPI_LED_50,SPI_TAL_50,SPI_CA_75,SPI_TW_75,SPI_DR_75,SPI_%_75,SPI_ENT_75,SPI_EXT_75,SPI_FRT_75,SPI_BCK_75,SPI_LED_75,SPI_TAL_75,MN_SHEET,MN_LUFF%,MN_LEECH%,MN_SAGx,MN_SAGy,MN_SAGz,MN_CA_25,MN_TW_25,MN_DR_25,MN_%_25,MN_ENT_25,MN_EXT_25,MN_FRT_25,MN_BCK_25,MN_LED_25,MN_TAL_25,MN_CA_50,MN_TW_50,MN_DR_50,MN_%_50,MN_ENT_50,MN_EXT_50,MN_FRT_50,MN_BCK_50,MN_LED_50,MN_TAL_50,MN_CA_75,MN_TW_75,MN_DR_75,MN_%_75,MN_ENT_75,MN_EXT_75,MN_FRT_75,MN_BCK_75,MN_LED_75,MN_TAL_75,T_JIB_CA_25,T_JIB_TW_25,T_JIB_DR_25,T_JIB_CA_50,T_JIB_TW_50,T_JIB_DR_50,T_JIB_CA_75,T_JIB_TW_75,T_JIB_DR_75,T_SPI_CA_25,T_SPI_TW_25,T_SPI_DR_25,T_SPI_CA_50,T_SPI_TW_50,T_SPI_DR_50,T_SPI_CA_75,T_SPI_TW_75,T_SPI_DR_75,T_MN_CA_25,T_MN_TW_25,T_MN_DR_25,T_MN_TR_25,T_MN_CA_50,T_MN_TW_50,T_MN_DR_50,T_MN_TR_50,T_MN_CA_75,T_MN_TW_75,T_MN_DR_75,T_MN_TR_75,oRunnerP,iRunnerP,oRunnerS,iRunnerS,E-Bar_P Tn,E-Bar_S Tn'

const COLS = HDR_4HZ.split(',')
const at = (name: string) => COLS.indexOf(name)

// Every cell holds its own column index, so row[field] === at('Header') proves the mapping.
const indexRow = (utc: string, blank: string[] = []) => {
  const c = COLS.map((_, i) => String(i))
  c[at('Utc')] = utc
  for (const b of blank) c[at(b)] = ''
  return c.join(',')
}

describe('flatLogParse — 2026-09 N76 4 Hz export with lidar', () => {
  const text = `${HDR_4HZ}\n${indexRow('2026-09-12T10:10:00.8724427+00:00', ['SPI_CA_25', 'T_SPI_TW_50'])}\n${indexRow('2026-09-12T10:10:01.1220553+00:00')}`
  const rows = parseFlatOleLog(text).rows as any[]

  it('is detected as flat-OLE and keeps 4 Hz timestamps', () => {
    expect(detectLogFormat(text)).toBe('flat-ole')
    expect(new Date(rows[0].utc).toISOString()).toBe('2026-09-12T10:10:00.872Z')
    expect(Math.round(rows[1].utc - rows[0].utc)).toBe(250)
  })

  it('reads measured camber / twist / draft and the targets from their own columns', () => {
    expect(rows[0].mnCa25).toBe(at('MN_CA_25'))
    expect(rows[0].mnTw50).toBe(at('MN_TW_50'))
    expect(rows[0].jibDr75).toBe(at('JIB_DR_75'))
    expect(rows[0].tMnCa25).toBe(at('T_MN_CA_25'))
    expect(rows[0].tMnTr50).toBe(at('T_MN_TR_50'))
    expect(rows[0].tJibDr75).toBe(at('T_JIB_DR_75'))
    expect(rows[0].tSpiCa75).toBe(at('T_SPI_CA_75'))
  })

  it('leaves empty lidar cells out and ignores the stripe columns KND does not use', () => {
    expect('spiCa25' in rows[0]).toBe(false)
    expect('tSpiTw50' in rows[0]).toBe(false)
    expect(rows[1].spiCa25).toBe(at('SPI_CA_25'))
    expect(Object.keys(rows[0]).filter(isLidarKey)).toHaveLength(9 * 3 + 9 * 3 + 3 - 2)
  })

  it('maps the rig columns of this export', () => {
    expect(rows[0].bobstay).toBe(at('Bobstay'))
    expect(rows[0].ruddP).toBe(at('PortRudder'))
    expect(rows[0].ruddS).toBe(at('StbdRudder'))
    expect(rows[0].jibTackLoad).toBe(at('JibTack'))
    expect(rows[0].upDflctPct).toBe(at('UpDfclt%'))
    expect(rows[0].keelAng).toBe(at('KeelAngle'))
  })
})

describe('lidar keys', () => {
  it('names measured and target stripes, and only those', () => {
    expect(lidarKeyOf('MN_CA_25')).toBe('mnCa25')
    expect(lidarKeyOf('JIB_TW_75')).toBe('jibTw75')
    expect(lidarKeyOf('T_SPI_DR_50')).toBe('tSpiDr50')
    expect(lidarKeyOf('T_MN_TR_25')).toBe('tMnTr25')
    expect(lidarKeyOf('MN_TR_25')).toBeNull()        // trim is a target-only channel
    expect(lidarKeyOf('JIB_ENT_25')).toBeNull()
    expect(lidarKeyOf('Forestay')).toBeNull()
    expect(isLidarKey('tJibCa50')).toBe(true)
    expect(isLidarKey('mainsheet')).toBe(false)
  })
})
