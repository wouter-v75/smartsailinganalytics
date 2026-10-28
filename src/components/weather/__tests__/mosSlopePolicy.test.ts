import { describe, it, expect } from 'vitest'
// @ts-expect-error — plain JS module, no types
import { specFor, applyMOS, calibratedVenues } from '../mos'
// @ts-expect-error — plain JS module, no types
import { MODELS } from '../openMeteo'

// A CORRECTION THAT CANNOT FORECAST A STRONG WIND IS WORSE THAN NO CORRECTION.
//
// An rmse-optimal linear correction is a shrinkage: OLS sets a = cov(x,y)/var(x),
// so the weaker a model's correlation with the truth station, the harder it
// pulls the forecast toward the mean — and rmse is minimised by exactly that.
// At Long Beach the standard ladder fitted slopes of 0.40 to 0.77, which turn a
// raw 30 kn forecast into 18-27 kn, and dropped the share of observed >= 18 kn
// hours the forecast warned about from 50-75 % to 0-29 %. ecmwf_ifs025 warned
// on ZERO of 130.
//
// So the Long Beach spec pins a = 1 and fits only the bias, the sector offsets
// and the diurnal harmonic. These tests are what stops that being undone by a
// refit that optimises rmse and reports a bigger number.

const LB = 'long-beach'

describe('the Long Beach spec preserves the forecast range', () => {
  it('is registered and declares its slope policy', () => {
    expect(calibratedVenues()).toContain(LB)
    const spec = specFor(LB)
    expect(spec.slope_policy?.constrained).toBe(true)
    expect(spec.slope_policy?.why).toMatch(/strong wind|shrink/i)
  })

  it('pins a = 1 on every shipped model', () => {
    const spec = specFor(LB)
    for (const [id, m] of Object.entries(spec.models) as Array<[string, Record<string, unknown>]>) {
      if (m.type === 'raw') continue
      expect(m.a, `${id}: slope must be pinned at 1, not fitted`).toBe(1)
      expect(m.slope_constrained, `${id}`).toBe(true)
    }
  })

  it('pins a = 1 on every seasonal model too', () => {
    // The season window is the one that matters operationally, so it is also
    // the one where a quietly-refitted slope would do the most damage.
    const spec = specFor(LB)
    for (const [id, m] of Object.entries(spec.seasonal?.models ?? {}) as Array<[string, Record<string, unknown>]>) {
      if (m.type === 'raw') continue
      expect(m.a, `seasonal ${id}`).toBe(1)
    }
  })

  it('still returns a strong wind for a strong input', () => {
    // The behavioural statement, not the coefficient one: whatever the form,
    // 30 kn in must not come out as a moderate breeze. The shrunk fits this
    // replaced returned 18-27 kn here.
    const spec = specFor(LB)
    for (const id of Object.keys(spec.models)) {
      if (spec.models[id].type === 'raw') continue
      for (const month of [1, 7]) {
        for (const hour of [8, 14, 20]) {
          const out = applyMOS(spec, id, 30, 270, hour, month)
          const v = typeof out === 'number' ? out : out.ws
          expect(v, `${id} month ${month} hour ${hour}: 30 kn shrank to ${v}`).toBeGreaterThan(26)
          expect(v).toBeLessThan(36)
        }
      }
    }
  })
})

describe('the June-September racing window', () => {
  it('covers the Olympic and Transpac season and nothing else', () => {
    expect(specFor(LB).seasonal?.months).toEqual([6, 7, 8, 9])
  })

  it('uses the seasonal coefficients inside the window and the year-round set outside', () => {
    const spec = specFor(LB)
    const id = 'gfs_hrrr'
    expect(Object.keys(spec.seasonal.models)).toContain(id)
    const inside = applyMOS(spec, id, 12, 270, 14, 7)
    const outside = applyMOS(spec, id, 12, 270, 14, 1)
    const val = (o: unknown) => (typeof o === 'number' ? o : (o as { ws: number }).ws)
    expect(val(inside)).not.toBe(val(outside))
  })

  it('keeps the year-round set INSIDE the window for a model the window omits', () => {
    // The direction that is easy to get backwards, and CLAUDE.md records the
    // cost of doing so at St Tropez. ncep_nam_conus has only one season block,
    // so its season-only arm was never stored; it must therefore keep its
    // year-round coefficients in July rather than falling back to raw.
    const spec = specFor(LB)
    expect(Object.keys(spec.seasonal.models)).not.toContain('ncep_nam_conus')
    const val = (o: unknown) => (typeof o === 'number' ? o : (o as { ws: number }).ws)
    const july = val(applyMOS(spec, 'ncep_nam_conus', 12, 270, 14, 7))
    const jan = val(applyMOS(spec, 'ncep_nam_conus', 12, 270, 14, 1))
    expect(july).toBe(jan)
    expect(july).not.toBe(12)        // and it is still CORRECTED, not raw
  })
})

describe('NAM is wired, which is what makes its coefficients do anything', () => {
  it('claims ncep_nam_conus as its mosModel', () => {
    // It carried no mosModel at all until the Long Beach fit. NAM has the
    // largest gain of any model at this venue (23.2 %), and without this line
    // every knot of it is inert.
    expect(MODELS.NAM.mosModel).toBe('ncep_nam_conus')
    expect(Object.keys(specFor(LB).models)).toContain('ncep_nam_conus')
  })

  it('actually moves the number through the app path', () => {
    const out = applyMOS(specFor(LB), MODELS.NAM.mosModel, 12, 270, 14, 7)
    const v = typeof out === 'number' ? out : out.ws
    expect(Number.isFinite(v)).toBe(true)
    expect(v).not.toBe(12)
  })
})
