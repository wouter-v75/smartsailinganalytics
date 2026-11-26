import { describe, it, expect, vi, beforeEach } from 'vitest'

// Flow A's single entry point. It replaced four near-copies of the same
// sequence, and the behaviour worth pinning down is the part they disagreed on:
// the ORDER of the checks, and the local mark that only one of the four wrote.

const getVideoBlob = vi.fn()
const markVideoProxyUploaded = vi.fn(async () => true)
const ensureCloudVideoId = vi.fn(async () => 'cloud-uuid')
const syncProxyForVideo = vi.fn(async () => ({
  ok: true, proxyPath: 'teams/t/boats/b/sessions/2026-09-11/proxies/cloud-uuid.mp4',
  proxyStreamId: 'guid-1', proxyBytes: 123,
}))
let user: { id: string } | null = { id: 'u1' }

vi.mock('../localStore', () => ({
  getVideoBlob: (...a: unknown[]) => getVideoBlob(...a),
  markVideoProxyUploaded: (...a: unknown[]) => markVideoProxyUploaded(...a),
}))
vi.mock('../cloud-videos', () => ({
  ensureCloudVideoId: (...a: unknown[]) => ensureCloudVideoId(...a),
}))
vi.mock('../storageScope', () => ({
  currentStorageScope: async () => ({ teamId: 't', boatId: 'b' }),
}))
vi.mock('../supabase/browser', () => ({
  getBrowserSupabase: () => ({ auth: { getUser: async () => ({ data: { user } }) } }),
}))
vi.mock('../video-rendition-sync', () => ({
  syncProxyForVideo: (...a: unknown[]) => syncProxyForVideo(...a),
}))

import { uploadClipProxy } from '../uploadFlows'

const clip = { id: 'v_1779206586594_x', name: 'start.mp4', sessionDate: '2026-09-11' }

beforeEach(() => {
  vi.clearAllMocks()
  user = { id: 'u1' }
  getVideoBlob.mockResolvedValue(new Blob(['bytes']))
  ensureCloudVideoId.mockResolvedValue('cloud-uuid')
  syncProxyForVideo.mockResolvedValue({
    ok: true, proxyPath: 'p/cloud-uuid.mp4', proxyStreamId: 'guid-1', proxyBytes: 123,
  })
})

describe('uploadClipProxy', () => {
  it('records the upload on THIS device, which three of the four callers never did', async () => {
    const res = await uploadClipProxy({ video: clip, sessionDate: '2026-09-11' })

    expect(res.ok).toBe(true)
    expect(res.cloudId).toBe('cloud-uuid')
    // The local mark is what alreadyInCloud() reads. Without it the next Push
    // to Cloud believes the clip was never sent — and `cloudId` is what links
    // the IDB key to the Supabase row the timeline and the debrief reel use.
    expect(markVideoProxyUploaded).toHaveBeenCalledWith(clip.id, {
      cloudId: 'cloud-uuid',
      proxyPath: 'p/cloud-uuid.mp4',
      proxyStreamId: 'guid-1',
    })
  })

  it('checks the blob BEFORE creating a cloud row', async () => {
    // A clip with no bytes on this device cannot be uploaded from here whatever
    // we do, so creating its row only puts an unplayable entry in everyone's
    // library. One of the four copies did it in this order; another did not.
    getVideoBlob.mockResolvedValue(null)
    const res = await uploadClipProxy({ video: clip, sessionDate: '2026-09-11' })

    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/no video data on this device/)
    expect(ensureCloudVideoId).not.toHaveBeenCalled()
    expect(syncProxyForVideo).not.toHaveBeenCalled()
  })

  it('says plainly what is wrong rather than failing silently', async () => {
    user = null
    expect((await uploadClipProxy({ video: clip, sessionDate: '2026-09-11' })).error)
      .toMatch(/not signed in/)

    user = { id: 'u1' }
    ensureCloudVideoId.mockResolvedValue(null as unknown as string)
    expect((await uploadClipProxy({ video: clip, sessionDate: '2026-09-11' })).error)
      .toMatch(/no active boat workspace/)

    ensureCloudVideoId.mockResolvedValue('cloud-uuid')
    syncProxyForVideo.mockResolvedValue({ ok: false, error: 'Storage PUT 401' })
    const res = await uploadClipProxy({ video: clip, sessionDate: '2026-09-11' })
    expect(res.ok).toBe(false)
    expect(res.error).toBe('Storage PUT 401')
    // A failed upload must not leave a mark saying the clip is up.
    expect(markVideoProxyUploaded).not.toHaveBeenCalled()
  })

  it('an unqueued adaptive encode is a SUCCESS with a warning, not a failure', async () => {
    // The bytes are in Storage and the clip plays as a progressive MP4. Calling
    // this a failure sends the user re-uploading footage the team can watch.
    syncProxyForVideo.mockResolvedValue({
      ok: true, proxyPath: 'p/cloud-uuid.mp4', proxyStreamId: undefined,
      streamError: 'queue full',
    })
    const res = await uploadClipProxy({ video: clip, sessionDate: '2026-09-11' })
    expect(res.ok).toBe(true)
    expect(res.streamError).toBe('queue full')
    expect(markVideoProxyUploaded).toHaveBeenCalled()
  })

  it("passes registerAs through — only the caller knows if the file is already a review copy", async () => {
    await uploadClipProxy({ video: clip, sessionDate: '2026-09-11', registerAs: 'proxy' })
    expect(syncProxyForVideo).toHaveBeenCalledWith(expect.objectContaining({
      videoId: 'cloud-uuid', registerAs: 'proxy',
    }))

    // Default: the uploader decides from whether a transcode happened.
    await uploadClipProxy({ video: clip, sessionDate: '2026-09-11' })
    expect(syncProxyForVideo).toHaveBeenLastCalledWith(expect.objectContaining({ registerAs: 'auto' }))
  })

  it("files the clip under its OWN date, not the batch's", async () => {
    // A clip imported on the 19th must not be filed under the 20th because
    // that is the day on screen. Both queues carry per-clip dates for this.
    await uploadClipProxy({ video: { ...clip, sessionDate: '2026-05-19' }, sessionDate: '2026-05-20' })
    expect(syncProxyForVideo).toHaveBeenCalledWith(expect.objectContaining({ sessionDate: '2026-05-19' }))
    expect(ensureCloudVideoId).toHaveBeenCalledWith(expect.objectContaining({ sessionDate: '2026-05-19' }))
  })
})
