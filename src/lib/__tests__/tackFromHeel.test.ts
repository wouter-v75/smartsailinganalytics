// src/lib/__tests__/tackFromHeel.test.ts
// ─────────────────────────────────────────────────────────────────────────────
// Heel as a second opinion on the tack.
//
// The tack comes from the sign of ONE TWA sample, and the tack sets
// `leewardSign`, so a wrong tack FLIPS every millimetre on the frame. A sample
// taken seconds after a tack names the tack the boat has just left.
//
// Baraka, 11 Oct 2026, 08:26:25: labelled port on a −8.6° heel while every
// genuine port frame that morning read +11.8°. Its boom came out at +499 mm
// where all nine other frames were negative. The damage, in order:
//
//   · the port spread went from 184 mm to 1172 mm;
//   · the port and starboard means looked 139 mm apart on a real asymmetry
//     instead of noise — which is what a whole session spent chasing;
//   · and because the triangulation drops the MINORITY tack, the 08:26 set was
//     cut from four frames spanning 8.7° to three spanning 4.2°, tripling the
//     depth leverage from 6.6x to 14x.
//
// One mislabelled frame, three separate consequences, none of which announced
// itself. Heel would have caught it on sight.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest'
import { tackFromHeel, tackDisagreesWithHeel, runChecks, type Calibration } from '../sailTrim'

describe('tackFromHeel', () => {
  it('reads positive heel as PORT tack, the way Baraka’s frames do', () => {
    // Upwind a boat heels away from the wind: port tack puts the starboard side
    // down, which is positive here.
    expect(tackFromHeel(11.8)).toBe('port')
    expect(tackFromHeel(-10.3)).toBe('stbd')
  })

  it('has NO OPINION near upright rather than guessing from noise', () => {
    expect(tackFromHeel(1.2)).toBeNull()
    expect(tackFromHeel(-2.9)).toBeNull()
    expect(tackFromHeel(0)).toBeNull()
    expect(tackFromHeel(null)).toBeNull()
  })

  it('takes its threshold from the caller', () => {
    expect(tackFromHeel(2.5, 2)).toBe('port')
    expect(tackFromHeel(2.5, 5)).toBeNull()
  })
})

describe('tackDisagreesWithHeel', () => {
  it('catches the 08:26:25 frame', () => {
    expect(tackDisagreesWithHeel('port', -8.6)).toBe(true)
  })

  it('passes the genuine frames of both tacks', () => {
    expect(tackDisagreesWithHeel('port', 11.8)).toBe(false)
    expect(tackDisagreesWithHeel('stbd', -10.3)).toBe(false)
    expect(tackDisagreesWithHeel('stbd', -13.8)).toBe(false)
  })

  it('never claims a disagreement it cannot support', () => {
    // Too upright to arbitrate, no heel at all, or no tack to check.
    expect(tackDisagreesWithHeel('port', 1.0)).toBe(false)
    expect(tackDisagreesWithHeel('port', null)).toBe(false)
    expect(tackDisagreesWithHeel(null, -10)).toBe(false)
  })
})

describe('runChecks surfaces it', () => {
  const cal = (heelDeg: number): Calibration => ({
    axis: { low: { x: 0, y: 900 }, high: { x: 0, y: 100 }, up: { x: 0, y: -1 } },
    heelDeg,
    horizon: null,
    psi: { deg: 0.2, sigmaDeg: 0.1, measured: true },
    mmPerPxAtMast: 6.2,
  } as unknown as Calibration)

  it('fails the check, and says the millimetres are flipped', () => {
    const c = runChecks(cal(-8.6), 'port').find((x) => x.key === 'tack-heel')!
    expect(c.ok).toBe(false)
    expect(c.detail).toMatch(/FLIPS/)
    expect(c.detail).toMatch(/says stbd/)
  })

  it('passes when they agree, and says heel corroborated it', () => {
    const c = runChecks(cal(11.8), 'port').find((x) => x.key === 'tack-heel')!
    expect(c.ok).toBe(true)
    expect(c.detail).toMatch(/agrees/)
  })

  it('passes, but admits it cannot tell, when the boat is upright', () => {
    const c = runChecks(cal(0.5), 'port').find((x) => x.key === 'tack-heel')!
    expect(c.ok).toBe(true)
    expect(c.detail).toMatch(/too upright/)
  })

  it('is absent when no tack is known, rather than a check that cannot fail', () => {
    expect(runChecks(cal(11.8)).find((x) => x.key === 'tack-heel')).toBeUndefined()
  })
})
