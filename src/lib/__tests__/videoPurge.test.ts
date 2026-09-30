import { describe, expect, it } from 'vitest'
import { PURGE_COLUMNS, planPurge, storageKey } from '../videoPurge'

describe('planPurge', () => {
  it('collects every Bunny object a row names, not just the legacy stream id', () => {
    const plan = planPurge([{
      id: 'row-1',
      bunny_stream_id: 'legacy-guid',
      bunny_proxy_stream_id: 'proxy-guid',
      bunny_original_stream_id: 'orig-guid',
      bunny_storage_path: 'boats/x/2026-09-29/clip.mp4',
      bunny_proxy_path: 'boats/x/2026-09-29/clip.proxy.mp4',
      bunny_original_path: 'boats/x/2026-09-29/clip.orig.mp4',
    }])
    expect(plan.streamIds).toEqual(['legacy-guid', 'proxy-guid', 'orig-guid'])
    expect(plan.storageKeys).toEqual([
      'boats/x/2026-09-29/clip.mp4',
      'boats/x/2026-09-29/clip.proxy.mp4',
      'boats/x/2026-09-29/clip.orig.mp4',
    ])
  })

  it('finds the storage object of a clip that was never a Stream video', () => {
    // The clips the watcher uploads: a storage path and nothing else. This is
    // the shape the old delete path could not see at all.
    const plan = planPurge([{ id: 'r', bunny_storage_path: 'clips/20260929132920_gate.mp4' }])
    expect(plan.streamIds).toEqual([])
    expect(plan.storageKeys).toEqual(['clips/20260929132920_gate.mp4'])
  })

  it('ignores empty, whitespace and missing columns', () => {
    const plan = planPurge([
      { id: 'a', bunny_stream_id: null, bunny_storage_path: '   ' },
      { id: 'b' },
    ])
    expect(plan).toEqual({ streamIds: [], storageKeys: [] })
  })

  it('de-duplicates across rows, so a shared proxy is purged once', () => {
    const plan = planPurge([
      { id: 'a', bunny_proxy_path: 'p/shared.mp4', bunny_stream_id: 'g' },
      { id: 'b', bunny_proxy_path: 'p/shared.mp4', bunny_stream_id: 'g' },
    ])
    expect(plan.storageKeys).toEqual(['p/shared.mp4'])
    expect(plan.streamIds).toEqual(['g'])
  })

  it('treats /a/b and a/b as the same object', () => {
    // Different uploaders stored the path differently. Deleting both spellings
    // means the second attempt 404s, which a caller would read as a failure.
    const plan = planPurge([
      { id: 'a', bunny_storage_path: '/clips/x.mp4' },
      { id: 'b', bunny_storage_path: 'clips/x.mp4' },
    ])
    expect(plan.storageKeys).toEqual(['clips/x.mp4'])
  })

  it('survives a null row list', () => {
    expect(planPurge([])).toEqual({ streamIds: [], storageKeys: [] })
  })

  it('PURGE_COLUMNS names every column planPurge reads', () => {
    // The DELETE returns exactly these; a column missing here is an object that
    // silently outlives its row, because the row is gone before anyone notices.
    for (const col of [
      'bunny_stream_id', 'bunny_proxy_stream_id', 'bunny_original_stream_id',
      'bunny_storage_path', 'bunny_proxy_path', 'bunny_original_path',
    ]) {
      expect(PURGE_COLUMNS.split(',')).toContain(col)
    }
  })
})

describe('storageKey', () => {
  it('strips leading slashes and trims', () => {
    expect(storageKey('  /a/b.mp4 ')).toBe('a/b.mp4')
    expect(storageKey('///a.mp4')).toBe('a.mp4')
  })
  it('is empty for anything that is not a string', () => {
    expect(storageKey(null)).toBe('')
    expect(storageKey(undefined)).toBe('')
    expect(storageKey(42)).toBe('')
  })
})
