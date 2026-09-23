import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import AskPanel from '../analytics/AskPanel'

const boat = { teamId: 'team-1', boatId: 'boat-1' }
const DATE = '2026-09-11'

const table = {
  title: 'VMG% by tack',
  columns: [
    { key: 'tack', label: 'Tack', group: true },
    { key: 'n', label: 'n' },
    { key: 'vmgPct', label: 'VMG%', unit: '%', decimals: 1 },
  ],
  rows: [['Port', 18, 96.4], ['Stbd', 16, 99.1]],
}

const answered = {
  answer: { lines: ['VMG% was 99.1 on starboard against 96.4 on port.'], bottomLine: ['Work on the port groove.'], dropped: [] },
  steps: [{
    tool: 'compare_phases',
    args: { by: ['tack'], metrics: ['vmgPct'], modes: ['up'], twsMin: 14, twsMax: 18, minPhases: 3 },
    tokens: [
      { path: 'dateRange', label: 'Days', text: '2026-09-11', kind: 'daterange', value: [DATE, DATE], editable: true },
      { path: 'modes', label: 'Point of sail', text: 'Upwind', kind: 'multi', value: ['up'], options: [{ value: 'up', label: 'Upwind' }, { value: 'down', label: 'Downwind' }], editable: true },
      { path: 'tws', label: 'TWS', text: 'TWS 14–18 kn', kind: 'number', unit: 'kn', value: ['14', '18'], editable: true },
    ],
    summary: '34 phases of 58, in 2 groups.',
    unavailable: null,
    tables: [table],
    charts: [{
      kind: 'bar', title: 'VMG%', xType: 'category', xLabel: 'Tack', yLabel: 'VMG%', unit: '%',
      series: [{ label: 'VMG%', points: [{ x: 'Port', y: 96.4 }, { x: 'Stbd', y: 99.1 }] }],
    }],
    media: [{
      kind: 'photo', id: 'p1', title: 'J4_A 2026', atLocal: '14:32', utc: 1, date: DATE,
      thumbUrl: 'blob:thumb', fullUrl: 'blob:full', conditions: 'TWS 17.2 kn · TWA 42 °', note: null,
    }],
  }],
  suggestions: [],
  risk: { level: 'ok', before: [], after: [], narrower: [] },
  needsStats: false,
  model: 'mistral-medium-3.5-128b',
  ms: 4200,
  logId: 'log-1',
}

const blocked = {
  blocked: true,
  needsStats: false,
  risk: {
    level: 'high',
    before: [{ code: 'people', text: 'You have asked about a person or a role. Nothing in this data is tied to an individual crew member, so any name it gives you would be invented.' }],
    after: [],
    narrower: ['Was VMG% better on port or starboard upwind on 2026-09-11?', 'Which tacks cost the most distance on 2026-09-11?'],
  },
}

let fetchMock: ReturnType<typeof vi.fn>
const jsonOnce = (body: unknown, ok = true, status = 200) =>
  fetchMock.mockImplementationOnce(async () => ({ ok, status, json: async () => body }))

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => { vi.unstubAllGlobals() })

const panel = (over: Record<string, unknown> = {}) =>
  render(<AskPanel boat={boat} activeDate={DATE} canUseAI races={3} hasManoeuvres hasPhotos manyDays {...over} />)

const ask = (text: string) => {
  fireEvent.change(screen.getByLabelText('Ask a question about this data'), { target: { value: text } })
  fireEvent.click(screen.getByRole('button', { name: 'Ask' }))
}

