import { describe, it, expect } from 'vitest'
// @ts-expect-error — plain-JS module, no d.ts
import { extractTimestampFromFilename, clipTimestampSettled, resolveStartUtc } from '../videoProbe'

// resolveStartUtc decides WHEN a clip was recorded, which decides which session
// it lands in and whether the instrument overlay lines up with the footage.
// Getting it wrong is not cosmetic: the day cannot be sailed again.
//
// The rule it implements: a filename stamps the START of a recording and is
// local wall-clock by definition; mvhd may be the start or the moment the file
// was finalised, one whole duration later.

const TZ = 120 // CEST, minutes east
const nameUtc = Date.UTC(2026, 8, 11, 11, 34, 42)   // "…20260911113442…" read as if UTC
const nameStart = nameUtc - TZ * 60000              // the true UTC instant that names

describe('extractTimestampFromFilename', () => {
  it('reads the 14-digit run a DJI writes', () => {
    expect(extractTimestampFromFilename('DJI_20260911113442.MP4')).toBe(nameUtc)
  })

  it('reads the separated form Android and friends write', () => {
    expect(extractTimestampFromFilename('VID_20260911_113442.mp4')).toBe(nameUtc)
    expect(extractTimestampFromFilename('20260911-113442.mp4')).toBe(nameUtc)
    expect(extractTimestampFromFilename('20260911 113442.mp4')).toBe(nameUtc)
  })

  it('does NOT read a dashed ISO date — a known gap, pinned so it is visible', () => {
    // Both patterns want the date as 8 contiguous digits, so a filename like
    // `2026-09-11T11:34:42` (macOS screen recordings, some action cams) yields
    // nothing and the clip falls back to mtime. Widening this changes which
    // day existing clips land in, so it is a deliberate decision, not a typo.
    expect(extractTimestampFromFilename('2026-09-11T113442.mov')).toBeNull()
    expect(extractTimestampFromFilename('2026-09-11 11.34.42.mov')).toBeNull()
  })

  it('refuses digits that cannot be a date rather than inventing one', () => {
    expect(extractTimestampFromFilename('CLIP_20261311113442.mp4')).toBeNull() // month 13
    expect(extractTimestampFromFilename('CLIP_20260911253442.mp4')).toBeNull() // hour 25
    expect(extractTimestampFromFilename('CLIP_19990911113442.mp4')).toBeNull() // before 2000
    expect(extractTimestampFromFilename('IMG_1234.MOV')).toBeNull()
    expect(extractTimestampFromFilename('')).toBeNull()
    expect(extractTimestampFromFilename(null)).toBeNull()
  })
})

describe('clipTimestampSettled', () => {
  it('is settled once a source is known, or the clip is known to be unreadable', () => {
    expect(clipTimestampSettled({ tsSource: 'mp4-meta' })).toBe(true)
    expect(clipTimestampSettled({ error: 'boom' })).toBe(true)
    expect(clipTimestampSettled({ undecodable: true })).toBe(true)
  })
  it('is not settled while extraction is still in flight', () => {
    expect(clipTimestampSettled({})).toBe(false)
    expect(clipTimestampSettled({ tsSource: null })).toBe(false)
  })
})

