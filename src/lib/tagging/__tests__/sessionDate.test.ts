import { describe, it, expect } from 'vitest'
import { sessionDateFor } from '../sessionDate'

const at = (iso: string) => Date.parse(iso)

describe('sessionDateFor', () => {
  it('keeps the day the crew are tagging', () => {
    expect(sessionDateFor(at('2026-09-28T12:22:42Z'), '2026-09-28'))
      .toEqual({ date: '2026-09-28', corrected: false })
  })

  it('keeps a venue whose local day runs ahead of UTC', () => {
    // 01:30 local in Auckland (+13) is still the previous UTC day.
    expect(sessionDateFor(at('2026-09-27T12:30:00Z'), '2026-09-28').date).toBe('2026-09-28')
  })

  it('keeps a session that ran through local midnight', () => {
    // An offshore leg tagged at 00:40 belongs to the day it set off.
    expect(sessionDateFor(at('2026-09-21T00:40:00Z'), '2026-09-20').date).toBe('2026-09-20')
  })

  it('refuses a day nobody has sailed yet', () => {
    // 28 September's Grab video presses were filed on 3 October, because that
    // was the campaign day the app had open.
    expect(sessionDateFor(at('2026-09-28T12:22:42Z'), '2026-10-03'))
      .toEqual({ date: '2026-09-28', corrected: true })
  })

  it('refuses a day long past', () => {
    expect(sessionDateFor(at('2026-09-28T12:22:42Z'), '2026-09-11'))
      .toEqual({ date: '2026-09-28', corrected: true })
  })

  it('falls back to the instant when the claim is missing or malformed', () => {
    expect(sessionDateFor(at('2026-09-28T12:22:42Z')).date).toBe('2026-09-28')
    expect(sessionDateFor(at('2026-09-28T12:22:42Z'), 'tomorrow').date).toBe('2026-09-28')
    expect(sessionDateFor(at('2026-09-28T12:22:42Z'), '').date).toBe('2026-09-28')
  })
})
