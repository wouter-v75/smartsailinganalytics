import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'

// The consent gate on the team debrief recorder.
//
// The rule this protects: a debrief recording captures everyone in the room, so
// it must not start until every coach/tl1/tl2/tl3 on the team has agreed. The
// failure that matters is the SILENT one — the gate quietly stops working and
// the recorder opens a file picker for a team that never consented. Nothing else
// in the app would notice, so it is asserted here.
//
// The file picker is the observable side effect: `click()` on the hidden input
// is what "the recorder ran" means at this level.

const clickSpy = vi.fn()

// jsdom has no file dialog; intercept the click on the hidden file input.
const origClick = HTMLInputElement.prototype.click
beforeEach(() => {
  clickSpy.mockClear()
  HTMLInputElement.prototype.click = clickSpy
})
afterEach(() => {
  HTMLInputElement.prototype.click = origClick
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

// Vocab load + consent fetch share one mock, keyed by URL.
function mockFetch(consent: Record<string, unknown>) {
  return vi.fn(async (url: string) => {
    if (String(url).includes('recording-consent')) {
      return { ok: true, json: async () => consent }
    }
    return { ok: true, json: async () => ({ sails: [], boats: [] }) }
  })
}

async function renderBrief(consent: Record<string, unknown>) {
  vi.stubGlobal('fetch', mockFetch(consent))
  const { default: AudioBrief } = await import('../AudioBrief')
  render(
    <AudioBrief
      mode="debrief"
      fields={[{ key: 'what', label: 'What happened' }]}
      onSaved={async () => {}}
      canEdit
      isMobile={false}
      teamId="team-1"
      boatId="boat-1"
    />,
  )
  return screen.findByRole('button', { name: /Summarise from a recording/i })
}

describe('AudioBrief consent gate', () => {
  it('opens the picker when the whole team has agreed', async () => {
    const btn = await renderBrief({ total: 3, consented: 3, pending: [], allConsented: true })
    fireEvent.click(btn)
    await waitFor(() => expect(clickSpy).toHaveBeenCalled())
    expect(screen.queryByText(/have agreed to team recording/i)).toBeNull()
  })

  it('refuses and explains when someone has not agreed', async () => {
    const btn = await renderBrief({
      total: 3, consented: 2, pending: ['Sam Weller'], allConsented: false,
    })
    fireEvent.click(btn)

    // The wording is the user-facing contract, so it is asserted literally.
    await screen.findByText(/Not all of your team have agreed to team recording/i)
    expect(screen.getByText(/They can do so in their/i)).toBeTruthy()
    // And it names who, so the coach has a next step rather than a puzzle.
    expect(screen.getByText(/Sam Weller/)).toBeTruthy()
    // The important half: the recorder did NOT run.
    expect(clickSpy).not.toHaveBeenCalled()
  })

  it('re-checks on press, so a withdrawal mid-session bites immediately', async () => {
    // Mounted while everyone had agreed…
    vi.stubGlobal('fetch', mockFetch({ total: 2, consented: 2, pending: [], allConsented: true }))
    const { default: AudioBrief } = await import('../AudioBrief')
    render(
      <AudioBrief
        mode="debrief" fields={[{ key: 'what', label: 'What' }]}
        onSaved={async () => {}} canEdit isMobile={false}
        teamId="team-1" boatId="boat-1"
      />,
    )
    const btn = await screen.findByRole('button', { name: /Summarise from a recording/i })

    // …then someone withdraws before the coach presses the button.
    vi.stubGlobal('fetch', mockFetch({
      total: 2, consented: 1, pending: ['Ada Byron'], allConsented: false,
    }))
    fireEvent.click(btn)

    await screen.findByText(/Not all of your team have agreed to team recording/i)
    expect(clickSpy).not.toHaveBeenCalled()
  })

  it('does not block a team whose consent could not be read', async () => {
    // A failed lookup must not become a silent lockout of a consenting team;
    // the server is the real gate, this is the courtesy check.
    vi.stubGlobal('fetch', vi.fn(async (url: string) =>
      String(url).includes('recording-consent')
        ? { ok: false, json: async () => ({}) }
        : { ok: true, json: async () => ({ sails: [], boats: [] }) }))
    const { default: AudioBrief } = await import('../AudioBrief')
    render(
      <AudioBrief
        mode="debrief" fields={[{ key: 'what', label: 'What' }]}
        onSaved={async () => {}} canEdit isMobile={false}
        teamId="team-1" boatId="boat-1"
      />,
    )
    const btn = await screen.findByRole('button', { name: /Summarise from a recording/i })
    fireEvent.click(btn)
    await waitFor(() => expect(clickSpy).toHaveBeenCalled())
  })
})
