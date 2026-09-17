import { describe, it, expect } from 'vitest'
import { canBuildPhases, canUploadPhases, phaseRoleNote } from '../phaseRoles'

describe('who may build phases', () => {
  it('is TL2 and up', () => {
    for (const r of ['admin', 'team_manager', 'coach', 'tl3', 'tl2']) expect(canBuildPhases(r)).toBe(true)
  })

  it('is not TL1, a consultant, a guest or nobody', () => {
    for (const r of ['tl1', 'owner', 'consultant', 'guest', '', null, undefined]) expect(canBuildPhases(r)).toBe(false)
  })
})

describe('who may upload phases to the cloud', () => {
  it('is coach and up — it changes what the team sees', () => {
    for (const r of ['admin', 'team_manager', 'coach']) expect(canUploadPhases(r)).toBe(true)
  })

  it('is not a team leader, however senior', () => {
    for (const r of ['tl3', 'tl2', 'tl1', 'owner', 'consultant', 'guest', null]) expect(canUploadPhases(r)).toBe(false)
  })
})

describe('what to tell someone who cannot', () => {
  it('says nothing to a coach', () => {
    expect(phaseRoleNote('coach')).toBeNull()
  })

  it('tells a TL2 their work stays on the device', () => {
    expect(phaseRoleNote('tl2')).toMatch(/stay on this device/)
  })

  it('tells everyone else why the control is not there', () => {
    expect(phaseRoleNote('tl1')).toMatch(/TL2 and up/)
  })
})
