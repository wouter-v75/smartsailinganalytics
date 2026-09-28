import { describe, it, expect, vi } from 'vitest'

// The deck pulls in pptxgenjs/plotly at module load; neither is needed here.
vi.mock('pptxgenjs', () => ({ default: class {} }))

// @ts-expect-error — plain JSX module, no types
import { hpblSeriesAt } from '../ForecastDeck'

const series = (vals: Array<number | null>) => ({ hourly: { time: [], boundary_layer_height: vals } })

describe('hpblSeriesAt', () => {
  it('takes the 1 km over the 2 km when both carry hpbl', () => {
    const p1 = {
      surfaceByModel: {
        ICONRACE: series([100, 581, 300]),
        ICONRACE_1KM: series([120, 821, 400]),
      },
    }
    const r = hpblSeriesAt(p1)
    // St Tropez 28 Sept: the 1 km resolves 821 m where the 2 km smooths to 581.
    expect(r.key).toBe('ICONRACE_1KM')
    expect(Math.max(...r.hourly.boundary_layer_height)).toBe(821)
  })

  it('falls back to the 2 km when the 1 km has no hpbl column', () => {
    const p1 = {
      surfaceByModel: {
        ICONRACE: series([100, 581]),
        ICONRACE_1KM: { hourly: { time: [] } },      // nest outside its box / older cycle
      },
    }
    expect(hpblSeriesAt(p1).key).toBe('ICONRACE')
  })

  it('treats an all-null hpbl column as absent', () => {
    const p1 = {
      surfaceByModel: {
        ICONRACE: series([100, 581]),
        ICONRACE_1KM: series([null, null]),
      },
    }
    expect(hpblSeriesAt(p1).key).toBe('ICONRACE')
  })

  it('falls back to GFS when no SSA-Race domain has it, and to null with nothing', () => {
    expect(hpblSeriesAt({ surfaceByModel: {}, gfs: series([90, 700]) }).key).toBe('GFS')
    expect(hpblSeriesAt({ surfaceByModel: {} })).toBeNull()
    expect(hpblSeriesAt(null)).toBeNull()
  })
})
