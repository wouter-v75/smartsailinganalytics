import { describe, it, expect } from 'vitest'
import { isFlatOleLog, parseFlatOleLog } from '../flatLogParse'

// The real 2026-07 Northstar 76 export header. `Utc` is a Windows FILETIME; the
// UtcDate / UtcTime columns beside it carry LOCAL (venue) wall-clock despite the name.
const HDR_2607 =
  'Boat,Utc,UtcDate,UtcTime,BSP,AWA,AWS,TWA,TWS,TWD,Course,Leeway,Set,Drift,HDG,Heel,Trim,' +
  'Forestay,VMG,ROT,Tm on S,Tm on P,Lat,Lon,COG,SOG,TargVmg,PolBsp,PolBsp%,KeelAng,StTmToP,' +
  'StTmToS,LnSqWind,MagVar,PredSet,PredDrift,TargAwa,Port lat,Port lon,Stbd lat,Stbd lon,' +
  'RUDDER,JibUpDnP,JibUpDnS,JibIO,UpDFLCT %,LwDFCLT %,Trav%,TOE IN,Futek,Fsty Pin,JibTk Pin,' +
  'E-Bar Port,E-Bar Stbd,Dx900 Lwy,Rudder 30s,TargHeel,TargFsty,TargBsty,TargKeel,TargToe,' +
  'TargTrim,Fsty+JibTk,MAINSHEET,RUDD_P,RUDD_S,TmToLn,BelowLn,Targ Twa,Targ Bsp,V1 P,V1 S,Cunningham'

const COLS = HDR_2607.split(',')
const at = (name: string) => COLS.indexOf(name)

// A row whose every cell equals its own column index — so an assertion of
// `row[field] === at('Header')` proves the field is reading the RIGHT column.
const indexRow = (utc: string) => {
  const c = COLS.map((_, i) => String(i))
  c[at('Utc')] = utc
  return c.join(',')
}

const ROW_A = indexRow('1.34282346237428E+17')
const ROW_B = indexRow('1.3428236277995E+17')

describe('flatLogParse — 2026-07 N76 export', () => {
  it('detects it as flat-ole', () => {
    expect(isFlatOleLog(`${HDR_2607}\n${ROW_A}`)).toBe(true)
  })

  it('reads a Windows FILETIME `Utc` as TRUE UTC (not the local UtcTime column)', () => {
    const { rows } = parseFlatOleLog(`${HDR_2607}\n${ROW_A}\n${ROW_B}`)
    expect(rows).toHaveLength(2)
    // 09:10:23.74Z — NOT the 11:10:23.74 that UtcDate/UtcTime advertise (CEST = UTC+2).
    // ±1 ms: the export truncates the FILETIME to 15 significant digits.
    expect(rows[0].utc).toBeCloseTo(Date.parse('2026-07-11T09:10:23.742Z'), -1)
    expect(rows[1].utc).toBeCloseTo(Date.parse('2026-07-11T09:37:57.995Z'), -1)
    // Row-to-row gap must survive to the centisecond.
    expect((rows[1].utc - rows[0].utc) / 1000).toBeCloseTo(1654.25, 1)
  })

  it('maps every rig-load / control / target column onto the right field', () => {
    const { rows } = parseFlatOleLog(`${HDR_2607}\n${ROW_A}`)
    const r = rows[0]
    // rig loads + control positions
    expect(r.fstyPin).toBe(at('Fsty Pin'))
    expect(r.fstyJibTk).toBe(at('Fsty+JibTk'))
    expect(r.mainsheetLoad).toBe(at('MAINSHEET'))
    expect(r.ruddP).toBe(at('RUDD_P'))
    expect(r.ruddS).toBe(at('RUDD_S'))
    expect(r.toeIn).toBe(at('TOE IN'))
    expect(r.futek).toBe(at('Futek'))
    expect(r.eBarPort).toBe(at('E-Bar Port'))
    expect(r.eBarStbd).toBe(at('E-Bar Stbd'))
    // targets
    expect(r.targToe).toBe(at('TargToe'))
    expect(r.targTrim).toBe(at('TargTrim'))
    expect(r.targVmg).toBe(at('TargVmg'))
    expect(r.targAwa).toBe(at('TargAwa'))
    // shortened headsail trim headers (were JibUpDnStbdPos / …PortPos / JibInOutPos)
    expect(r.jibUpDnPort).toBe(at('JibUpDnP'))
    expect(r.jibUpDnStbd).toBe(at('JibUpDnS'))
    expect(r.jibInOut).toBe(at('JibIO'))
    // the transposed-letter deflector header still resolves
    expect(r.upDflctPct).toBe(at('UpDFLCT %'))
    expect(r.lwDflctPct).toBe(at('LwDFCLT %'))
    // forestay LENGTH stays distinct from the forestay PIN LOAD
    expect(r.forestay).toBe(at('Forestay'))
    expect(r.forestay).not.toBe(r.fstyPin)
  })
})

describe('flatLogParse — older encodings still parse', () => {
  it('OLE/Excel date serial', () => {
    const { rows } = parseFlatOleLog(['Utc,Lat,Lon,BSP,TWS', '46214.3821,43.99,9.90,9.1,10.9'].join('\n'))
    // 46214 days after 1899-12-30 = 2026-07-11.
    expect(new Date(rows[0].utc).toISOString().slice(0, 10)).toBe('2026-07-11')
    expect(rows[0].bsp).toBe(9.1)
  })

  it('DD/MM/YYYY slash-date', () => {
    const { rows } = parseFlatOleLog(
      ['Utc,Lat,Lon,BSP,TWS', '11/07/2026 09:10:23,43.99,9.90,9.1,10.9'].join('\n')
    )
    expect(new Date(rows[0].utc).toISOString()).toBe('2026-07-11T09:10:23.000Z')
  })
})
