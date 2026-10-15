// What happens when the date and the log do not agree.
//
// uploadSessionStats() is handed a date and a log as two unconnected arguments, and
// both callers can hold them apart for a moment: loadDate() sets the new activeDate
// and only then awaits the new day's log out of IndexedDB, handleImported() sets the
// imported day's log and only then awaits a getUser() before switching the date. An
// effect firing inside either window gets one day's date with another day's log.
//
// Three stored rows were written that way — 2026-09-27 holding 212 phases of the
// 29th, 2026-10-03 holding 276 of the 2nd, 2026-09-06 holding 263 of the 8th, each a
// full-resolution copy of its neighbour's row. The test that matters is the negative
// one: NOTHING is posted. A row that reaches the database is invisible afterwards —
// time-matched lookups find nothing and read as "the camera was out at the wrong
// time", everything else quietly reports another day's conditions as this day's.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { uploadSessionStats } from '../phaseStatsUpload'
import type { LogRow } from '../phaseStats'

const dayStart = (iso: string) => Date.parse(`${iso}T10:00:00Z`)

// A day's worth of 1 Hz upwind rows, and the event file's 30 s phases over them.
const dayOf = (iso: string) => {
  const t0 = dayStart(iso)
  const rows: LogRow[] = Array.from({ length: 120 }, (_, i) => ({
    utc: t0 + i * 1000, tws: 20, bsp: 10, twa: 40, awa: 26, heel: -22,
  })) as LogRow[]
  const xml = {
    phases: [0, 30, 60, 90].map(s => ({ utc: t0 + s * 1000, endUtc: t0 + (s + 30) * 1000, mode: 1 })),
    sailsUpEvents: [{ utc: t0 - 1000, sails: ['MAIN_B 2026', 'J4_A 2026'] }],
    raceGuns: [],
  }
  return { rows, xml }
}

const run = (date: string, from: string) => {
  const { rows, xml } = dayOf(from)
  return uploadSessionStats({ teamId: 'team-1', boatId: 'boat-1', date, rows, xml, polar: null, polarId: null })
}

afterEach(() => { vi.restoreAllMocks() })

describe('uploadSessionStats', () => {
  it('stores a day whose log is that day', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ computed: true }) })
    vi.stubGlobal('fetch', fetchMock)
    const r = await run('2026-09-29', '2026-09-29')
    expect(r.stored).toBe(true)
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0][0]).toBe('/api/teams/team-1/boats/boat-1/phase-stats/2026-09-29')
  })

  it('posts nothing when the log in memory is another day, and names which day it is', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ computed: true }) })
    vi.stubGlobal('fetch', fetchMock)
    // The 27th on screen, the 29th's log still loaded — the row that was actually written.
    const r = await run('2026-09-27', '2026-09-29')
    expect(r.stored).toBe(false)
    expect(r.reason).toBe("the log on this device is not 2026-09-27's — these phases are 2026-09-29's, not 2026-09-27's")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses a one-day slip the same way — the 3 Oct row held 2 Oct', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ computed: true }) })
    vi.stubGlobal('fetch', fetchMock)
    const r = await run('2026-10-03', '2026-10-02')
    expect(r.stored).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('says so without posting when the log has no phases at all', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const r = await uploadSessionStats({
      teamId: 'team-1', boatId: 'boat-1', date: '2026-09-29',
      rows: dayOf('2026-09-29').rows, xml: { phases: [] }, polar: null, polarId: null,
    })
    expect(r.stored).toBe(false)
    expect(r.reason).toBe('no phases in the log')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
