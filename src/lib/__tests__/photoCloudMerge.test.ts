// src/lib/__tests__/photoCloudMerge.test.ts
// ─────────────────────────────────────────────────────────────────────────────
// The dedupe between a day's LOCAL photos and the team's CLOUD rows.
//
// PhotosTab prefers the local copy, which is right for the bytes: the original
// is already in IndexedDB. It used to drop the cloud row entirely, which is
// wrong for anything AUTHORED in the cloud — a sail-geometry annotation saved
// from the timeline lands on the cloud row and never touches this machine. The
// result was full measurements in the timeline and an instrument card alone in
// the photo tab, for the one person who had imported the day.
//
// The merge itself is a few lines inside a component effect, so it is mirrored
// here as the pure function it is, and asserted on the cases that mattered.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest'

interface Photo { id: string; bunnyPath?: string | null; url?: string | null; sailtrim_data?: string | null }

/** Exactly the rule PhotosTab applies: local wins, cloud fills the gaps. */
function mergeCloud(local: Photo[], cloud: Photo[]): { merged: Photo[]; cloudOnly: Photo[] } {
  const key = (p: Photo) => p.bunnyPath || p.url || null
  const localKeys = new Set(local.map(key).filter(Boolean))
  const extras = new Map<string, Photo>()
  const cloudOnly: Photo[] = []
  for (const c of cloud) {
    const k = c.bunnyPath || null
    if (k && localKeys.has(k)) { extras.set(k, c); continue }
    cloudOnly.push(c)
  }
  const merged = local.map((m) => {
    const k = key(m)
    const c = k ? extras.get(k) : null
    return c ? { ...m, sailtrim_data: m.sailtrim_data ?? c.sailtrim_data ?? null } : m
  })
  return { merged, cloudOnly }
}

const ANN = JSON.stringify({ annotation: { targets: [{ key: 'jib@stripe50' }] } })

describe('local/cloud photo merge', () => {
  it('takes a cloud-authored measurement onto the local copy', () => {
    const { merged, cloudOnly } = mergeCloud(
      [{ id: 'local-1', bunnyPath: 'p/one.jpg' }],
      [{ id: 'cloud-1', bunnyPath: 'p/one.jpg', sailtrim_data: ANN }],
    )
    // Still ONE photo — the local one, not a duplicate.
    expect(merged).toHaveLength(1)
    expect(cloudOnly).toHaveLength(0)
    expect(merged[0].id).toBe('local-1')
    // …now carrying what only the cloud knew.
    expect(merged[0].sailtrim_data).toBe(ANN)
  })

  it('does not overwrite a measurement made on this machine', () => {
    // The operator's own edit is written locally first, so it is the newer of
    // the two; the cloud copy may still be the previous version.
    const mine = JSON.stringify({ annotation: { targets: [{ key: 'mine' }] } })
    const { merged } = mergeCloud(
      [{ id: 'local-1', bunnyPath: 'p/one.jpg', sailtrim_data: mine }],
      [{ id: 'cloud-1', bunnyPath: 'p/one.jpg', sailtrim_data: ANN }],
    )
    expect(merged[0].sailtrim_data).toBe(mine)
  })

  it('still lists a cloud photo this machine does not hold', () => {
    const { merged, cloudOnly } = mergeCloud(
      [{ id: 'local-1', bunnyPath: 'p/one.jpg' }],
      [{ id: 'cloud-2', bunnyPath: 'p/two.jpg', sailtrim_data: ANN }],
    )
    expect(merged).toHaveLength(1)
    expect(cloudOnly).toHaveLength(1)
    expect(cloudOnly[0].id).toBe('cloud-2')
  })

  it('leaves a local photo with no cloud row alone', () => {
    const { merged } = mergeCloud([{ id: 'local-1', bunnyPath: 'p/one.jpg' }], [])
    expect(merged[0].sailtrim_data).toBeUndefined()
  })
})
