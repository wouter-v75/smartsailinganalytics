import { describe, it, expect } from 'vitest'
import { playerStage, clipUrlIsFresh, isMp4Url, STAGE_TEXT } from '../playerStage'

describe('playerStage', () => {
  const cloud = { hasOriginal: true }

  it('says "bear with us" while a cloud clip has no link yet', () => {
    expect(playerStage(cloud, 'loading')).toBe('finding')
    expect(playerStage({ streamProcessing: true }, 'loading')).toBe('finding')
  })
  it('says "loading" once there is a link and the browser is buffering', () => {
    expect(playerStage({ ...cloud, objectUrl: 'https://x/playlist.m3u8' }, 'loading')).toBe('loading')
  })
  it('goes back to "bear with us" during the quiet retry, not straight to an error', () => {
    expect(playerStage({ ...cloud, objectUrl: 'https://x/a.mp4' }, 'retrying')).toBe('finding')
  })
  it('apologises only once something has actually failed', () => {
    expect(playerStage({ ...cloud, objectUrl: 'https://x/a.mp4' }, 'error')).toBe('unavailable')
    expect(playerStage({ ...cloud, urlFailed: true }, 'loading')).toBe('unavailable')
    expect(playerStage({ ...cloud, streamFailed: true }, 'loading')).toBe('unavailable')
    expect(playerStage({ ...cloud, streamStalled: true }, 'loading')).toBe('unavailable')
  })
  it('apologises for a clip with no copy anywhere', () => {
    expect(playerStage({}, 'loading')).toBe('unavailable')
  })
  it('shows nothing once it plays', () => {
    expect(playerStage({ ...cloud, objectUrl: 'blob:x' }, 'ready')).toBe('ready')
  })
  it('uses the wording asked for', () => {
    expect(STAGE_TEXT.finding).toBe('Bear with us, working on getting the video')
    expect(STAGE_TEXT.loading).toBe('Video loading')
    expect(STAGE_TEXT.unavailable).toBe('Apologies, this video is not available at the moment')
  })
})

describe('clipUrlIsFresh', () => {
  const now = 1_000_000_000_000
  it('re-resolves a signed link within a minute of expiring', () => {
    expect(clipUrlIsFresh({ objectUrl: 'https://p/a.mp4?token=t', urlExpiresAt: now + 30_000 }, now)).toBe(false)
    expect(clipUrlIsFresh({ objectUrl: 'https://p/a.mp4?token=t', urlExpiresAt: now - 1 }, now)).toBe(false)
  })
  it('keeps a link that has time left, or never expires', () => {
    expect(clipUrlIsFresh({ objectUrl: 'https://p/a.mp4?token=t', urlExpiresAt: now + 30 * 60_000 }, now)).toBe(true)
    expect(clipUrlIsFresh({ objectUrl: 'https://cdn/g/playlist.m3u8', urlExpiresAt: null }, now)).toBe(true)
  })
  it('never counts a local blob or no link as resolved', () => {
    expect(clipUrlIsFresh({ objectUrl: 'blob:abc' }, now)).toBe(false)
    expect(clipUrlIsFresh({ objectUrl: null }, now)).toBe(false)
  })
})

describe('isMp4Url', () => {
  it('spots a signed Storage MP4 so it is never handed to hls.js', () => {
    expect(isMp4Url('https://pull.b-cdn.net/sessions/x/orig.mp4?token=HS256-abc&expires=1')).toBe(true)
    expect(isMp4Url('https://vz.b-cdn.net/guid/playlist.m3u8')).toBe(false)
    expect(isMp4Url(null)).toBe(false)
  })
})
