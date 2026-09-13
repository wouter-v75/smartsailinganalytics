import { describe, it, expect } from 'vitest'
import { parseOmJson } from '../windField'

describe('parseOmJson', () => {
  it('parses ordinary Open-Meteo JSON untouched', () => {
    expect(parseOmJson('{"latitude":41.49,"hourly":{"time":["2026-09-13T12:00"]}}')).toEqual({
      latitude: 41.49, hourly: { time: ['2026-09-13T12:00'] },
    })
  })

  it("survives the out-of-domain reply that threw \"Unexpected token 'a'\"", () => {
    // Verbatim shape of Open-Meteo's answer outside a regional model's domain.
    const j = parseOmJson('{"latitude":nan,"longitude":nan,"generationtime_ms":0.0038,"utc_offset_seconds":0,"timezone":"GMT"}')
    expect(j.latitude).toBeNull()
    expect(j.longitude).toBeNull()
    expect(j.timezone).toBe('GMT')
  })

  it('keeps the in-domain cells of a grid that straddles an edge', () => {
    const j = parseOmJson('[{"latitude":59.1,"hourly":{"time":["t"]}},{"latitude":nan,"longitude":nan}]')
    expect(j[0].hourly.time).toEqual(['t'])
    expect(j[1].latitude).toBeNull()
  })

  it('does not touch the word "nan" inside a string', () => {
    expect(parseOmJson('{"name":"nan"}').name).toBe('nan')
  })

  it('still rejects something that is not JSON at all', () => {
    expect(() => parseOmJson('<html>502</html>')).toThrow()
  })
})
