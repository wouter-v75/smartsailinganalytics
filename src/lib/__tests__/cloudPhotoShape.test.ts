// src/lib/__tests__/cloudPhotoShape.test.ts
// ─────────────────────────────────────────────────────────────────────────────
// `toLegacyPhotoShape` is the seam every member but one looks through.
//
// A photo is imported on one laptop; everyone else's gallery loads it from the
// Supabase row and runs it through here. Whatever this function does not hydrate
// simply does not exist for them — which is how instrument overlays came to be
// visible only to the person who imported the day, and is the reason the sail
// geometry travels in `analysis_data` at all.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest'
import { toLegacyPhotoShape } from '../cloud-photos'
import { isAnnotation } from '../sailTrimOverlay'

const row = (analysis: unknown) => ({
  id: 'p1',
  session_id: 's1',
  taken_utc: '2026-09-05T10:46:00.000Z',
  exif_data: null,
  thumbnail_url: 'https://cdn/thumb.jpg',
  bunny_storage_path: '2026-09-05/photos/_MG_0397.JPG',
  bytes: 8_100_000,
  analysis_data: analysis,
  created_at: '2026-09-05T12:00:00.000Z',
  created_by_user_id: 'u1',
  sessions: { date: '2026-09-05' },
})

const annotation = {
  version: 'sailtrim-v0.2-horizon',
  imageSize: { w: 6000, h: 4000 },
  defn: 'boat' as const,
  axis: { low: { x: 2900, y: 3400 }, high: { x: 3100, y: 400 } },
  targets: [
    { key: 'clew', label: 'Jib clew', point: { x: 3280, y: 2600 }, foot: { x: 3010, y: 2580 }, mm: -1103, sigmaMm: 14, colour: '#FB923C' },
  ],
  psiDeg: 0.42, psiMeasured: true, heelDeg: 22.7, measuredAt: 1_700_000_000_000,
}

describe('toLegacyPhotoShape', () => {
  it('hydrates the sail geometry as the JSON string PhotosTab reads', () => {
    const sailTrim = { annotation, overlay: true, headline: 'clew 1103 mm' }
    const shape = toLegacyPhotoShape(row({ inst: { tws: 14.2 }, sailTrim }))

    expect(typeof shape.sailtrim_data).toBe('string')
    const parsed = JSON.parse(shape.sailtrim_data as string)
    expect(parsed.overlay).toBe(true)
    // And it is still drawable after the round trip through JSONB and back.
    expect(isAnnotation(parsed.annotation)).toBe(true)
    expect(parsed.annotation.targets[0].mm).toBe(-1103)
  })

  it('leaves it null for a photo nobody has measured, rather than "null" the string', () => {
    const shape = toLegacyPhotoShape(row({ inst: { tws: 14.2 } }))
    expect(shape.sailtrim_data).toBeNull()
  })

  it('survives an analysis_data of null, which is most photos', () => {
    const shape = toLegacyPhotoShape(row(null))
    expect(shape.sailtrim_data).toBeNull()
    expect(shape.tws).toBeNull()
    expect(shape.sails).toEqual([])
  })

  it('still hydrates the instruments and tags it always did', () => {
    const shape = toLegacyPhotoShape(row({
      inst: { tws: 14.2, twa: 42, awa: 28, bsp: 9.8, heel: 22.7, vmg: 7.3 },
      sails: ['J2', 'Main'], raceTags: ['race-3'], boat: 'Northstar III', location: 'Palma',
      sailTrim: { annotation, overlay: false },
    }))
    expect(shape.tws).toBe(14.2)
    expect(shape.heel).toBe(22.7)
    expect(shape.sails).toEqual(['J2', 'Main'])
    expect(shape.raceTags).toEqual(['race-3'])
    expect(shape.boat).toBe('Northstar III')
    expect(shape.sessionDate).toBe('2026-09-05')
    expect(shape.bunnyPath).toBe('2026-09-05/photos/_MG_0397.JPG')
  })
})