describe('resolveStartUtc', () => {
  it('trusts Apple metadata outright and does not re-base it by the venue', () => {
    const r = resolveStartUtc(
      { utc: nameStart, source: 'apple-meta', appleOffsetMin: 120, appleLocal: '2026-09-11 11:34:42' },
      TZ, null, 56,
    )
    expect(r.utc).toBe(nameStart)
    expect(r.localClock).toBe(false)       // already true UTC — must not shift again
    expect(r.how).toContain('UTC+02:00')
  })

  it('formats a negative Apple offset correctly', () => {
    const r = resolveStartUtc(
      { utc: nameStart, source: 'apple-meta', appleOffsetMin: -330, appleLocal: 'x' },
      TZ, null, 0,
    )
    expect(r.how).toContain('UTC-05:30')
  })

  it('treats a filename or mtime as local wall-clock', () => {
    const r = resolveStartUtc({ utc: nameUtc, source: 'filename' }, TZ, null, 0)
    expect(r.utc).toBe(nameStart)
    expect(r.localClock).toBe(true)
  })

  it('leaves a UTC venue alone', () => {
    const r = resolveStartUtc({ utc: nameUtc, source: 'mp4-meta' }, 0, null, 0)
    expect(r.utc).toBe(nameUtc)
    expect(r.localClock).toBe(true)
  })

  describe('calibrating mvhd against the filename', () => {
    it('recognises an mvhd that is local wall-clock', () => {
      const r = resolveStartUtc({ utc: nameUtc, source: 'mp4-meta', nameUtc }, TZ, null, 56)
      expect(r.utc).toBe(nameStart)
      expect(r.localClock).toBe(true)
      expect(r.how).toContain('mvhd is local')
    })

    it('recognises an mvhd that is already true UTC', () => {
      const r = resolveStartUtc({ utc: nameStart, source: 'mp4-meta', nameUtc }, TZ, null, 56)
      expect(r.utc).toBe(nameStart)
      expect(r.localClock).toBe(false)
      expect(r.how).toContain('mvhd is UTC')
    })

    it('REGRESSION: an mvhd stamped at file close is not the start time', () => {
      // The camera names the file when it opens it and stamps mvhd when it
      // closes it. Taking mvhd put a 56 s clip 56 s late — the overlay ran
      // ahead and the boat marker sat past the end of the clip.
      const r = resolveStartUtc(
        { utc: nameUtc + 56000, source: 'mp4-meta', nameUtc }, TZ, null, 56,
      )
      expect(r.utc).toBe(nameStart)          // the filename start wins
      expect(r.how).toContain('56s later')   // and says so, rather than silently
      expect(r.how).toContain('56s clip')
    })

    it('allows 5 s of genuine clock jitter before calling it a finalisation stamp', () => {
      const jitter = resolveStartUtc({ utc: nameUtc + 4000, source: 'mp4-meta', nameUtc }, TZ, null, 30)
      expect(jitter.how).toContain('mvhd is local')
      const late = resolveStartUtc({ utc: nameUtc + 6000, source: 'mp4-meta', nameUtc }, TZ, null, 30)
      expect(late.how).toContain('filename start used')
    })
  })

  describe('falling back to the log window when there is no filename stamp', () => {
    const startUtc = nameStart - 3600000
    const endUtc = nameStart + 3600000

    it('picks the reading that lands inside the day that was actually sailed', () => {
      // mvhd holds true UTC: reading it as local would put the clip 2 h early.
      const r = resolveStartUtc({ utc: nameStart, source: 'mp4-meta' }, TZ, { startUtc, endUtc }, 0)
      expect(r.utc).toBe(nameStart)
      expect(r.localClock).toBe(false)
      expect(r.how).toContain('fits log window')
    })

    it('picks the local reading when that is the one that fits', () => {
      const r = resolveStartUtc({ utc: nameUtc, source: 'mp4-meta' }, TZ,
        { startUtc: nameStart - 60000, endUtc: nameStart + 60000 }, 0)
      expect(r.utc).toBe(nameStart)
      expect(r.localClock).toBe(true)
    })
  })

  it('flags a re-encoded iPhone clip as suspect instead of trusting the edit time', () => {
    // An untouched iPhone clip always carries Keys:CreationDate. If it is gone
    // the file was re-encoded (QuickTime rotate-and-save does this) and mvhd
    // now holds the EDIT time — a wrong start that only shows up later as a
    // drifting overlay.
    const r = resolveStartUtc({ utc: nameStart, source: 'mp4-meta', appleLikely: true }, TZ, null, 0)
    expect(r.suspect).toBe(true)
    expect(r.how).toContain('re-encoded')
  })

  it('falls back to the spec reading, and says it is unverified', () => {
    const r = resolveStartUtc({ utc: nameStart, source: 'mp4-meta' }, TZ, null, 0)
    expect(r.utc).toBe(nameStart)
    expect(r.localClock).toBe(false)
    expect(r.suspect).toBeUndefined()
    expect(r.how).toContain('verify')
  })
})
