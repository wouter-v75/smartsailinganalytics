import { describe, it, expect } from 'vitest'
import { isDroneClip } from '../DayTimeline'

// Mirror of isDroneSource in scripts/select-race-clips.mjs — the pipeline stamps
// "drone" into the output NAME, and isDroneClip reads it back after import. The two
// must agree or footage lands in the wrong timeline column.
const DRONE_RE = /(?:^|[^a-z0-9])(dji|drone|mavic|osmo|avata|inspire)(?:[^a-z0-9]|$)/i
const isDroneSource = (file: string, folder: string) => DRONE_RE.test(file) || DRONE_RE.test(folder)
const nameFor = (stamp: string, tags: string, tag: string, file: string, folder: string) =>
  [stamp, tags, tag, isDroneSource(file, folder) ? 'drone' : folder.replace(/[^A-Za-z0-9]+/g, '-')].join('_')

describe('drone footage survives a card whose folders are named anything', () => {
  it('pins the regression: the folder alone was not enough', () => {
    // Wednesday the drone folder was "DJI_001"; Friday it was "Day 4". Naming the
    // segment after the folder gave …_day4_Day-4, which says nothing about what
    // shot it, and the whole day filed into the Videos column.
    const oldName = '20260905132409_tack_day4_Day-4'
    expect(isDroneClip({ title: oldName })).toBe(false)      // the bug
  })

  it('reads the ORIGINAL filename, so any folder name works', () => {
    for (const folder of ['DJI_001', 'Day 4', 'Card A', '20260905']) {
      const n = nameFor('20260905132409', 'tack', 'day4', 'DJI_20260905132409_0102_D.MP4', folder)
      expect(n.endsWith('_drone')).toBe(true)
      expect(isDroneClip({ title: n })).toBe(true)
      // …and after import, where underscores and hyphens become spaces
      expect(isDroneClip({ title: n.replace(/[_-]/g, ' ') })).toBe(true)
    }
  })

  it('still falls back to the folder when the file itself is unnamed', () => {
    const n = nameFor('20260905132409', 'tack', 'day4', 'C0001.MP4', 'DJI_001')
    expect(n.endsWith('_drone')).toBe(true)
  })

  it('leaves RIB and onboard footage alone', () => {
    const n = nameFor('20260905132409', 'tack', 'day4', '20260905_132409.mp4', 'Camera')
    expect(n.endsWith('_Camera')).toBe(true)
    expect(isDroneClip({ title: n })).toBe(false)
  })

  it('covers the other airframes, in the shapes they actually appear', () => {
    // DJI cameras prefix the file itself (DJI_…); the airframe words matter mainly
    // for a folder someone names by hand. A word run straight into a digit —
    // "inspire3" — deliberately does NOT match, because loosening the boundary that
    // far would start catching ordinary words.
    for (const f of ['DJI_20260905_0001.MP4', 'MAVIC_0001.MP4', 'osmo-0002.mp4', 'AVATA_12.MP4'])
      expect(isDroneSource(f, 'Day 4')).toBe(true)
    for (const folder of ['Inspire 3', 'Mavic footage', 'drone'])
      expect(isDroneSource('C0001.MP4', folder)).toBe(true)
    expect(isDroneSource('inspire3_a.mov', 'Day 4')).toBe(false)
  })
})