describe('AskPanel — the box', () => {
  it('is not there at all for a role without the AI tools', () => {
    const { container } = panel({ canUseAI: false })
    expect(container.textContent).toBe('')
  })

  // Long-form typing into a blank field is still not a habit for most people.
  it('offers questions before anything is typed', () => {
    panel()
    expect(screen.getByText(/port or starboard upwind/i)).toBeTruthy()
    expect(screen.getByText(/tacks cost the most distance/i)).toBeTruthy()
  })

  it('only offers a question the day can answer', () => {
    panel({ hasPhotos: false, hasManoeuvres: false, manyDays: false, races: 0 })
    expect(screen.queryByText(/photos from the strongest wind/i)).toBeNull()
    expect(screen.queryByText(/tacks cost the most/i)).toBeNull()
  })

  it('says what it reads and where it runs, without being asked', () => {
    panel()
    expect(screen.getByText(/Mistral on Scaleway \(EU\)/)).toBeTruthy()
    expect(screen.getByText(/never calculates/)).toBeTruthy()
  })

  it('will not ask without a day open', () => {
    panel({ activeDate: null })
    expect((screen.getByLabelText('Ask a question about this data') as HTMLInputElement).disabled).toBe(true)
    expect(screen.getByPlaceholderText('Open a day first')).toBeTruthy()
  })
})

describe('AskPanel — the answer', () => {
  it('sends the question with the day and shows the answer, chart, rows and photo', async () => {
    jsonOnce(answered)
    panel()
    ask('were we quicker on port or starboard upwind?')

    await screen.findByText(/VMG% was 99.1 on starboard/)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/ai/ask')
    expect(JSON.parse(init.body)).toMatchObject({ teamId: 'team-1', boatId: 'boat-1', date: DATE })

    expect(screen.getByText('Work on the port groove.')).toBeTruthy()   // bottom line
    expect(screen.getByText('You asked')).toBeTruthy()                   // input beside output
    expect(document.querySelector('svg[role="img"]')).toBeTruthy()       // the chart
    expect(screen.getByText(/J4_A 2026/)).toBeTruthy()                   // the evidence
    expect(screen.getByText(/TWS 17.2 kn/)).toBeTruthy()
  })

  it('shows what it understood as tokens a person can read', async () => {
    jsonOnce(answered)
    panel()
    ask('were we quicker on port upwind in the breeze?')
    await screen.findByText(/TWS 14–18 kn/)
    expect(screen.getByText(/Upwind/)).toBeTruthy()
  })

  it('names the model, the time and the number check before asking for a verdict', async () => {
    jsonOnce(answered)
    panel()
    ask('were we quicker on port upwind?')
    await screen.findByText(/mistral-medium-3.5-128b on Scaleway \(EU\)/)
    expect(screen.getByText(/Check it before you act on it/)).toBeTruthy()
    expect(screen.getByTitle('Useful')).toBeTruthy()
  })

  it('records a thumb against the logged question', async () => {
    jsonOnce(answered)
    panel()
    ask('were we quicker on port upwind?')
    await screen.findByTitle('Useful')
    jsonOnce({ ok: true })
    fireEvent.click(screen.getByTitle('Useful'))
    await waitFor(() => expect(fetchMock.mock.calls[1][0]).toBe('/api/ai/ask/feedback'))
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ logId: 'log-1', verdict: 1 })
  })

  it('shows the rows behind the chart on request', async () => {
    jsonOnce(answered)
    panel()
    ask('were we quicker on port upwind?')
    fireEvent.click(await screen.findByRole('button', { name: /Show the 2 rows behind this/ }))
    const rows = await screen.findByRole('table')
    expect(within(rows).getByText('96.4')).toBeTruthy()
    expect(within(rows).getByText('18')).toBeTruthy()      // n travels with the number
  })

  it('reports the error rather than an empty box', async () => {
    jsonOnce({ error: 'scaleway 429: too many requests' }, false, 502)
    panel()
    ask('were we quicker on port upwind?')
    await screen.findByText(/scaleway 429/)
  })
})

