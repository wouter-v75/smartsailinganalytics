// src/lib/__tests__/mergeCloudIntoLocal.test.ts
// ─────────────────────────────────────────────────────────────────────────────
// Folding the team's cloud row into the local record for the same photo.
//
// The photo tab prefers the local copy for the bytes and used to drop the cloud
// row entirely, which lost everything only the cloud knows — and lost it for the
// one person who had imported the day. Sail geometry was the visible casualty:
// full numbers in the timeline, an instrument card alone in the photo tab.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest'
import { mergeCloudIntoLocal } from '../cloud-photos'

const CLOUD_TRIM = JSON.stringify({ annotation: { targets: [{ key: 'jib@stripe50' }] } })
const LOCAL_TRIM = JSON.stringify({ annotation: { targets: [{ key: 'local-only' }] } })

describe('mergeCloudIntoLocal', () => {
  it('leaves the local record alone when there is no cloud row', () => {
    const local = { id: 'a', sails: ['J2_B 2026'] }
    expect(mergeCloudIntoLocal(local, null)).toEqual(local)
  })

  describe('sail geometry — the cloud owns it', () => {
    it('takes the cloud copy onto a local record that has none', () => {
      const out = mergeCloudIntoLocal({ id: 'a' }, { sailtrim_data: CLOUD_TRIM })
      expect(out.sailtrim_data).toBe(CLOUD_TRIM)
    })

    it('OVERRIDES a local copy — it is the one source of truth', () => {
      // Deliberately the opposite rule from every other field. Both save paths
      // write geometry to the shared row the moment it is measured, so a local
      // copy that differs is the stale one.
      const out = mergeCloudIntoLocal({ id: 'a', sailtrim_data: LOCAL_TRIM }, { sailtrim_data: CLOUD_TRIM })
      expect(out.sailtrim_data).toBe(CLOUD_TRIM)
    })

    it('keeps the local copy when the shared write never landed', () => {
      const out = mergeCloudIntoLocal({ id: 'a', sailtrim_data: LOCAL_TRIM }, { sailtrim_data: null })
      expect(out.sailtrim_data).toBe(LOCAL_TRIM)
    })

    it('carries the cloud sailTrim into analysis as well', () => {
      const out = mergeCloudIntoLocal(
        { id: 'a', analysis: { inst: { tws: 9 } } },
        { sailtrim_data: CLOUD_TRIM, analysis: { inst: { tws: 1 }, sailTrim: { headline: 'from cloud' } } },
      ) as { analysis: { inst: { tws: number }; sailTrim: { headline: string } } }
      expect(out.analysis.sailTrim.headline).toBe('from cloud')
      // …without the cloud's older instrument data displacing the local one.
      expect(out.analysis.inst.tws).toBe(9)
    })
  })

  describe('everything else — the cloud fills gaps only', () => {
    it('fills a field the local record has no value for', () => {
      const out = mergeCloudIntoLocal({ id: 'a', boat: null }, { boat: 'Northstar 76', location: 'Palma' })
      expect(out.boat).toBe('Northstar 76')
      expect((out as { location?: string }).location).toBe('Palma')
    })

    it('keeps a local value rather than replacing it', () => {
      const out = mergeCloudIntoLocal({ id: 'a', boat: 'Northstar72' }, { boat: 'Northstar 76' })
      expect(out.boat).toBe('Northstar72')
    })

    it('treats an EMPTY LIST as no value', () => {
      // An import that read no sail tags leaves `sails: []`, which `??` would
      // happily keep — and the cloud's tags would never arrive.
      const out = mergeCloudIntoLocal({ id: 'a', sails: [], raceTags: ['R3'] }, { sails: ['J2_B 2026'], raceTags: ['R9'] })
      expect(out.sails).toEqual(['J2_B 2026'])
      expect(out.raceTags).toEqual(['R3'])
    })

    it('lets a cloud-only analysis key through while local keys win', () => {
      const out = mergeCloudIntoLocal(
        { id: 'a', analysis: { inst: { tws: 9 } } },
        { analysis: { inst: { tws: 1 }, raceTags: ['R9'] } },
      ) as { analysis: { inst: { tws: number }; raceTags: string[] } }
      expect(out.analysis.inst.tws).toBe(9)
      expect(out.analysis.raceTags).toEqual(['R9'])
    })

    it('does not invent an analysis blob that neither side has', () => {
      const out = mergeCloudIntoLocal({ id: 'a' }, { boat: 'Northstar 76' })
      expect((out as { analysis?: unknown }).analysis).toBeUndefined()
    })
  })
})
