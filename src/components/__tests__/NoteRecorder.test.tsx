import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'

// The recorder is the only place in the app that opens the microphone, and it
// gates on three things that are easy to break silently: the role, whether the
// browser can record at all, and whether a note already has text (which decides
// between "Save note" and "Add to note"). jsdom has no MediaRecorder and no
// getUserMedia, so both are stubbed — what is under test is the gating and the
// state machine, not the codec.

const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ sails: [], boats: [] }) }))

class FakeMediaRecorder {
  static isTypeSupported() { return true }
  ondataavailable: ((e: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null
  mimeType = 'audio/webm'
  state = 'inactive'
  constructor(_stream: unknown, _opts?: unknown) { /* */ }
  start() {
    this.state = 'recording'
    // One chunk, big enough to clear the "nothing was recorded" guard.
    setTimeout(() => this.ondataavailable?.({ data: new Blob([new Uint8Array(4096)]) }), 0)
  }
  stop() { this.state = 'inactive'; setTimeout(() => this.onstop?.(), 0) }
}

const track = { stop: vi.fn() }

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder)
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })) },
  })
})
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks() })

import NoteRecorder from '../NoteRecorder'

const props = {
  value: '', onCommit: vi.fn(async () => {}), canEdit: true,
  label: 'Plan', teamId: 't1', boatId: 'b1',
}

describe('NoteRecorder', () => {
  it('shows the record button to an editor', async () => {
    render(<NoteRecorder {...props} />)
    expect(await screen.findByText(/Record/)).toBeTruthy()
  })

  it('renders nothing for a read-only role', () => {
    const { container } = render(<NoteRecorder {...props} canEdit={false} />)
    expect(container.textContent).toBe('')
  })

  it('renders nothing when the browser cannot record', () => {
    vi.stubGlobal('MediaRecorder', undefined)
    const { container } = render(<NoteRecorder {...props} />)
    expect(container.textContent).toBe('')
  })

  it('opens the microphone and offers Stop once recording', async () => {
    render(<NoteRecorder {...props} />)
    fireEvent.click(await screen.findByText(/Record/))
    await waitFor(() => expect(screen.getByText(/Stop/)).toBeTruthy())
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalled()
    // Discarding must release the mic — a left-open track keeps the OS
    // recording indicator lit and the tab holding the device.
    fireEvent.click(screen.getByText('Discard'))
    await waitFor(() => expect(track.stop).toHaveBeenCalled())
  })

  it('reports a blocked microphone in words rather than failing silently', async () => {
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: vi.fn(async () => {
          const e = new Error('denied'); e.name = 'NotAllowedError'; throw e
        }),
      },
    })
    render(<NoteRecorder {...props} />)
    fireEvent.click(await screen.findByText(/Record/))
    expect(await screen.findByText(/microphone blocked/)).toBeTruthy()
  })
})
