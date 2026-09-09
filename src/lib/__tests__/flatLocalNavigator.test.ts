import { describe, it, expect } from 'vitest'
import { detectLogFormat, parseLog } from '../logParse'

// The navigator's own Expedition layout, exactly as exported on 8 Sept 2026 at
// Porto Cervo. Kept verbatim because the bugs this file guards against were all
// about which COLUMN a field reads — a paraphrased header proves nothing.
const HDR =
  'Datetime,Lat,Lon,Stbdlat,Stbdlon,Portlat,Portlon,TimeToGun,StTmToGun,StTmToS,BurnToCb,' +
  'TimeToLine,Burn,StTmToP,BurnToPin,BelowLine,BspToCb,BspToPin,BspToLine,Mk_ID,Mk_Name,' +
  'Mk_ShortName,Route,Mk_Count,Mk_Lat,Mk_Lon,TWD,TWS,TWA,GWD,GWS,GWA,MWS,MWA,AWS,AWA,' +
  'Heading,COG,Course,SOG,BoatSpeed,Heel,Trim,Leeway,DX900_Lwy,Set,Drift,PolarBoatSpeed,' +
  'BoatSpeedPercOfPolar,TargetBoatSpeed,TargetTWA,StartBsp,StartTargBsp,StartTargTwa,' +
  'TmStbd,TmPort,DistStbd,DistPort,VMC,VMG,CurrentDirection,CurrentSpeed,Forestay,JibTack,' +
  'Bobstay,UpDfclt%,LwDfclt%,Mainsheet,Cunningham,Vang,Shims,eBSP,PortRudder,StbdRudder,' +
  'V1_P,V1_S,EBarPort,EBarStbd,BspCorr,TwaCorr,TwsCorr,ToeIn,KeelAngle,TargetHeel,' +
  'TargetKeel,TargetTrim,JibIO%,V1_Lwd,Rudder_Lwd'

const COLS = HDR.split(',')
const at = (name: string) => COLS.indexOf(name)

// Every cell equals its own column index, so `field === at('Header')` proves the
// field is reading the right column and not a neighbour.
const indexRow = (stamp: string) => {
  const c = COLS.map((_, i) => String(i))
  c[0] = stamp
  return c.join(',')
}
const text = [HDR, indexRow('2026-09-08 11:25:36')].join('\n')

describe("the navigator's layout (flat-local)", () => {
  it('is detected as flat-local, not flat-ole', () => {
    expect(detectLogFormat(text)).toBe('flat-local')
  })

  it('reads Datetime as the LOCAL clock and shifts it to true UTC', () => {
    // 11:25:36 at a +02:00 venue is 09:25:36Z. Getting this wrong put every clip
    // two hours from its data.
    const { rows } = parseLog(text, { tzOffsetMin: 120 })
    expect(new Date(rows[0].utc).toISOString()).toBe('2026-09-08T09:25:36.000Z')
  })

  it('does NOT invent a start burn out of the last two columns', () => {
    // This layout ends with V1_Lwd,Rudder_Lwd and has no P burn / S burn at all.
    // The old positional rule served that trailing rudder angle as sBurn.
    const { rows } = parseLog(text, { tzOffsetMin: 120 })
    const r = rows[0] as unknown as Record<string, number | null>
    expect(r.pBurn).toBeNull()
    expect(r.sBurn).toBeNull()
  })

  it('still reads a named P burn / S burn wherever they sit in the header', () => {
    const h = 'Datetime,Lat,Lon,BSP,TWS,P burn,S burn,Trim'
    const { rows } = parseLog([h, '2026-09-08 11:25:36,41.1,9.5,7,12,-4,9,3'].join('\n'), { tzOffsetMin: 120 })
    const r = rows[0] as unknown as Record<string, number | null>
    expect(r.pBurn).toBe(-4)
    expect(r.sBurn).toBe(9)
  })

  it('maps the channels this layout spells out in full words', () => {
    const { rows } = parseLog(text, { tzOffsetMin: 120 })
    const r = rows[0] as unknown as Record<string, number | null>
    // each of these was silently null before
    expect(r.hdg).toBe(at('Heading'))
    expect(r.vsPerf).toBe(at('PolarBoatSpeed'))
    expect(r.vsPerfPct).toBe(at('BoatSpeedPercOfPolar'))
    expect(r.vsTarget).toBe(at('TargetBoatSpeed'))
    expect(r.targKeel).toBe(at('TargetKeel'))
  })

  it('reads the rig and foil channels off the right columns', () => {
    const { rows } = parseLog(text, { tzOffsetMin: 120 })
    const r = rows[0] as unknown as Record<string, number | null>
    expect(r.bsp).toBe(at('BoatSpeed'))
    expect(r.keelAng).toBe(at('KeelAngle'))
    expect(r.jibInOut).toBe(at('JibIO%'))
    expect(r.upDflctPct).toBe(at('UpDfclt%'))
    expect(r.lwDflctPct).toBe(at('LwDfclt%'))
    expect(r.ruddP).toBe(at('PortRudder'))
    expect(r.ruddS).toBe(at('StbdRudder'))
    expect(r.eBarPort).toBe(at('EBarPort'))
    expect(r.eBarStbd).toBe(at('EBarStbd'))
    expect(r.v1p).toBe(at('V1_P'))
    expect(r.v1s).toBe(at('V1_S'))
    expect(r.forestay).toBe(at('Forestay'))
    expect(r.mainsheetLoad).toBe(at('Mainsheet'))
    expect(r.targHeel).toBe(at('TargetHeel'))
  })
})

