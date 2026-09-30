import React from 'react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import DebriefVocabPanel from '../boat/DebriefVocabPanel'

// Boat → Debrief words. The thing worth pinning is what the panel SAYS, because
// the first real use of it went wrong there rather than in the data: pressing
// "+ Add" (as it then read) looked like it stored the word, and the save that
// followed reported the resulting empty row as work lost. Nothing was lost. The
// message sent somebody looking for it anyway.

let stored: Record<string, unknown> = {}
let put: Record<string, unknown> | null = null

const mockApi = () => vi.fn((url: string, init?: RequestInit) => {
  if (init?.method === 'PUT') {
    put = JSON.parse(String(init.body)).vocab
    stored = put as Record<string, unknown>
    return Promise.resolve({ ok: true, json: async () => ({ vocab: stored, updatedAt: null }) })
  }
  void url
  return Promise.resolve({ ok: true, json: async () => ({ vocab: stored, updatedAt: null }) })
})

beforeEach(() => { stored = {}; put = null; vi.stubGlobal('fetch', mockApi()) })

const panel = () => render(<DebriefVocabPanel teamId="t1" boatId="b1" canEdit isMobile={false} />)
const card = (k: string) => screen.getByTestId(`vocab-${k}`) as HTMLElement
const addRow = (k: string) => fireEvent.click(within(card(k), '+ Add a row'))
const within = (el: HTMLElement, text: string) =>
  Array.from(el.querySelectorAll('button')).find((b) => b.textContent === text) as HTMLButtonElement
const boxes = (k: string) => Array.from(card(k).querySelectorAll('input'))
const type = (k: string, i: number, v: string) =>
  fireEvent.change(boxes(k)[i], { target: { value: v } })

describe('DebriefVocabPanel', () => {
  it('says nothing was lost when the only stray row is empty', async () => {
    // Exactly what happened on 30 Sept: three real entries typed in, plus one
    // row added and left blank.
    panel()
    await waitFor(() => card('boats'))
    addRow('boats'); type('boats', 0, 'Tilakkhana II')
    addRow('manoeuvres'); type('manoeuvres', 0, 'Sandukan')
    addRow('aliases'); type('aliases', 0, 'Sandukan'); type('aliases', 1, 'gybe set at the top mark')
    addRow('crew')                                     // the stray one
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(screen.getByText(/the next recording uses these/)).toBeTruthy())
    expect(screen.queryByText(/half-filled/)).toBeNull()
    expect(put).toMatchObject({
      boats: ['Tilakkhana II'],
      manoeuvres: ['Sandukan'],
      aliases: [['Sandukan', 'gybe set at the top mark']],
      crew: [],
    })
  })

  it('explains a half-filled row rather than leaving Save inert', async () => {
    // A pair with one side blank normalises to nothing, so the draft is not
    // dirty and Save greys out. Without a word from the bar, the row sits on
    // screen and the button looks broken.
    panel()
    await waitFor(() => card('roles'))
    addRow('roles'); type('roles', 0, 'Nobody')
    await waitFor(() => expect(screen.getByText(/both sides filled in/)).toBeTruthy())
    expect((screen.getByRole('button', { name: 'Saved' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('saves the real work and reports the half-filled row beside it', async () => {
    panel()
    await waitFor(() => card('boats'))
    addRow('boats'); type('boats', 0, 'Tilakkhana II')
    addRow('roles'); type('roles', 0, 'Nobody')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.getByText(/1 half-filled row was dropped/)).toBeTruthy())
    expect(put).toMatchObject({ boats: ['Tilakkhana II'], roles: [] })
  })

  it('warns that nothing is stored until Save is pressed', async () => {
    panel()
    await waitFor(() => card('boats'))
    addRow('boats'); type('boats', 0, 'Tilakkhana II')
    expect(screen.getByText(/Not stored yet/)).toBeTruthy()
  })

  it('offers no way to type anything when the role cannot edit', async () => {
    render(<DebriefVocabPanel teamId="t1" boatId="b1" canEdit={false} isMobile={false} />)
    await waitFor(() => card('boats'))
    expect(screen.queryByText('+ Add a row')).toBeNull()
    expect(screen.queryByRole('button', { name: /Save/ })).toBeNull()
    expect(screen.getByText(/read-only/)).toBeTruthy()
  })
})