describe('AskPanel — when it should not answer', () => {
  it('warns, refuses and offers questions the data can answer', async () => {
    jsonOnce(blocked)
    panel()
    ask('who was trimming when we were slow?')

    await screen.findByText(/This is the kind of question that gets made up/)
    expect(screen.getByText(/any name it gives you would be invented/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /Was VMG% better on port or starboard/ })).toBeTruthy()
    expect(screen.queryByTitle('Useful')).toBeNull()      // nothing to judge
  })

  it('lets the person insist, and says so on the wire', async () => {
    jsonOnce(blocked)
    panel()
    ask('who was trimming when we were slow?')
    await screen.findByRole('button', { name: 'Answer my question anyway' })

    jsonOnce(answered)
    fireEvent.click(screen.getByRole('button', { name: 'Answer my question anyway' }))
    await waitFor(() => expect(fetchMock.mock.calls).toHaveLength(2))
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).force).toBe(true)
  })

  it('asks a suggested question when it is clicked', async () => {
    jsonOnce(blocked)
    panel()
    ask('who was trimming?')
    const suggestion = await screen.findByRole('button', { name: /Which tacks cost the most distance/ })

    jsonOnce(answered)
    fireEvent.click(suggestion)
    await waitFor(() => expect(fetchMock.mock.calls).toHaveLength(2))
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).question).toMatch(/Which tacks cost the most distance/)
  })

  it('offers to compute a day that has no stored numbers', async () => {
    jsonOnce({ ...answered, needsStats: true, answer: { lines: [], bottomLine: [], dropped: [] }, steps: [] })
    panel()
    ask('were we quicker on port upwind?')
    await screen.findByText(/no stored performance numbers yet/)

    jsonOnce({ ok: true })
    jsonOnce(answered)
    fireEvent.click(screen.getByRole('button', { name: /Compute this day/ }))
    await waitFor(() => expect(fetchMock.mock.calls[1][0]).toBe(`/api/teams/team-1/boats/boat-1/phase-stats/${DATE}`))
    await screen.findByText(/VMG% was 99.1 on starboard/)
  })
})

describe('AskPanel — editing a search token', () => {
  const openTwsEditor = async () => {
    jsonOnce(answered)
    panel()
    ask('were we quicker on port upwind in the breeze?')
    fireEvent.click(await screen.findByTitle('TWS — click to change'))
  }

  it('re-runs the tool deterministically, with no second model call', async () => {
    await openTwsEditor()
    fireEvent.change(screen.getByPlaceholderText('from'), { target: { value: '20' } })
    fireEvent.change(screen.getByPlaceholderText('to'), { target: { value: '' } })

    jsonOnce({
      tool: 'compare_phases',
      args: { by: ['tack'], metrics: ['vmgPct'], twsMin: 20, minPhases: 3 },
      tokens: [{ path: 'tws', label: 'TWS', text: 'TWS over 20 kn', kind: 'number', value: ['20', ''], editable: true }],
      summary: '9 phases.', unavailable: null,
      tables: [{ ...table, rows: [['Port', 5, 94.1], ['Stbd', 4, 97.7]] }],
      charts: [], media: [],
    })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

    await waitFor(() => expect(fetchMock.mock.calls[1][0]).toBe('/api/ai/ask/tool'))
    const sent = JSON.parse(fetchMock.mock.calls[1][1].body)
    expect(sent.tool).toBe('compare_phases')
    expect(sent.edit).toEqual({ path: 'tws', value: ['20', ''] })
    await screen.findByText(/TWS over 20 kn/)
  })

  // Honest attribution: the prose was written for the question as it was asked.
  it('says the words no longer match the filter once it has been changed', async () => {
    await openTwsEditor()
    jsonOnce({ tokens: [], summary: '', unavailable: null, tables: [], charts: [], media: [] })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    await screen.findByText(/still describe the original query/)
  })

  it('shows a rejected edit against the step instead of losing the answer', async () => {
    await openTwsEditor()
    jsonOnce({ error: 'compare_phases needs "metrics"' }, false, 400)
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    await screen.findByText(/compare_phases needs "metrics"/)
    expect(screen.getByText(/VMG% was 99.1 on starboard/)).toBeTruthy()
  })
})
