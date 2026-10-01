import { describe, it, expect } from 'vitest'
// @ts-expect-error — plain JS module, no types
import { modelCadence } from '../openMeteo'

const H = 3600
// The Admin table as photographed on 1 Oct at 05:23Z, with each model's real
// meta.json numbers. An ETA is a time in the FUTURE; every row below used to
// render one in the past.
const NOW = 5 * H + 23 * 60

describe('modelCadence', () => {
  it('never returns an ETA in the past (the reported bug)', () => {
    const rows = [
      { label: 'AROME', initSec: 0, availableSec: 2 * H + 49 * 60, intervalSec: 3 * H },
      { label: 'ICON', initSec: 0, availableSec: 3 * H + 43 * 60, intervalSec: 3 * H },
      { label: 'ECMWF', initSec: -6 * H, availableSec: 21 * 60, intervalSec: 6 * H },
      { label: 'DMI', initSec: 0, availableSec: 3 * H + 7 * 60, intervalSec: 3 * H },
      { label: 'METNO', initSec: 4 * H, availableSec: 4 * H + 42 * 60, intervalSec: H },
    ]
    for (const r of rows) {
      const c = modelCadence(r, NOW)
      // the old formula, for contrast: r.initSec + r.intervalSec
      expect(r.initSec + r.intervalSec).toBeLessThanOrEqual(NOW)   // was in the past
      expect(c.nextEtaSec).toBeGreaterThan(NOW)                    // now is not
    }
  })

  it('adds the publication lag, so 03z is not expected at 03:00Z', () => {
    // AROME's 00z landed at 02:49Z, so its 03z lands ~05:49Z, not 03:00Z.
    const c = modelCadence({ initSec: 0, availableSec: 2 * H + 49 * 60, intervalSec: 3 * H }, NOW)
    expect(c.lagSec).toBe(2 * H + 49 * 60)
    expect(c.nextSec).toBe(3 * H)                      // the cycle is still 03z
    expect(c.nextEtaSec).toBe(5 * H + 49 * 60)         // it arrives at 05:49Z
  })

  it('rolls forward when the lag exceeds the cadence (several cycles in flight)', () => {
    // ICON: 3h43m lag on a 3 h cadence, so init+interval is behind us even WITH
    // the lag added — the 03z was due at 06:43Z, which is still ahead at 05:23Z.
    const c = modelCadence({ initSec: 0, availableSec: 3 * H + 43 * 60, intervalSec: 3 * H }, NOW)
    expect(c.nextEtaSec).toBe(6 * H + 43 * 60)
    expect(c.nextEtaSec).toBeGreaterThan(NOW)
  })

  it('does not roll dueSec forward, or a late model could never go amber', () => {
    const meta = { initSec: 0, availableSec: 2 * H + 49 * 60, intervalSec: 3 * H }
    const early = modelCadence(meta, NOW)
    const muchLater = modelCadence(meta, NOW + 24 * H)
    expect(muchLater.dueSec).toBe(early.dueSec)             // the deadline is fixed
    expect(muchLater.nextEtaSec).toBeGreaterThan(early.nextEtaSec!)  // the ETA is not
  })

  it('flags a genuinely late run', () => {
    const meta = { initSec: 0, availableSec: 2 * H + 49 * 60, intervalSec: 3 * H }
    const due = modelCadence(meta, NOW).dueSec!
    expect(due).toBe(5 * H + 49 * 60)
    expect(NOW > due + 2700).toBe(false)                   // 05:23Z — not late
    expect(due + 3000 > due + 2700).toBe(true)             // past the grace — late
  })

  it('treats a missing availability time as no lag, and survives bad metadata', () => {
    expect(modelCadence({ initSec: 0, intervalSec: 3 * H }, NOW).lagSec).toBe(0)
    // availability before init is nonsense — do not produce a negative lag
    expect(modelCadence({ initSec: 100, availableSec: 50, intervalSec: 3 * H }, NOW).lagSec).toBe(0)
    for (const bad of [null, {}, { initSec: 0 }, { initSec: 0, intervalSec: 0 }, { intervalSec: H }]) {
      expect(modelCadence(bad as never, NOW).nextEtaSec).toBeNull()
    }
  })

  it('terminates on a stale meta rather than spinning', () => {
    // a year-old meta.json with a 1 h cadence: the loop is bounded, not infinite
    const c = modelCadence({ initSec: 0, availableSec: 600, intervalSec: H }, 365 * 24 * H)
    expect(Number.isFinite(c.nextEtaSec)).toBe(true)
  })
})