describe('start burns come from the BURN columns, not the time-to-end ones', () => {
  // At 5 min before the gun on 8 Sept the log carried, on the same row:
  //   Burn=122  BurnToPin=115  BurnToCb=73   <- excess time (a burn)
  //   TmPort=79.74  TmStbd=15.46             <- TIME to reach that end
  // Those are different quantities. TmPort/TmStbd were briefly aliased into the
  // burn fields, which put a time-to-end under a "time to burn" label.
  it('derives Tgt % from BoatSpeed and TargetBoatSpeed', () => {
    // This layout has no "% of target" column — it carries the two speeds and
    // BoatSpeedPercOfPolar, which is percent of POLAR, a different quantity. So
    // the gauge read '--'. With the index row, BoatSpeed and TargetBoatSpeed are
    // their own column indices, so the ratio is exact.
    const { rows } = parseLog(text, { tzOffsetMin: 120 })
    const r = rows[0] as unknown as Record<string, number | null>
    const expected = Math.round((at('BoatSpeed') / at('TargetBoatSpeed')) * 1000) / 10
    expect(r.vsTargPct).toBe(expected)
  })

  it('does not divide by a zero target — pre-start rows carry one', () => {
    const h = 'Datetime,Lat,Lon,BSP,TWS,TargetBoatSpeed'
    const { rows } = parseLog([h, '2026-09-08 11:25:36,41.1,9.5,7,12,0'].join('\n'), { tzOffsetMin: 120 })
    expect((rows[0] as unknown as Record<string, number | null>).vsTargPct).toBeNull()
  })

  it('reads BelowLine as the distance to the line', () => {
    // The alias list had only Expedition's 'BelowLn'. The navigator writes
    // 'BelowLine', so dstLine stayed null and the start panel's Line gauge
    // showed '--' on every clip.
    const { rows } = parseLog(text, { tzOffsetMin: 120 })
    expect((rows[0] as unknown as Record<string, number | null>).dstLine).toBe(at('BelowLine'))
  })

  it('maps BurnToPin/BurnToCb onto the burn fields', () => {
    const { rows } = parseLog(text, { tzOffsetMin: 120 })
    const r = rows[0] as unknown as Record<string, number | null>
    expect(r.ttbPin).toBe(at('BurnToPin'))
    expect(r.ttbCB).toBe(at('BurnToCb'))
    expect(r.tmLine).toBe(at('Burn'))
  })

  it('does NOT let TmPort/TmStbd reach a burn field', () => {
    const { rows } = parseLog(text, { tzOffsetMin: 120 })
    const r = rows[0] as unknown as Record<string, number | null>
    for (const f of ['ttbPin', 'ttbCB', 'ttbPort', 'ttbStbd', 'tmLine']) {
      expect(r[f]).not.toBe(at('TmPort'))
      expect(r[f]).not.toBe(at('TmStbd'))
    }
  })
})
