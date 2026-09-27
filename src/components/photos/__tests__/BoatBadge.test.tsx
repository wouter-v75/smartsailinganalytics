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
  it('shows nothing when the photo names no boat', () => {
    const { container } = render(<BoatBadge boat={null} />)
    expect(container.textContent).toBe('')
  })

  it('names our own boat plainly', async () => {
    render(<BoatBadge boat="Northstar 76" />)
    const el = await screen.findByTitle('Northstar 76')
    expect(el.textContent).toContain('Northstar 76')
  })

  it('marks a competitor as one', async () => {
    render(<BoatBadge boat="Capricorno" />)
    await waitFor(() => expect(screen.getByTitle(/Capricorno — a competitor/)).toBeTruthy())
  })

  it('still shows a boat it has never heard of', async () => {
    // A name typed in SailTrim before the boat exists in the table. The name is
    // worth showing; we just cannot say whose it is.
    render(<BoatBadge boat="Rambler 88" />)
    const el = await screen.findByTitle('Rambler 88')
    expect(el.textContent).toContain('Rambler 88')
  })
})
