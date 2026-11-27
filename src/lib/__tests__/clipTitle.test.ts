// The real titles on the live library, 27 Nov 2026. This comparison decides
// what gets deleted from the archive, so the cases are the actual strings.

import { describe, it, expect } from 'vitest'
import { normTitle, isUsableTitle, sameClip, titleIndex } from '../clipTitle'

describe('normTitle', () => {
  it('makes a clips:day upload and its row title the same string', () => {
    expect(normTitle('20260911135629_race-start_day9_drone.mp4'))
      .toBe(normTitle('20260911135629 race-start day9 drone'))
  })

  it('makes a 720p encode match its full-resolution twin', () => {
    expect(normTitle('DJI 20260527152016 0013 D_720p.mp4'))
      .toBe(normTitle('DJI 20260527152016 0013 D'))
  })

  it('handles a title with no extension at all', () => {
    expect(normTitle('20260929144330 race start 20260929 drone'))
      .toBe('20260929144330 race start 20260929 drone')
  })

  it('leaves a camera filename identifiable', () => {
    expect(normTitle('20260729_145610.mp4')).toBe('20260729 145610')
    expect(normTitle('DJI_20250905124907_0006_first_reach.MP4'))
      .toBe('dji 20250905124907 0006 first reach')
  })

  it('does NOT collapse two different clips of the same moment', () => {
    // 10 Sept: two cameras, one instant. These must stay distinct or one would
    // be reported as a spare encode of the other.
    expect(normTitle('20260910120331_race-start_day8_drone.mp4'))
      .not.toBe(normTitle('20260910120331_race-start_day8_Camera.mp4'))
  })

  it('strips 720p only as a SUFFIX, never mid-title', () => {
    expect(normTitle('clip_720p_final.mp4')).toBe('clip 720p final')
  })
})

describe('isUsableTitle — the guard against a false match', () => {
  it('refuses the titles that name a category, not a clip', () => {
    // Matching on one of these would call unique footage superseded, and
    // "superseded" is what gets deleted.
    for (const t of ['undefined', 'drone', 'race', 'camera', 'proxy', 'original', '']) {
      expect(isUsableTitle(t)).toBe(false)
    }
  })

  it('refuses anything shorter than a timestamp', () => {
    expect(isUsableTitle('a.mp4')).toBe(false)
    expect(isUsableTitle('IMG_1.mp4')).toBe(false)
  })

  it('accepts every real title on the library', () => {
    for (const t of [
      '20260911135629_race-start_day9_drone.mp4',
      'DJI 20260527152016 0013 D_720p.mp4',
      'DJI_20250903151003_0067_WWL_hoist.MP4',
      '20260729_145610.mp4',
      '8DC95A2A-A42F-4886-A27E-8C27E152E501.MP4',
      'A1.5 20260627_142909.mp4',
      'IMG 2894',
    ]) {
      expect(isUsableTitle(t)).toBe(true)
    }
  })
})

describe('sameClip', () => {
  const index = titleIndex([
    { title: '20260911135629 race-start day9 drone', playable: true },
    { title: 'DJI 20260527152016 0013 D', playable: true },
    { title: '20260519 unplayable one', playable: false },
    { title: 'undefined', playable: true },
  ])

  it('matches across the conventions', () => {
    expect(sameClip('20260911135629_race-start_day9_drone.mp4', index)).toBe(true)
    expect(sameClip('DJI 20260527152016 0013 D_720p.mp4', index)).toBe(true)
  })

  it('does not match a clip whose only row cannot be played', () => {
    // A row that plays nothing is not a copy of anything, so the unreferenced
    // object is still the only one.
    expect(sameClip('20260519 unplayable one.mp4', index)).toBe(false)
  })

  it('refuses to match an unusable title even when the index holds it', () => {
    // `undefined` is in BOTH, and matching them would delete 3.5 GB of
    // unidentified 1080p on the strength of a bug in a title field.
    expect(index.has('undefined')).toBe(false)
    expect(sameClip('undefined', index)).toBe(false)
  })

  it('does not match an unrelated clip', () => {
    expect(sameClip('20260729_145610.mp4', index)).toBe(false)
  })
})
