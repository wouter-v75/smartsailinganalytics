import { describe, it, expect } from 'vitest'
// @ts-expect-error — plain-JS module, no d.ts
import { rolePermissions } from '../rolePermissions'

// The role matrix used to be nine consts inside a 9.6k-line component, split
// across two places. Nobody could read it without grepping and nothing tested
// it. These flags decide what the UI OFFERS — RLS and the API routes are the
// real boundary — but a wrong flag still shows someone a control they should
// not see, so the matrix is pinned here.

const ROLES = ['admin','team_manager','coach','tl3','tl2','tl1','owner','consultant','guest']

describe('rolePermissions', () => {
  it('is permissive while the role is still resolving', () => {
    // effectiveRole starts null on every load. If the flags defaulted to
    // restrictive, an admin would watch the UI hide their own tabs and then
    // put them back on each refresh.
    const p = rolePermissions(null)
    expect(p.canSeeSailScanTab).toBe(true)
    expect(p.canSeeSquashShotsTab).toBe(true)
    expect(p.canSeeAnalyticsData).toBe(true)
    expect(p.canSeeSailScanPhotos).toBe(true)
    expect(p.canUseAI).toBe(true)
    expect(p.showOnlyLatestDay).toBe(false)
  })

  it('gives the full team roles everything', () => {
    for (const role of ['admin','team_manager','coach'] as const) {
      const p = rolePermissions(role)
      expect({ role, ...p }).toMatchObject({
        canSeeSailScanTab: true, canSeeSquashShotsTab: true, canSeeToolsTab: true,
        canSeeBoatConfig: true, canSeeAnalyticsData: true, canSeeSailScanPhotos: true,
        canUseAI: true, showOnlyLatestDay: false,
      })
    }
  })

  describe('the team-leader ladder', () => {
    it('gives Boat Config to TL3 but not TL2', () => {
      expect(rolePermissions('tl3').canSeeBoatConfig).toBe(true)
      expect(rolePermissions('tl2').canSeeBoatConfig).toBe(false)
      expect(rolePermissions('tl1').canSeeBoatConfig).toBe(false)
    })

    it('gives the Tools tab down to TL2 but not TL1', () => {
      expect(rolePermissions('tl3').canSeeToolsTab).toBe(true)
      expect(rolePermissions('tl2').canSeeToolsTab).toBe(true)
      expect(rolePermissions('tl1').canSeeToolsTab).toBe(false)
    })

    it('cuts TL1 off from SailScan and analytics data, but not the app', () => {
      const p = rolePermissions('tl1')
      expect(p.canSeeSailScanTab).toBe(false)
      expect(p.canSeeAnalyticsData).toBe(false)
      expect(p.canSeeSailScanPhotos).toBe(false)
      expect(p.canUseAI).toBe(false)
      expect(p.canSeeSquashShotsTab).toBe(true)   // TL1 keeps SquashShots
      expect(p.showOnlyLatestDay).toBe(false)     // and the whole history
    })
  })

  it('treats owner exactly like tl1', () => {
    const { canSeeAnalytics: _a, ...owner } = rolePermissions('owner')
    const { canSeeAnalytics: _b, ...tl1 } = rolePermissions('tl1')
    expect(owner).toEqual(tl1)
  })

  it('restricts guest the most, and only guest sees a single day', () => {
    const p = rolePermissions('guest')
    expect(p.canSeeSailScanTab).toBe(false)
    expect(p.canSeeSquashShotsTab).toBe(false)
    expect(p.canSeeAnalyticsData).toBe(false)
    expect(p.canSeeSailScanPhotos).toBe(false)
    expect(p.canSeeToolsTab).toBe(false)
    expect(p.canSeeBoatConfig).toBe(false)
    expect(p.canUseAI).toBe(false)
    expect(p.showOnlyLatestDay).toBe(true)

    for (const r of ROLES.filter(r => r !== 'guest')) {
      expect(rolePermissions(r).showOnlyLatestDay).toBe(false)
    }
  })

  it('gives a consultant the boat data but not AI', () => {
    // A sailmaker is in for a period (bounded by valid_from/valid_to in RLS).
    // They need the sails and the scans; the AI budget is the team's.
    const p = rolePermissions('consultant')
    expect(p.canSeeBoatConfig).toBe(true)
    expect(p.canSeeToolsTab).toBe(true)
    expect(p.canSeeSailScanTab).toBe(true)
    expect(p.canSeeAnalyticsData).toBe(true)
    expect(p.canUseAI).toBe(false)
  })

  it('shows the Analytics tab to everyone — the content inside is what is gated', () => {
    for (const r of [...ROLES, null]) expect(rolePermissions(r).canSeeAnalytics).toBe(true)
  })

  it('splits two ways on a role nobody has defined — pinned, not endorsed', () => {
    const p = rolePermissions('some_new_role')
    // Inclusion lists name who may: an unknown role is shut out.
    expect(p.canSeeToolsTab).toBe(false)
    expect(p.canSeeBoatConfig).toBe(false)
    // Exclusion lists name who may not: an unknown role falls OPEN. That is
    // deliberate for `null` (still resolving) but it also covers a role string
    // that reaches the client without being added here.
    expect(p.canSeeSailScanTab).toBe(true)
    expect(p.canSeeAnalyticsData).toBe(true)
    expect(p.canUseAI).toBe(true)
    // Low severity — these flags only decide what the UI offers, and RLS plus
    // the per-route checks still refuse the request. Recorded so the asymmetry
    // is a decision rather than an accident: closing it means separating
    // "resolving" from "unknown", which is a behaviour change, not a tidy-up.
  })
})
