import { describe, it, expect, beforeEach, vi } from 'vitest'
import { objectUrlFor, releaseObjectUrl, liveObjectUrlCount } from '../objectUrls'

let minted = 0
let revoked: string[] = []

beforeEach(() => {
  minted = 0
  revoked = []
  // jsdom has no blob: URL support; count the calls instead.
  vi.stubGlobal('URL', {
    createObjectURL: () => `blob:fake/${++minted}`,
    revokeObjectURL: (u: string) => { revoked.push(u) },
  })
  // Each test starts from whatever the previous left; release the ids it uses.
  for (const id of ['v1', 'v2', 'v3']) releaseObjectUrl(id)
  minted = 0
  revoked = []
})

const blob = () => ({ size: 1 }) as unknown as Blob

describe('objectUrlFor', () => {
  it('mints one URL per clip, however many times the row is re-read', () => {
    const a = objectUrlFor('v1', blob())
    // A fresh Blob each time is the real case: every IndexedDB read deserialises
    // new Blob objects, so identity comparison could never have deduped these.
    const b = objectUrlFor('v1', blob())
    const c = objectUrlFor('v1', blob())
    expect(a).toBe(b)
    expect(b).toBe(c)
    expect(minted).toBe(1)
  })

  it('does not leak across ten date switches — the loadDate case', () => {
    for (let i = 0; i < 10; i++) {
      objectUrlFor('v1', blob())
      objectUrlFor('v2', blob())
    }
    expect(minted).toBe(2)
    expect(liveObjectUrlCount()).toBe(2)
  })

  it('keeps clips apart', () => {
    expect(objectUrlFor('v1', blob())).not.toBe(objectUrlFor('v2', blob()))
    expect(minted).toBe(2)
  })

  it('returns null for a clip with no local blob, and mints nothing', () => {
    expect(objectUrlFor('v1', null as unknown as Blob)).toBeNull()
    expect(objectUrlFor('v1', undefined as unknown as Blob)).toBeNull()
    expect(minted).toBe(0)
  })

  it('hands back a one-off when there is no id to key on', () => {
    const a = objectUrlFor(null, blob())
    const b = objectUrlFor(null, blob())
    expect(a).not.toBe(b)
    expect(liveObjectUrlCount()).toBe(0) // not held — the caller owns it
  })
})

describe('releaseObjectUrl', () => {
  it('revokes the URL and lets the next read mint fresh bytes', () => {
    const before = objectUrlFor('v1', blob())
    expect(releaseObjectUrl('v1')).toBe(true)
    expect(revoked).toEqual([before])
    const after = objectUrlFor('v1', blob())
    expect(after).not.toBe(before)   // the crop's new bytes get their own URL
    expect(minted).toBe(2)
  })

  it('is a no-op for a clip that has none, and safe to call twice', () => {
    expect(releaseObjectUrl('v3')).toBe(false)
    objectUrlFor('v3', blob())
    expect(releaseObjectUrl('v3')).toBe(true)
    expect(releaseObjectUrl('v3')).toBe(false)
    expect(revoked).toHaveLength(1)
  })

  it('survives a revoke that throws', () => {
    vi.stubGlobal('URL', {
      createObjectURL: () => `blob:fake/${++minted}`,
      revokeObjectURL: () => { throw new Error('gone') },
    })
    objectUrlFor('v1', blob())
    expect(() => releaseObjectUrl('v1')).not.toThrow()
    expect(liveObjectUrlCount()).toBe(0)
  })
})
