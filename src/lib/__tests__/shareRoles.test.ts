import { describe, it, expect } from 'vitest'
import { canShareVideos, ROLE_LABELS } from '../shareRoles'

describe('canShareVideos', () => {
  it('admits TL2 and up', () => {
    for (const r of ['admin', 'team_manager', 'coach', 'tl3', 'tl2']) expect(canShareVideos(r)).toBe(true)
  })
  it('admits the boat owner — TL1 in all else, but sharing is the point of the role', () => {
    expect(canShareVideos('owner')).toBe(true)
  })
  it('refuses TL1, consultants, guests and nobody', () => {
    for (const r of ['tl1', 'consultant', 'guest', '', null, undefined]) expect(canShareVideos(r)).toBe(false)
  })
  it('labels the owner role', () => {
    expect(ROLE_LABELS.owner).toBe('Owner')
  })
})
