import React from 'react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'

// The clip's cloud row is the only store that can bring it back, so every test
// here is really asking one question: did the row actually go?
const deleteVideosCloud = vi.fn()
const deleteVideo = vi.fn()
const deleteStreamVideo = vi.fn()

vi.mock('../../lib/cloud-videos', async () => {
  const actual = await vi.importActual<typeof import('../../lib/cloud-videos')>('../../lib/cloud-videos')
  return { ...actual, deleteVideosCloud: (...a: unknown[]) => deleteVideosCloud(...a) }
})
vi.mock('../../lib/localStore', () => ({ deleteVideo: (...a: unknown[]) => deleteVideo(...a) }))
vi.mock('../../lib/bunny', () => ({ deleteStreamVideo: (...a: unknown[]) => deleteStreamVideo(...a) }))
vi.mock('../../lib/supabase/browser', () => ({
  getBrowserSupabase: () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }) } }),
}))

import { DeleteButton } from '../video/DeleteButton'

const UUID = '11111111-2222-3333-4444-555555555555'
const cloudUp = { available: true }

beforeEach(() => {
  deleteVideosCloud.mockReset().mockResolvedValue({ deleted: 1, videos: [], error: null })
  deleteVideo.mockReset().mockResolvedValue(undefined)
  deleteStreamVideo.mockReset().mockResolvedValue(true)
})

const click = (label: string | RegExp) => fireEvent.click(screen.getByText(label))

const arm = async (video: Record<string, unknown>, onDeleted = vi.fn()) => {
  render(<DeleteButton video={video} cloudStatus={cloudUp} onDeleted={onDeleted} />)
  click(/Delete clip/)
  return { onDeleted }
}

describe('DeleteButton — which stores it actually reaches', () => {
  it('offers the cloud delete for a clip that is in Bunny STORAGE, not Stream', async () => {
    // The 29 September clips: uploaded by the watcher to Bunny Storage, so no
    // streamId. The old gate was `!!video.streamId`, so the only button on offer
    // deleted the local copy and left the row — and the clip came back.
    await arm({
      id: 'v_1779206586594_abc', title: 'gate', source: 'local', cloudId: UUID, streamId: null,
    })
    click('Delete everywhere')
    await waitFor(() => expect(deleteVideosCloud).toHaveBeenCalledTimes(1))
    expect(deleteVideosCloud.mock.calls[0][0]).toMatchObject({ userId: 'u1', id: UUID })
  })

  it('deletes something at all for a cloud-only clip', async () => {
    // source 'supabase' meant isLocal false, which hid the cloud button AND
    // skipped the local delete: pressing Confirm ran zero store operations and
    // the card came back on the next sync.
    const { onDeleted } = await arm({ id: UUID, title: 'top mark', source: 'supabase' })
    click('Delete everywhere')
    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith(UUID))
    expect(deleteVideosCloud.mock.calls[0][0]).toMatchObject({ id: UUID })
  })

  it('names the row by its IDB key when the merge has not stamped a UUID', async () => {
    // `v.cloudId || v.id` used to send the IDB key as `id`, which is a UUID
    // column: the query errored and the 500 came back as a silent no-op.
    await arm({ id: 'v_1779206586594_abc', title: 'gate', source: 'local' })
    click('Delete everywhere')
    await waitFor(() => expect(deleteVideosCloud).toHaveBeenCalled())
    expect(deleteVideosCloud.mock.calls[0][0]).toMatchObject({
      id: null, externalId: 'v_1779206586594_abc',
    })
  })

  it('deletes the cloud row BEFORE the local copy', async () => {
    const order: string[] = []
    deleteVideosCloud.mockImplementation(async () => { order.push('cloud'); return { deleted: 1, videos: [], error: null } })
    deleteVideo.mockImplementation(async () => { order.push('local') })
    await arm({ id: UUID, title: 'gate', source: 'supabase' })
    click('Delete everywhere')
    await waitFor(() => expect(order).toEqual(['cloud', 'local']))
  })
})

describe('DeleteButton — refusing to lie', () => {
  it('keeps the clip when the cloud row refuses to go', async () => {
    // Deleting locally over a surviving row is the resurrection: gone here,
    // still in the cloud, merged back on the next sync as a cloud-only clip
    // that can no longer be deleted properly.
    deleteVideosCloud.mockResolvedValue({ deleted: 0, videos: [], error: 'new row violates row-level security' })
    const { onDeleted } = await arm({ id: UUID, title: 'gate', source: 'supabase' })
    click('Delete everywhere')
    await waitFor(() => expect(screen.getByText(/Cloud delete failed/)).toBeTruthy())
    expect(deleteVideo).not.toHaveBeenCalled()
    expect(onDeleted).not.toHaveBeenCalled()
  })

  it('treats "there was no row" as success, not as a failure', async () => {
    deleteVideosCloud.mockResolvedValue({ deleted: 0, videos: [], error: null })
    const { onDeleted } = await arm({ id: 'v_1', title: 'never uploaded', source: 'local' })
    click('Delete everywhere')
    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith('v_1'))
  })

  it('purges a Stream video whose row has already gone', async () => {
    deleteVideosCloud.mockResolvedValue({ deleted: 0, videos: [], error: null })
    await arm({ id: 'v_1', title: 'orphan', source: 'local', streamId: 'guid-1' })
    click('Delete everywhere')
    await waitFor(() => expect(deleteStreamVideo).toHaveBeenCalledWith('guid-1'))
  })

  it('says so when the cloud is unavailable rather than implying a full delete', async () => {
    render(<DeleteButton video={{ id: 'v_1', title: 'gate', source: 'local' }} cloudStatus={{ available: false }} onDeleted={() => {}} />)
    click(/Delete clip/)
    expect(screen.queryByText('Delete everywhere')).toBeNull()
    expect(screen.getByText(/come back on the next sync/)).toBeTruthy()
  })
})
