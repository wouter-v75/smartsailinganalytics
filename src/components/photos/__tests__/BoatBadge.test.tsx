// src/components/photos/__tests__/BoatBadge.test.tsx
// ─────────────────────────────────────────────────────────────────────────────
// Whose boat is in the photograph. It earns its place on a RIVAL: a folder of
// stern shots is mostly our own boat, and the Capricorno frames are the ones
// worth finding again.
// ─────────────────────────────────────────────────────────────────────────────

import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

const BOATS = [
  { id: 'b1', name: 'Northstar 76', sailNumber: 'GBR76X', teamName: 'Northstar', hasRigModel: true, isCompetitor: false },
  { id: 'b2', name: 'Capricorno', sailNumber: 'ITA30303', teamName: 'Northstar', hasRigModel: true, isCompetitor: true },
]
vi.mock('@/lib/rigModel', () => ({ fetchBoats: () => Promise.resolve(BOATS) }))

import BoatBadge from '../BoatBadge'

describe('BoatBadge', () => {
  it('shows nothing when the frame names no boat', () => {
    const { container } = render(<BoatBadge boatIds={null} />)
    expect(container.textContent).toBe('')
  })

  it('stays SILENT on our own boat, so the grid stays clean', async () => {
    // Nearly every frame is ours. Badging those would label the whole grid and
    // bury the few that are not.
    const { container } = render(<BoatBadge boatIds={['b1']} />)
    await waitFor(() => expect(container.textContent).toBe(''))
  })

  it('names a competitor', async () => {
    render(<BoatBadge boatIds={['b2']} />)
    await waitFor(() => expect(screen.getByTitle(/Capricorno — a competitor/)).toBeTruthy())
  })

  it('names the rival in a line-up and leaves our own boat out of it', async () => {
    render(<BoatBadge boatIds={['b1', 'b2']} />)
    const el = await screen.findByTitle(/Capricorno/)
    expect(el.textContent).toContain('Capricorno')
    expect(el.textContent).not.toContain('Northstar')
  })

  it('shows nothing for a boat the table has never heard of', async () => {
    // Cannot say it is a rival, so it is not claimed to be one.
    const { container } = render(<BoatBadge boatIds={['b-unknown']} />)
    await waitFor(() => expect(container.textContent).toBe(''))
  })
})
