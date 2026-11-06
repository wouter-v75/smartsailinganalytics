// Temperature and rain set a FLOOR under the crew-kit tier.
//
// Reported off the 6 Nov San Juan deck: 4-10 kn and 10-12 °C with rain likely
// came out as "Light · Shorts · Technical tee", photographs and all, because
// the tier keyed on wind alone and temperature only appended a caption. Wind
// chill is a correction to how cold you feel; the air temperature is what you
// sit in for five hours.

import { describe, expect, it } from 'vitest'
// @ts-expect-error — plain JSX module, no types
import { tempFloorTier, skyFloorTier } from '../ForecastDeck'

describe('tempFloorTier — what the air alone justifies', () => {
  it('imposes nothing once it is genuinely warm', () => {
    expect(tempFloorTier(18)).toBe(null)
    expect(tempFloorTier(27)).toBe(null)
  })

  it('asks for a gilet in the teens', () => {
    expect(tempFloorTier(17.9)).toBe('medium')
    expect(tempFloorTier(14)).toBe('medium')
  })

  it('asks for trousers and a spray top below 14 — the San Juan case', () => {
    expect(tempFloorTier(13.9)).toBe('fresh')
    expect(tempFloorTier(12)).toBe('fresh')   // the deck that prompted this
    expect(tempFloorTier(9)).toBe('fresh')
  })

  it('asks for full kit below 9', () => {
    expect(tempFloorTier(8.9)).toBe('heavy')
    expect(tempFloorTier(2)).toBe('heavy')
  })

  it('imposes nothing when the temperature is unknown', () => {
    // Absent must mean "no opinion", never "cold" — a missing fetch would
    // otherwise dress the crew for a gale on a Mediterranean afternoon.
    expect(tempFloorTier(null)).toBe(null)
    expect(tempFloorTier(undefined)).toBe(null)
    expect(tempFloorTier(Number.NaN)).toBe(null)
  })
})

describe('skyFloorTier — rain needs a spray top in any breeze', () => {
  it('floors rain at fresh and showers at medium', () => {
    expect(skyFloorTier('rain')).toBe('fresh')
    expect(skyFloorTier('showers')).toBe('medium')
  })

  it('imposes nothing for dry sky, however grey', () => {
    for (const s of ['overcast', 'cloud', 'sunny', null, undefined]) {
      expect(skyFloorTier(s)).toBe(null)
    }
  })
})

describe('the floors compose the way the complaint requires', () => {
  // apparelKit itself needs the module's KIT_TIERS; the composition rule is
  // "take the warmest of wind / temperature / sky", so assert it on the ranks.
  const RANK = ['beach', 'light', 'medium', 'fresh', 'heavy']
  const resolve = (windKey: string, tMaxC: number | null, sky: string | null) => {
    let k = windKey
    for (const f of [tempFloorTier(tMaxC), skyFloorTier(sky)]) {
      if (f && RANK.indexOf(f) > RANK.indexOf(k)) k = f
    }
    return k
  }

  it('turns the reported 6 kn / 12 °C / rain day into Fresh, not Light', () => {
    expect(resolve('light', 12, 'rain')).toBe('fresh')
  })

  it('leaves a hot still day on Beach', () => {
    expect(resolve('beach', 29, 'sunny')).toBe('beach')
  })

  it('never DOWNGRADES a windy day because it happens to be warm', () => {
    expect(resolve('heavy', 26, 'sunny')).toBe('heavy')
    expect(resolve('fresh', 22, null)).toBe('fresh')
  })

  it('a cold windy day stays heavy rather than being floored down to fresh', () => {
    expect(resolve('heavy', 11, 'rain')).toBe('heavy')
  })
})
