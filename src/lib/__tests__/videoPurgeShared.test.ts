// Two rows, one Stream video: deleting one must not purge the other's bytes.
//
// The shape planPurge already names — "two rows sharing a proxy (a re-upload
// that reused it)". Deleting one purges the object the other depends on; the
// delete succeeds, the purge succeeds, and the survivor's locator resolves to
// nothing, with no error anywhere.
//
// This is a guard, not a reproduction. The 29 Sept duplicate pairs looked like
// the live case — both rows `orig✓`, 0 duplicate clip names in the library —
// and sharedLocators(), comparing stored values instead of inferring, found
// nothing shared in any of the seven groups. The guids differ and both resolve.

import { describe, it, expect } from 'vitest'
import { planPurge, splitPurge, storageKey } from '../videoPurge'

const ORIG = 'f0f0f0f0-0000-0000-0000-000000000001'

describe('splitPurge', () => {
  it('withholds the guid the surviving row shares', () => {
    const deleted = planPurge([{ id: 'dupe', bunny_original_stream_id: ORIG, tags: [] } as never])
    const { purge, withheld } = splitPurge(deleted, { streamIds: [ORIG], storageKeys: [] })
    expect(withheld.streamIds).toEqual([ORIG])
    expect(purge.streamIds).toEqual([])
  })

  it('still purges the parts nothing else points at', () => {
    const deleted = planPurge([{
      id: 'dupe',
      bunny_original_stream_id: ORIG,
      bunny_proxy_stream_id: 'proxy-of-the-dupe-only',
      bunny_proxy_path: 'proxies/dupe.mp4',
    } as never])
    const { purge, withheld } = splitPurge(deleted, { streamIds: [ORIG], storageKeys: [] })
    expect(withheld.streamIds).toEqual([ORIG])
    expect(purge.streamIds).toEqual(['proxy-of-the-dupe-only'])
    expect(purge.storageKeys).toEqual(['proxies/dupe.mp4'])
  })

  it('matches a storage key across the leading-slash difference', () => {
    // The same object, written by two uploaders. A comparison that misses here
    // makes a needed object look unreferenced — the one direction that loses
    // data, which is why the normalisation is not left to the caller.
    const deleted = planPurge([{ id: 'd', bunny_original_path: '/originals/a.mp4' } as never])
    const { purge, withheld } = splitPurge(deleted, {
      streamIds: [], storageKeys: ['originals/a.mp4'],
    })
    expect(withheld.storageKeys).toHaveLength(1)
    expect(storageKey(withheld.storageKeys[0])).toBe('originals/a.mp4')
    expect(purge.storageKeys).toEqual([])
  })

  it('purges everything when nothing survives — the ordinary delete', () => {
    const deleted = planPurge([{
      id: 'only', bunny_stream_id: 'legacy', bunny_original_path: 'originals/a.mp4',
    } as never])
    const { purge, withheld } = splitPurge(deleted, { streamIds: [], storageKeys: [] })
    expect(purge).toEqual(deleted)
    expect(withheld.streamIds).toEqual([])
    expect(withheld.storageKeys).toEqual([])
  })

  it('ignores blanks and whitespace in what survives', () => {
    const deleted = planPurge([{ id: 'd', bunny_stream_id: 'keepme' } as never])
    const { purge } = splitPurge(deleted, {
      streamIds: ['', '   ', null as unknown as string], storageKeys: [''],
    })
    expect(purge.streamIds).toEqual(['keepme'])
  })

  it('withholds a guid shared through a DIFFERENT column', () => {
    // The dupe names it as the original; the survivor as its legacy copy. It is
    // the same video either way, so the column it is named in cannot matter.
    const deleted = planPurge([{ id: 'd', bunny_original_stream_id: ORIG } as never])
    const { withheld } = splitPurge(deleted, { streamIds: [ORIG], storageKeys: [] })
    expect(withheld.streamIds).toEqual([ORIG])
  })

  it('handles a whole-day delete where the rows shared a proxy', () => {
    const deleted = planPurge([
      { id: 'a', bunny_proxy_stream_id: 'shared-proxy', bunny_original_stream_id: 'orig-a' },
      { id: 'b', bunny_proxy_stream_id: 'shared-proxy', bunny_original_stream_id: 'orig-b' },
    ] as never)
    expect(deleted.streamIds).toContain('shared-proxy')
    // Nothing survives, so the shared proxy goes — once.
    const { purge } = splitPurge(deleted, { streamIds: [], storageKeys: [] })
    expect(purge.streamIds.filter((s) => s === 'shared-proxy')).toHaveLength(1)
    // But if a third row kept it, it stays.
    const kept = splitPurge(deleted, { streamIds: ['shared-proxy'], storageKeys: [] })
    expect(kept.withheld.streamIds).toEqual(['shared-proxy'])
    expect(kept.purge.streamIds).toEqual(['orig-a', 'orig-b'])
  })
})
