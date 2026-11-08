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

// Vocab load + consent fetch share one mock, keyed by URL. A second argument
// means the POST that writes the caller's own consent; it answers with `after`,
// standing in for the route's recomputed gate.
function mockFetch(consent: Record<string, unknown>, after?: Record<string, unknown>) {
  // Stateful on purpose: a POST changes what the next GET says, exactly as the
  // database does. A mock that forgot the write would hide the re-check on the
  // second press, which is the half that matters.
  let state = consent
  return vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    if (String(url).includes('recording-consent')) {
      if (init?.method === 'POST') {
        state = after ?? state
        return { ok: true, json: async () => state }
      }
      return { ok: true, json: async () => state }
    }
    return { ok: true, json: async () => ({ sails: [], boats: [] }) }
  })
}

async function renderBrief(
  consent: Record<string, unknown>,
  after?: Record<string, unknown>,
) {
  vi.stubGlobal('fetch', mockFetch(consent, after))
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

// ─────────────────────────────────────────────────────────────────────────────
// Wouter, 8 Nov 2026. A team he had just created, of which he was the only
// member, refused the recorder and named nobody — and the profile box it sent
// him to was already ticked. Two things were wrong: the gate did not count the
// person pressing the button (migration 0105), and when the person still to
// agree IS you, being sent to another page to find a checkbox is not a next
// step. The box is offered here.
// ─────────────────────────────────────────────────────────────────────────────
describe('AudioBrief consent gate — when the missing agreement is yours', () => {
  it('offers the box instead of sending you to your profile', async () => {
    const btn = await renderBrief({
      total: 1, consented: 0, pending: [], youConsented: false, allConsented: false,
    })
    fireEvent.click(btn)

    await screen.findByText(/You have not agreed to be recorded/i)
    expect(screen.getByRole('checkbox')).toBeTruthy()
    // Not the other-people wording: there are no other people.
    expect(screen.queryByText(/Not all of your team have agreed/i)).toBeNull()
    expect(screen.queryByText(/Still to agree/i)).toBeNull()
    expect(clickSpy).not.toHaveBeenCalled()
  })

  it('ticking it saves, re-checks, and unblocks', async () => {
    const btn = await renderBrief(
      { total: 1, consented: 0, pending: [], youConsented: false, allConsented: false },
      { total: 1, consented: 1, pending: [], youConsented: true, allConsented: true },
    )
    fireEvent.click(btn)
    const box = await screen.findByRole('checkbox')

    fireEvent.click(box)

    // The POST carried an explicit boolean, not an empty body.
    await waitFor(() => {
      const posted = (fetch as unknown as { mock: { calls: [string, { method?: string; body?: string }?][] } })
        .mock.calls.find((c) => c[1]?.method === 'POST')
      expect(posted).toBeTruthy()
      expect(JSON.parse(posted![1]!.body!)).toEqual({ consent: true })
    })

    // Blocked panel gone, and it says what to do next rather than vanishing in
    // silence — the file picker is deliberately NOT opened, because the await
    // has broken the user-gesture chain.
    await screen.findByText(/Press the button again/i)
    expect(screen.queryByText(/You have not agreed to be recorded/i)).toBeNull()
    expect(clickSpy).not.toHaveBeenCalled()

    // …and now it does open.
    fireEvent.click(screen.getByRole('button', { name: /Summarise from a recording/i }))
    await waitFor(() => expect(clickSpy).toHaveBeenCalled())
  })

  it('stays blocked, with the names, when agreeing was not enough', async () => {
    const btn = await renderBrief(
      { total: 3, consented: 1, pending: ['Ada Byron'], youConsented: false, allConsented: false },
      { total: 3, consented: 2, pending: ['Ada Byron'], youConsented: true, allConsented: false },
    )
    fireEvent.click(btn)
    fireEvent.click(await screen.findByRole('checkbox'))

    // Your half is done, so the panel switches to the other half.
    await screen.findByText(/Not all of your team have agreed to team recording/i)
    expect(screen.getByText(/Ada Byron/)).toBeTruthy()
    expect(clickSpy).not.toHaveBeenCalled()
  })

  it('says so rather than claiming a consent the database refused', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string }) => {
      if (String(url).includes('recording-consent')) {
        if (init?.method === 'POST') return { ok: false, json: async () => ({ error: 'nope' }) }
        return {
          ok: true,
          json: async () => ({ total: 1, consented: 0, pending: [], youConsented: false, allConsented: false }),
        }
      }
      return { ok: true, json: async () => ({ sails: [], boats: [] }) }
    }))
    const { default: AudioBrief } = await import('../AudioBrief')
    render(
      <AudioBrief
        mode="debrief" fields={[{ key: 'what', label: 'What' }]}
        onSaved={async () => {}} canEdit isMobile={false}
        teamId="team-1" boatId="boat-1"
      />,
    )
    fireEvent.click(await screen.findByRole('button', { name: /Summarise from a recording/i }))
    fireEvent.click(await screen.findByRole('checkbox'))

    await screen.findByText(/could not save your agreement/i)
    expect(screen.queryByText(/Press the button again/i)).toBeNull()
    expect(clickSpy).not.toHaveBeenCalled()
  })

  it('shows the other-people wording when your own answer is unknown', async () => {
    // A stale bundle, or a route that could not say: fall back to the message
    // that at least points somewhere, never to offering a box that writes
    // consent on a guess.
    const btn = await renderBrief({ total: 2, consented: 1, pending: ['Sam Weller'], allConsented: false })
    fireEvent.click(btn)
    await screen.findByText(/Not all of your team have agreed/i)
    expect(screen.queryByRole('checkbox')).toBeNull()
  })
})
