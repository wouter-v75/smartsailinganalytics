import { describe, it, expect } from 'vitest'
import { titleKey, planOutbox } from '../clipOutbox'

describe('titleKey', () => {
  it('reduces a filename and its stored title to the same thing', () => {
    // The importer drops the extension and lets the punctuation go.
    expect(titleKey('DJI_20260927121745_0001_D.MP4')).toBe(titleKey('DJI 20260927121745 0001 D'))
    expect(titleKey('20260928140330_race-start_20260928_drone.mp4'))
      .toBe('20260928140330 race start 20260928 drone')
  })

  it('keeps two different clips apart', () => {
    expect(titleKey('20260928140330_gate_20260928_drone.mp4'))
      .not.toBe(titleKey('20260928143736_gate_20260928_drone.mp4'))
  })
})

describe('planOutbox', () => {
  const CLOUD = [
    { title: '20260928140330 race-start 20260928 drone', stored: true },
    { title: '20260928142259 topmark 20260928 drone', stored: true },
  ]

  it('clears what the cloud already holds', () => {
    const p = planOutbox(
      ['20260928140330_race-start_20260928_drone.mp4', '20260928145031_photo_20260928_drone.mp4'],
      CLOUD
    )
    expect(p.uploaded).toEqual(['20260928140330_race-start_20260928_drone.mp4'])
    expect(p.pending).toEqual(['20260928145031_photo_20260928_drone.mp4'])
  })

  it('keeps a clip whose row has nothing behind it', () => {
    // A video row with no object in storage is not an upload, and deleting
    // against one throws away the only copy there is.
    const p = planOutbox(['20260928140330_race-start_20260928_drone.mp4'],
      [{ title: '20260928140330 race-start 20260928 drone', stored: false }])
    expect(p.uploaded).toEqual([])
    expect(p.pending).toHaveLength(1)
  })

  it('never touches anything that is not a clip', () => {
    const p = planOutbox(['manifest.json', '.DS_Store', '.20260928150127_photo.part.mp4'], CLOUD)
    expect(p).toEqual({ uploaded: [], pending: [] })
  })

  it('leaves everything when the cloud is empty', () => {
    const p = planOutbox(['a_20260928_drone.mp4', 'b_20260928_drone.mp4'], [])
    expect(p.uploaded).toEqual([])
    expect(p.pending).toHaveLength(2)
  })
})
