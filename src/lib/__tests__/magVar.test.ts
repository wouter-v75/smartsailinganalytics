import { describe, it, expect } from 'vitest'
import { fallbackMagVar, MAGVAR_VENUES } from '../magVar'

describe('fallbackMagVar', () => {
  it('finds Porto Cervo from a position on the race area', () => {
    // a real drone fix from 8 Sept, out on the course
    const v = fallbackMagVar(41.182442, 9.552726)
    expect(v?.name).toBe('Porto Cervo')
    expect(v?.varDeg).toBe(3.5)
  })

  it('returns null far away rather than the nearest guess', () => {
    expect(fallbackMagVar(50.76, -1.30)).toBeNull()   // the Solent
    expect(fallbackMagVar(43.17, 5.61)).toBeNull()    // La Ciotat
  })

  it('returns null for a missing or nonsense position', () => {
    expect(fallbackMagVar(undefined, undefined)).toBeNull()
    expect(fallbackMagVar(NaN, 9.5)).toBeNull()
    expect(fallbackMagVar('41.1' as unknown, 9.5)).toBeNull()
  })

  it('every entry records where its number came from', () => {
    // a value with no provenance is indistinguishable from a guess
    for (const v of MAGVAR_VENUES) expect(v.source).toBeTruthy()
  })
})
