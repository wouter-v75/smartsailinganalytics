import { describe, it, expect } from 'vitest'
import { pickDefaultActiveModel } from '../openMeteo'

// A point shaped like fetchAllForPoint's output: only the models named have data.
const hourly = { time: ['2026-09-13T12:00'], wind_speed_10m: [18] }
const point = (...keys: string[]) => ({ surfaceByModel: Object.fromEntries(keys.map((k) => [k, { hourly }])) })

describe('pickDefaultActiveModel', () => {
  it('picks HRRR (3 km, local) over ECMWF (9 km) at a North-American venue', () => {
    expect(pickDefaultActiveModel([point('ECMWF', 'ICON', 'HRRR', 'NAM')])).toBe('HRRR')
  })
  it('still puts the SSA-Race models first where they exist', () => {
    expect(pickDefaultActiveModel([point('AROME', 'ICONRACE', 'ICONRACE_1KM', 'ECMWF')])).toBe('ICONRACE_1KM')
  })
  it('keeps AROME first in France and MET Norway first in the Nordics', () => {
    expect(pickDefaultActiveModel([point('AROME', 'ECMWF')])).toBe('AROME')
    expect(pickDefaultActiveModel([point('METNO', 'ECMWF', 'DMI')])).toBe('METNO')
  })
  it('falls back to the globals where no local model has data', () => {
    expect(pickDefaultActiveModel([point('ECMWF', 'ICON')])).toBe('ECMWF')
  })
})
