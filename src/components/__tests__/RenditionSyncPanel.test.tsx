import React from 'react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'

// The per-clip "Sync proxy" button. It used to inline Flow A itself — auth, the
// cloud row (with its own copy of the UUID test that lives next to
// ensureCloudVideoId), the blob — and was the only one of the four copies that
// never recorded the upload on this device. It now calls uploadClipProxy.
//
// This file exists because tsc does not check .jsx here (allowJs without
// checkJs), so nothing but a render catches a mis-wired prop.

const uploadClipProxy = vi.fn()
vi.mock('../../lib/uploadFlows', () => ({
  uploadClipProxy: (...a: unknown[]) => uploadClipProxy(...a),
}))

import { RenditionSyncPanel } from '../sync/RenditionSyncPanel'

const clip = { id: 'v_1779206586594_x', name: 'start.mp4', sessionDate: '2026-09-11', hasProxy: false }

beforeEach(() => {
  uploadClipProxy.mockReset().mockResolvedValue({
    ok: true, cloudId: 'cloud-uuid', proxyStreamId: 'guid-1', proxyBytes: 42,
  })
})

describe('RenditionSyncPanel', () => {
  it('hands the clip to Flow A and reports both ids back to the library', async () => {
    const onSynced = vi.fn()
    render(<RenditionSyncPanel video={clip} activeDate="2026-09-11" onSynced={onSynced} />)

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Sync proxy/ })) })

    await waitFor(() => expect(uploadClipProxy).toHaveBeenCalledWith(expect.objectContaining({
      video: clip,
      sessionDate: '2026-09-11',
    })))
    // BOTH ids: the UI may be looking the clip up by either.
    await waitFor(() => expect(onSynced).toHaveBeenCalledWith('v_1779206586594_x', {
      proxyStreamId: 'guid-1', proxyBytes: 42, cloudId: 'cloud-uuid',
    }))
  })

  it("files the clip under its own date, falling back to the day on screen", async () => {
    render(<RenditionSyncPanel video={{ ...clip, sessionDate: null }} activeDate="2026-09-11" onSynced={() => {}} />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Sync proxy/ })) })
    await waitFor(() => expect(uploadClipProxy).toHaveBeenCalledWith(
      expect.objectContaining({ sessionDate: '2026-09-11' })
    ))
  })

  it('shows the reason a failure failed, and tells the library nothing', async () => {
    const onSynced = vi.fn()
    uploadClipProxy.mockResolvedValue({ ok: false, error: 'no video data on this device — re-import the clip' })
    render(<RenditionSyncPanel video={clip} activeDate="2026-09-11" onSynced={onSynced} />)

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Sync proxy/ })) })

    expect(await screen.findByText(/no video data on this device/)).toBeTruthy()
    expect(onSynced).not.toHaveBeenCalled()
  })

  it('still marks the clip synced when only the adaptive encode was missed', async () => {
    // Playable off Storage as a progressive MP4; the ladder is Bunny's problem.
    const onSynced = vi.fn()
    uploadClipProxy.mockResolvedValue({ ok: true, cloudId: 'cloud-uuid', streamError: 'queue full' })
    render(<RenditionSyncPanel video={clip} activeDate="2026-09-11" onSynced={onSynced} />)

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Sync proxy/ })) })

    expect(await screen.findByText(/adaptive encode was not queued/)).toBeTruthy()
    await waitFor(() => expect(onSynced).toHaveBeenCalled())
  })

  it('offers nothing at all once the clip has a proxy', () => {
    render(<RenditionSyncPanel video={{ ...clip, hasProxy: true }} activeDate="2026-09-11" onSynced={() => {}} />)
    expect(screen.queryByRole('button', { name: /Sync proxy/ })).toBeNull()
    expect(screen.getByText(/Proxy ready/)).toBeTruthy()
  })
})
