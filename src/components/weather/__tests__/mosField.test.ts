import { describe, it, expect } from 'vitest'
import { applyMosToField, preferredFieldHeight } from '../windField'
import { applyMOS, specFor } from '../mos'
import { MODELS } from '../openMeteo'

const KN = 1.94384

// Build a one-frame field whose every cell carries the same wind, so we can read
// the correction straight off any cell. u/v are m/s, meteorological convention
// (direction the wind comes FROM).
function fieldAt(speedKn: number, dirFromDeg: number, label = 'Sat 14:00') {
  const ms = speedKn / KN
  const r = (dirFromDeg * Math.PI) / 180
  const u = -ms * Math.sin(r)
  const v = -ms * Math.cos(r)
  return {
    labels: [label],
    times: ['2026-09-01T14:00:00Z'],
    frames: [{ u: [u, u, u, u], v: [v, v, v, v] }],
    header: { nx: 2, ny: 2, lo1: 9.4, la1: 41.3, dx: 0.01, dy: 0.01 },
    maxSpeed: ms,
  }
}
const speedOf = (f: any, i = 0) => Math.hypot(f.frames[0].u[i], f.frames[0].v[i]) * KN
const dirOf = (f: any, i = 0) =>
  (((Math.atan2(-f.frames[0].u[i], -f.frames[0].v[i]) * 180) / Math.PI) % 360 + 360) % 360

describe('applyMosToField — the deck/map path uses the same correction as the tables', () => {
  const spec = specFor('porto_cervo')!
  // Both SSA-Race resolutions inherit the icon_eu correction (mosApprox).
  const iconRaceMosId = MODELS.ICONRACE_1KM.mosModel

  it('the SSA-Race models really do map to a fitted Porto Cervo correction', () => {
    expect(iconRaceMosId).toBe('icon_eu')
    expect(MODELS.ICONRACE.mosModel).toBe('icon_eu')
    expect(spec.models[iconRaceMosId].type).toBe('bias_scale')
  })

  it('corrects field speed to exactly what applyMOS gives the tables', () => {
    for (const raw of [8, 12, 16, 20, 25]) {
      const out = applyMosToField(fieldAt(raw, 200), spec, iconRaceMosId)
      const expected = applyMOS(spec, iconRaceMosId, raw, 200, 14)!.ws
      expect(speedOf(out)).toBeCloseTo(expected, 4)
      // and it is a real change, not a rounding artefact
      expect(Math.abs(speedOf(out) - raw)).toBeGreaterThan(2)
    }
  })

  it('leaves direction untouched — MOS corrects speed only', () => {
    for (const dir of [0, 90, 200, 355]) {
      const out = applyMosToField(fieldAt(15, dir), spec, iconRaceMosId)
      expect(dirOf(out)).toBeCloseTo(dir, 4)
    }
  })

  it('corrects every cell, not just the first', () => {
    const out = applyMosToField(fieldAt(16, 200), spec, iconRaceMosId)
    const s0 = speedOf(out, 0)
    for (let i = 1; i < 4; i++) expect(speedOf(out, i)).toBeCloseTo(s0, 6)
  })

  it('is a no-op at a venue with no MOS spec', () => {
    const f = fieldAt(16, 200)
    expect(applyMosToField(f, null as any, iconRaceMosId)).toBe(f)
  })

  it("is a no-op for a model fitted 'raw' at this venue", () => {
    // gfs_seamless is type 'raw' at Porto Cervo — the correction exists but is
    // deliberately identity, and must not shift the field.
    expect(spec.models.gfs_seamless.type).toBe('raw')
    const out = applyMosToField(fieldAt(16, 200), spec, 'gfs_seamless')
    expect(speedOf(out)).toBeCloseTo(16, 6)
  })

  it('is a no-op for a model with no entry at this venue', () => {
    const out = applyMosToField(fieldAt(16, 200), spec, 'no_such_model')
    expect(speedOf(out)).toBeCloseTo(16, 6)
  })

  it('applies the diurnal term by local hour where one is fitted (St Tropez AROME)', () => {
    const st = specFor('st_tropez')!
    const id = MODELS.AROME.mosModel
    expect(st.models[id].type).toBe('diurnal')
    const morning = applyMosToField(fieldAt(14, 200, 'Sat 08:00'), st, id)
    const afternoon = applyMosToField(fieldAt(14, 200, 'Sat 15:00'), st, id)
    // the whole point of a diurnal fit: the same raw speed corrects differently
    expect(speedOf(morning)).not.toBeCloseTo(speedOf(afternoon), 3)
    expect(speedOf(morning)).toBeCloseTo(applyMOS(st, id, 14, 200, 8)!.ws, 4)
    expect(speedOf(afternoon)).toBeCloseTo(applyMOS(st, id, 14, 200, 15)!.ws, 4)
  })

  it('recomputes maxSpeed so the field palette matches the corrected wind', () => {
    const out = applyMosToField(fieldAt(16, 200), spec, iconRaceMosId)
    expect(out.maxSpeed * KN).toBeCloseTo(speedOf(out), 4)
  })
})

describe('the map says which number it is showing', () => {
  const spec = specFor('porto_cervo')!
  const mosId = MODELS.ICONRACE?.mosModel || 'icon_eu'
  it('tags a corrected field so the readout can name the correction', () => {
    const out: any = applyMosToField(fieldAt(16, 200), spec, mosId)
    expect(out.mosApplied).toBe(true)
  })

  it('leaves an uncorrected field untagged — no spec, no claim', () => {
    const f: any = fieldAt(16, 200)
    expect(applyMosToField(f, null as any, mosId).mosApplied).toBeUndefined()
    expect(f.mosApplied).toBeUndefined()
  })
})

describe('preferredFieldHeight — what the map shows before you touch anything', () => {
  const base = { userPicked: false, canHeights: true, mosAvail: true, canMos: true, current: 'mast' as any }

  it('shows the CORRECTED mast wind where the venue has a MOS', () => {
    // The bug this fixes: the map defaulted to raw mast while the tables, the deck
    // and the windweight panel all showed the corrected number for the same hour.
    expect(preferredFieldHeight(base)).toBe('mastMOS')
  })

  it('never overrides a height the user chose', () => {
    expect(preferredFieldHeight({ ...base, userPicked: true, current: 'mast' })).toBe('mast')
    expect(preferredFieldHeight({ ...base, userPicked: true, current: 10 })).toBe(10)
    expect(preferredFieldHeight({ ...base, userPicked: true, current: 100 })).toBe(100)
  })

  it('leaves the height alone where there is no MOS for the venue', () => {
    expect(preferredFieldHeight({ ...base, mosAvail: false })).toBe('mast')
    expect(preferredFieldHeight({ ...base, canMos: false })).toBe('mast')
  })

  it('still forces 10 m for tiers that get no heights, chosen or not', () => {
    expect(preferredFieldHeight({ ...base, canHeights: false })).toBe(10)
    expect(preferredFieldHeight({ ...base, canHeights: false, userPicked: true, current: 'mast' })).toBe(10)
  })

  it('is idempotent — once on mastMOS it stays there, so the effect cannot loop', () => {
    expect(preferredFieldHeight({ ...base, current: 'mastMOS' })).toBe('mastMOS')
  })
})
