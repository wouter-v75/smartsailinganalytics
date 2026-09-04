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

// Mirror of the Save gate in the Upload tab. Reading a clip's capture time is
// asynchronous (probeVideo, then the metadata scan), and saving before it lands
// stores startUtc=null — which files the clip under TODAY with no time and no
// tags, because computeAutoTags has no window to work with.
const pendingCount = (vids: any[]) => vids.filter(v => !v.tsSource && !v.error && !v.undecodable).length

describe('Save must wait for the timestamps', () => {
  const resolved = { tsSource: 'filename', startUtc: 1 }
  const unread = { tsSource: null, startUtc: null }

  it('reproduces the bug: a clip still being read has no timestamp to save', () => {
    expect(pendingCount([unread])).toBe(1)
  })

  it('is ready once every clip has been read', () => {
    expect(pendingCount([resolved, resolved])).toBe(0)
  })

  it('counts only what is still outstanding', () => {
    expect(pendingCount([resolved, unread, resolved, unread])).toBe(2)
  })

  it('does not wait forever on a clip that CANNOT be read', () => {
    // A failed probe has had its answer — blocking on it would strand the upload.
    expect(pendingCount([{ ...unread, error: 'timed out reading the video (10 s)' }])).toBe(0)
    expect(pendingCount([{ ...unread, undecodable: true }])).toBe(0)
  })

  it('treats an empty queue as ready, so a log-only upload still saves', () => {
    expect(pendingCount([])).toBe(0)
  })
})

// Mirror of the AUTO-SAVE gate. This is the one that actually fires: saveLocal is
// called from an effect as soon as the queue looks "processed", not from the button.
const clipTimestampSettled = (v: any) => v.tsSource != null || !!v.error || !!v.undecodable
const autoSaveReady = (vids: any[]) =>
  vids.length > 0 && vids.every(v => v.duration != null && clipTimestampSettled(v))

describe('auto-save must wait for the timestamp, not the duration', () => {
  it('reproduces the bug: duration lands first and used to trigger the save', () => {
    // The preview <video> reports duration within a few hundred ms; probeVideo plus
    // the metadata scan take seconds. Gating on duration alone saved a clip whose
    // startUtc was still null — filed under today, no time, no tags.
    const midFlight = [{ duration: 10, tsSource: null, startUtc: null }]
    const OLD_GATE = (vids: any[]) => vids.every(v => v.duration != null)
    expect(OLD_GATE(midFlight)).toBe(true)      // fired too early
    expect(autoSaveReady(midFlight)).toBe(false) // now waits
  })

  it('fires once every clip has both duration and a timestamp', () => {
    expect(autoSaveReady([{ duration: 10, tsSource: 'filename' }, { duration: 4, tsSource: 'mp4-meta' }])).toBe(true)
  })

  it('waits for the slowest clip, not the first', () => {
    expect(autoSaveReady([{ duration: 10, tsSource: 'filename' }, { duration: 4, tsSource: null }])).toBe(false)
  })

  it('is not stranded by a clip that cannot be read', () => {
    expect(autoSaveReady([{ duration: 10, tsSource: 'filename' }, { duration: 2, tsSource: null, undecodable: true }])).toBe(true)
    expect(autoSaveReady([{ duration: 10, tsSource: 'filename' }, { duration: 2, tsSource: null, error: 'timed out' }])).toBe(true)
  })

  it('does not fire on an empty queue', () => {
    expect(autoSaveReady([])).toBe(false)
  })
})
