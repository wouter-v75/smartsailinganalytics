import { describe, it, expect } from 'vitest'

// Mirror of the preview <video> onLoadedMetadata merge in
// SmartSailingAnalytics_UI.jsx. That element reports DURATION; it must never
// touch the timestamp. It used to also stamp startUtc/tsSource from the file's
// mtime, which raced the async extraction in handleVids — and because that path
// logged nothing, a clip with a perfectly good filename timestamp could be filed
// under the day it was copied with no trace of why.
const onDuration = (x: any, dur: number) => ({ ...x, duration: dur })

// What the old handler did, kept so the regression stays legible.
const OLD = (x: any, dur: number) => {
  if (x.tsSource === 'mp4-meta') return { ...x, duration: dur }
  const ts = x.file?.lastModified ? x.file.lastModified - dur * 1000 : null
  return { ...x, duration: dur, startUtc: x.startUtc || ts, tsSource: x.tsSource || (ts ? 'lastmodified' : null) }
}

const MTIME = Date.parse('2026-09-04T18:30:00Z')   // when the segment was encoded
const queued = { id: 'v1', file: { lastModified: MTIME }, duration: null, startUtc: null, tsSource: null }

describe('preview duration must not decide the timestamp', () => {
  it('reproduces the bug: metadata arriving BEFORE extraction stamped file mtime', () => {
    // The real case: 20260903122957_tack_day2_DJI-001.mp4, whose name says 3 Sept.
    const out = OLD(queued, 30)
    expect(out.tsSource).toBe('lastmodified')
    expect(new Date(out.startUtc).toISOString().slice(0, 10)).toBe('2026-09-04')  // wrong day
  })

  it('the fix records only the duration, whatever the clip knows so far', () => {
    const out = onDuration(queued, 30)
    expect(out.duration).toBe(30)
    expect(out.tsSource).toBeNull()      // left for handleVids to decide
    expect(out.startUtc).toBeNull()
  })

  it('never downgrades a timestamp the extraction already resolved', () => {
    const resolved = { ...queued, tsSource: 'filename', startUtc: Date.parse('2026-09-03T10:29:57Z') }
    const out = onDuration(resolved, 30)
    expect(out.tsSource).toBe('filename')
    expect(new Date(out.startUtc).toISOString().slice(0, 10)).toBe('2026-09-03')
  })

  it('is order-independent — the race no longer decides the date', () => {
    // Duration first, then extraction; and extraction first, then duration.
    const a = { ...onDuration(queued, 30), tsSource: 'filename', startUtc: Date.parse('2026-09-03T10:29:57Z') }
    const b = onDuration({ ...queued, tsSource: 'filename', startUtc: Date.parse('2026-09-03T10:29:57Z') }, 30)
    expect(a.tsSource).toBe(b.tsSource)
    expect(a.startUtc).toBe(b.startUtc)
    expect(a.duration).toBe(b.duration)
  })
})
