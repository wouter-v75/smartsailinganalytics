import { describe, it, expect } from 'vitest'
// The cutter runs under plain node, not vite, so its helpers are .mjs.
import { joinAcrossFiles, joinSummary, concatArgs, listFileBody } from '../../../scripts/lib/joinSegments.mjs'

// The cutter's wall-clock strings: local time with no zone, as the card writes it.
const wall = (h: number, m: number, s: number) =>
  `2026-10-02T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.000`

interface Job {
  name: string; src: string; ssSec: number; durSec: number
  tags: string[]; kinds: string[]; labels: string[]; startWall: string | null
  parts?: { src: string; ssSec: number; durSec: number }[]
  spanSec?: number
}
const job = (over: Partial<Job> & { startWall: string | null; durSec: number; src: string }): Job => ({
  name: 'x', ssSec: 0, tags: ['race-start'], kinds: ['start'], labels: ['Race 1 start'], ...over,
})

describe('joinAcrossFiles', () => {
  it('joins the two halves of a start split across a file boundary', () => {
    // 2 October: 12:03:30 +118s ends 12:05:28, the next file picks up 12:05:31.
    const out = joinAcrossFiles([
      job({ name: 'a', src: 'DJI_0001.MP4', startWall: wall(12, 3, 30), durSec: 118 }),
      job({ name: 'b', src: 'DJI_0002.MP4', startWall: wall(12, 5, 31), durSec: 28, ssSec: 0 }),
    ])
    expect(out).toHaveLength(1)
    expect(out[0].name).toBe('a')                 // the first piece names the clip
    expect(out[0].durSec).toBe(146)               // what is encoded: the seam is gone
    expect(out[0].spanSec).toBe(149)              // what it spans on the water
    expect(out[0].parts).toEqual([
      { src: 'DJI_0001.MP4', ssSec: 0, durSec: 118 },
      { src: 'DJI_0002.MP4', ssSec: 0, durSec: 28 },
    ])
  })

  it('joins three pieces, including the one-second tail of a file', () => {
    const out = joinAcrossFiles([
      job({ src: 'a.MP4', startWall: wall(14, 15, 28), durSec: 28, tags: ['gate'], kinds: ['gate'] }),
      job({ src: 'b.MP4', startWall: wall(14, 16, 4), durSec: 25, tags: ['gate'], kinds: ['gate'] }),
      job({ src: 'c.MP4', startWall: wall(14, 16, 31), durSec: 1, tags: ['gate'], kinds: ['gate'] }),
    ])
    expect(out).toHaveLength(1)
    expect(out[0].parts).toHaveLength(3)
    expect(out[0].durSec).toBe(54)
  })

  it('keeps two moments apart when the gap is a real one', () => {
    // Two roundings four minutes apart are not one clip, however many files.
    const out = joinAcrossFiles([
      job({ src: 'a.MP4', startWall: wall(12, 15, 0), durSec: 90, tags: ['topmark'], kinds: ['topmark'] }),
      job({ src: 'b.MP4', startWall: wall(12, 19, 0), durSec: 90, tags: ['topmark'], kinds: ['topmark'] }),
    ])
    expect(out).toHaveLength(2)
    expect(out.every((j) => !j.parts)).toBe(true)
  })

  it('never joins a start to the rounding that follows it', () => {
    // Contiguous and from different files, but different moments.
    const out = joinAcrossFiles([
      job({ src: 'a.MP4', startWall: wall(12, 3, 30), durSec: 118, tags: ['race-start'], kinds: ['start'] }),
      job({ src: 'b.MP4', startWall: wall(12, 5, 31), durSec: 90, tags: ['topmark'], kinds: ['topmark'] }),
    ])
    expect(out).toHaveLength(2)
  })

  it('never joins two windows that came from the SAME file', () => {
    // One file holding two gybes a few seconds apart is two clips, not one — the
    // cutter already merged what should be merged, inside the file.
    const out = joinAcrossFiles([
      job({ src: 'a.MP4', startWall: wall(13, 0, 0), durSec: 30, tags: ['gybe'], kinds: ['gybe'] }),
      job({ src: 'a.MP4', startWall: wall(13, 0, 32), durSec: 30, tags: ['gybe'], kinds: ['gybe'] }),
    ])
    expect(out).toHaveLength(2)
  })

  it('leaves whole-clip and untimed jobs alone', () => {
    const whole = job({ name: 'whole', src: 'a.MP4', startWall: wall(12, 0, 0), durSec: 0 })
    const untimed = job({ name: 'untimed', src: 'b.MP4', startWall: null, durSec: 30 })
    const out = joinAcrossFiles([whole, untimed])
    expect(out).toEqual([whole, untimed])
  })

  it('honours a tighter seam', () => {
    const pieces = [
      job({ src: 'a.MP4', startWall: wall(12, 3, 30), durSec: 118 }),
      job({ src: 'b.MP4', startWall: wall(12, 5, 31), durSec: 28 }),
    ]
    expect(joinAcrossFiles(pieces, 1_000)).toHaveLength(2)
    expect(joinAcrossFiles(pieces, 15_000)).toHaveLength(1)
  })

  it('tolerates a piece starting a shade before the last one ended', () => {
    const out = joinAcrossFiles([
      job({ src: 'a.MP4', startWall: wall(12, 3, 30), durSec: 120 }),
      job({ src: 'b.MP4', startWall: wall(12, 5, 29), durSec: 28 }),   // −1 s
    ])
    expect(out).toHaveLength(1)
  })

  it('counts what it saved', () => {
    const before = [
      job({ src: 'a.MP4', startWall: wall(12, 3, 30), durSec: 118 }),
      job({ src: 'b.MP4', startWall: wall(12, 5, 31), durSec: 28 }),
      job({ src: 'c.MP4', startWall: wall(13, 0, 0), durSec: 90, tags: ['gate'], kinds: ['gate'] }),
    ]
    const after = joinAcrossFiles(before)
    expect(joinSummary(before, after)).toEqual({ joins: 1, pieces: 2, saved: 1 })
  })
})

describe('the concat itself', () => {
  it('writes one line per piece, in order, newline-terminated', () => {
    expect(listFileBody(['/tmp/a__p1.mp4', '/tmp/a__p2.mp4']))
      .toBe("file '/tmp/a__p1.mp4'\nfile '/tmp/a__p2.mp4'\n")
  })

  it("survives an apostrophe in the path", () => {
    // A card called "Wouter's SSD" is not exotic, and ffmpeg's demuxer takes the
    // quoting literally: close, escape, reopen.
    expect(listFileBody(["/Volumes/Wouter's SSD/a.mp4"]))
      .toBe("file '/Volumes/Wouter'\\''s SSD/a.mp4'\n")
  })

  it('copies rather than re-encodes, and takes absolute paths', () => {
    const a = concatArgs('/tmp/list.txt', '/out/clip.mp4')
    expect(a).toContain('-c')
    expect(a[a.indexOf('-c') + 1]).toBe('copy')
    expect(a[a.indexOf('-safe') + 1]).toBe('0')
    expect(a[a.indexOf('-i') + 1]).toBe('/tmp/list.txt')
    expect(a[a.length - 1]).toBe('/out/clip.mp4')
    expect(a).toContain('-y')
  })
})
