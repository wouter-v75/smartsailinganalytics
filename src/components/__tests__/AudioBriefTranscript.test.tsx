import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

// "The transcription is cut short in the box."
//
// It has been asked three times and been something different each time: the box
// was too short (bd975f6, c0cc5b1), then the model ran out of room (a0f2698,
// 3a2ed63). The box fix gave every NOTE box its full height and left the
// transcript box — the one holding forty minutes of speech — at the 60vh
// default, scrolling, which is the exact illusion it was written to end.
//
// So two things are pinned here, both of them about making the question
// ANSWERABLE rather than a judgement about a bottom edge: the box is uncapped,
// and the panel states the transcript's size in characters.
//
// The third is the quiet one: a part that transcribed to nothing used to be
// joined in silently. Now it is named, and a clean run says nothing.

const runAudioBrief = vi.fn()
vi.mock('../../lib/debriefAudio', () => ({
  runAudioBrief: (...a: unknown[]) => runAudioBrief(...a),
}))
vi.mock('../../lib/boatVocab', () => ({ loadBoatVocab: async () => null }))

import AudioBrief from '../AudioBrief'

const LONG = Array.from({ length: 400 }, (_, i) => `line ${i + 1} of the debrief transcript`).join(' ')

beforeEach(() => {
  runAudioBrief.mockReset()
  vi.stubGlobal('fetch', vi.fn(async (url: string) =>
    String(url).includes('recording-consent')
      ? { ok: true, json: async () => ({ total: 1, consented: 1, pending: [], youConsented: true, allConsented: true }) }
      : { ok: true, json: async () => ({ sails: [], boats: [] }) }))
})
afterEach(() => { vi.unstubAllGlobals() })

async function runWith(out: Record<string, unknown>) {
  runAudioBrief.mockResolvedValue(out)
  const { container } = render(
    <AudioBrief
      mode="debrief"
      fields={[{ key: 'learnings', label: 'Learnings' }]}
      onSaved={async () => {}}
      canEdit
      isMobile={false}
      teamId="team-1"
      boatId="boat-1"
    />,
  )
  const input = container.querySelector('input[type="file"]') as HTMLInputElement
  fireEvent.change(input, { target: { files: [new File(['x'], 'debrief.m4a', { type: 'audio/mp4' })] } })
  await screen.findByRole('button', { name: /Save to section/i })
  return container
}

const base = {
  fields: { learnings: '- we were slow out of the tack' },
  transcript: LONG,
  truncated: false,
  durationSec: 3600,
  parts: 12,
  gap: null,
}

describe('AudioBrief transcript box', () => {
  it('holds the whole transcript with no height cap', async () => {
    const container = await runWith(base)
    fireEvent.click(screen.getByRole('button', { name: /Show transcript/i }))

    const boxes = Array.from(container.querySelectorAll('textarea')) as HTMLTextAreaElement[]
    const tx = boxes.find((t) => t.readOnly)
    expect(tx, 'the read-only transcript box should be rendered').toBeTruthy()
    // Every character, and nothing standing between the last one and the eye.
    expect(tx!.value).toBe(LONG)
    expect(tx!.style.maxHeight).toBe('none')
  })

  it('states the size, so "is it cut short" is a reading and not a guess', async () => {
    await runWith(base)
    fireEvent.click(screen.getByRole('button', { name: /Show transcript/i }))

    await screen.findByText(new RegExp(`${LONG.length.toLocaleString()} characters`))
    expect(screen.getByText(/12 parts/)).toBeTruthy()
    expect(screen.getByText(/60:00 of audio/)).toBeTruthy()
  })

  it('does not cap the editable draft fields either', async () => {
    const container = await runWith(base)
    const draft = Array.from(container.querySelectorAll('textarea'))
      .find((t) => !(t as HTMLTextAreaElement).readOnly) as HTMLTextAreaElement
    expect(draft.style.maxHeight).toBe('none')
  })
})

describe('AudioBrief transcript gaps', () => {
  it('says which part came back with no words', async () => {
    await runWith({ ...base, gap: 'Part 12 of 12 came back with no words (55:00–60:00). Either nobody was talking then, or that stretch was lost — the transcript has a gap there, so the summary cannot cover it.' })
    // Shown WITHOUT having to open the transcript: the gap is the reason the
    // note looks short, so it belongs beside the note.
    expect(screen.getByText(/Part 12 of 12 came back with no words/)).toBeTruthy()
    expect(screen.getByText(/55:00–60:00/)).toBeTruthy()
  })

  it('says nothing at all on a clean run', async () => {
    await runWith(base)
    expect(screen.queryByText(/came back with no words/)).toBeNull()
  })

  it('is separate from the summary being unfinished', async () => {
    // Two different failures with two different fixes; neither must be reported
    // as the other.
    await runWith({ ...base, truncated: true })
    expect(screen.getByText(/The summary is still unfinished/)).toBeTruthy()
    expect(screen.queryByText(/came back with no words/)).toBeNull()
  })

  it('names the signal: a reply that stopped mid-sentence while claiming to be done', async () => {
    // The Ryujin case. "The provider cut it off" and "it ends mid-sentence and
    // says otherwise" need different next steps, so the panel says which.
    await runWith({
      ...base,
      truncated: true,
      cutSignals: { repaired: false, finishReason: false, midSentence: true },
    })
    expect(screen.getByText(/ends mid-sentence even though the model reported it as complete/)).toBeTruthy()
  })

  it('falls back to the plain wording when the signal is not known', async () => {
    // An older route, or a provider that really did cut it off.
    await runWith({ ...base, truncated: true, cutSignals: { repaired: true, finishReason: true, midSentence: true } })
    expect(screen.getByText(/the model stopped early/)).toBeTruthy()
  })
})

describe('getting the transcript back out', () => {
  it('copies the whole thing, so a re-summarise costs no transcription', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    await runWith(base)

    fireEvent.click(screen.getByRole('button', { name: /Copy transcript/i }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(LONG))
    await screen.findByRole('button', { name: /Copied/i })
  })

  it('falls back to opening the box when the clipboard is refused', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(async () => { throw new Error('denied') }) },
    })
    const container = await runWith(base)

    fireEvent.click(screen.getByRole('button', { name: /Copy transcript/i }))
    await waitFor(() => {
      const tx = Array.from(container.querySelectorAll('textarea'))
        .find((t) => (t as HTMLTextAreaElement).readOnly) as HTMLTextAreaElement | undefined
      expect(tx?.value).toBe(LONG)
    })
  })
})
