// A transcript that stops is not the same thing as a BOX that stops, and telling
// them apart has now cost three rounds of this bug.
//
//   bd975f6  "The debrief summary was never short — the box was"
//   c0cc5b1  "Debrief notes are as tall as what is in them"
//   a0f2698  "A debrief summary that ran out of room now says so"
//   3a2ed63  "ask for the rest instead of raising the ceiling"
//
// Each of those closed one route to a short note. The one left open was the
// quietest: transcribeChunks joined an EMPTY chunk in without a word, so a
// recording whose last five minutes transcribed to '' produced a transcript that
// ended mid-sentence at a part boundary, with nothing anywhere saying so. The
// summariser then faithfully summarised the stretch it was given.
//
// What is pinned here: an empty part is COUNTED and NAMED, with where it sits in
// the recording, and a clean run says nothing at all.

import { describe, it, expect, vi, afterEach } from 'vitest'
// @ts-expect-error — debriefAudio is plain JS, no declaration file
import { transcribeChunks, describeSilentParts, CHUNK_SECONDS } from '../debriefAudio'

const ok = (text: string) => ({ ok: true, status: 200, json: async () => ({ text }) })
const chunks = (n: number) => Array.from({ length: n }, () => new Blob(['audio'], { type: 'audio/mpeg' }))

afterEach(() => { vi.unstubAllGlobals() })

describe('transcribeChunks', () => {
  it('joins the parts in order and reports no gap', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(ok('first'))
      .mockResolvedValueOnce(ok('second'))
      .mockResolvedValueOnce(ok('third')))

    const out = await transcribeChunks(chunks(3))
    expect(out.text).toBe('first\nsecond\nthird')
    expect(out.parts).toBe(3)
    expect(out.silent).toEqual([])
  })

  it('notices the part that came back with no words', async () => {
    // The one that matters: the LAST part is empty, so the text ends where the
    // part before it ended and the recording appears to stop early.
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(ok('we were slow out of the tack'))
      .mockResolvedValueOnce(ok('   ')))

    const out = await transcribeChunks(chunks(2))
    expect(out.silent).toEqual([1])
    expect(out.parts).toBe(2)
  })

  it('notices one in the middle, which leaves a hole rather than a short end', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(ok('a'))
      .mockResolvedValueOnce(ok(''))
      .mockResolvedValueOnce(ok('c')))

    expect((await transcribeChunks(chunks(3))).silent).toEqual([1])
  })

  it('reports progress once per part', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok('x')))
    const seen: number[] = []
    await transcribeChunks(chunks(4), (p: number) => seen.push(p))
    expect(seen).toEqual([0.25, 0.5, 0.75, 1])
  })
})

describe('describeSilentParts', () => {
  it('says nothing when every part produced words', () => {
    expect(describeSilentParts([], 12, 3600)).toBeNull()
    expect(describeSilentParts(undefined, 12, 3600)).toBeNull()
  })

  it('names the part and where it is in the recording', () => {
    // Part 8 of 12 → 35:00 to 40:00 at the 300 s chunk length.
    const msg = describeSilentParts([7], 12, 3600)
    expect(msg).toContain('Part 8 of 12')
    expect(msg).toContain('35:00–40:00')
    expect(msg).toMatch(/gap there/)
  })

  it('clamps the LAST part to the real duration', () => {
    // 61 minutes is 13 parts, the last of which is one minute long. Printing it
    // as 60:00–65:00 sends someone looking in the recording for audio that was
    // never there.
    const msg = describeSilentParts([12], 13, 61 * 60)
    expect(msg).toContain('60:00–61:00')
  })

  it('counts them when there is more than one', () => {
    const msg = describeSilentParts([0, 5], 12, 3600)
    expect(msg).toContain('2 of 12 parts')
    expect(msg).toContain('0:00–5:00')
    expect(msg).toContain('25:00–30:00')
  })

  it('uses the same chunk length the chunker does', () => {
    // The report turns a part index back into a time. If it ever used a
    // different number from compressToMp3Chunks, every span it printed would
    // point at the wrong minute of the recording and look like a clock bug.
    expect(CHUNK_SECONDS).toBe(300)
    expect(describeSilentParts([1], 2, undefined)).toContain('5:00–10:00')
  })
})
