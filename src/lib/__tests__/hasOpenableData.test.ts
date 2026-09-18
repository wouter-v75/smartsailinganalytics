import { describe, it, expect } from 'vitest'
// @ts-expect-error — plain-JS module, no d.ts
import { hasOpenableData } from '../hasOpenableData'

// This used to be a hand-kept COPY of the predicate, because it lived inside an
// 8k-line client component that could not be imported under jsdom. It now has a
// module of its own, so the test exercises the real thing and can no longer
// drift away from it.

describe('session visibility in Analytics + the sessions sidebar', () => {
  it('shows a LOG-ONLY day — the case that was invisible before', () => {
    // 2026-09-02: uploaded a logfile, no video or photos yet.
    expect(hasOpenableData({ date: '2026-09-02', hasLog: true, videoCount: 0 })).toBe(true)
    // 2026-07-30 was hidden by the same rule long before that upload.
    expect(hasOpenableData({ date: '2026-07-30', hasLog: true })).toBe(true)
  })

  it('still shows days with video, as before', () => {
    expect(hasOpenableData({ videoCount: 3 })).toBe(true)
    expect(hasOpenableData({ videoCount: 1, hasLog: true })).toBe(true)
  })

  it('shows photo-only and events-only days', () => {
    expect(hasOpenableData({ photoCount: 5 })).toBe(true)
    expect(hasOpenableData({ hasXml: true })).toBe(true)
  })

  it('still hides a genuinely empty session', () => {
    // e.g. 2026-06-29 in the real index: no log, no events, no media.
    expect(hasOpenableData({ date: '2026-06-29', videoCount: 0, hasLog: false, hasXml: false, photoCount: 0 })).toBe(false)
    expect(hasOpenableData({})).toBe(false)
    expect(hasOpenableData(null)).toBe(false)
    expect(hasOpenableData(undefined)).toBe(false)
  })

  it('treats missing counts as zero rather than throwing', () => {
    expect(hasOpenableData({ videoCount: undefined, photoCount: undefined })).toBe(false)
    expect(hasOpenableData({ hasLog: undefined })).toBe(false)
  })

  it('reproduces the OLD rule as wrong, pinning the regression', () => {
    const oldRule = (s: any) => (s.videoCount || 0) > 0
    const logOnlyDay = { date: '2026-09-02', hasLog: true, videoCount: 0 }
    expect(oldRule(logOnlyDay)).toBe(false)      // what hid it
    expect(hasOpenableData(logOnlyDay)).toBe(true)
  })
})
