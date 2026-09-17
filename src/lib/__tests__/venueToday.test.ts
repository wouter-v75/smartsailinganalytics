// venueTzOffsetMin picks the venue out of the session index, which is what makes
// "today" agree with the dates the sessions themselves are filed under.

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'

const store = new Map<string, string>()

beforeEach(() => {
  store.clear()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v) },
    removeItem: (k: string) => { store.delete(k) },
  })
  vi.resetModules()
})
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

const setSessions = (sessions: unknown[]) =>
  store.set('ssa:sessions', JSON.stringify(sessions))

async function load() {
  return import('../localStore')
}

describe('venueTzOffsetMin', () => {
  it('takes the most recent session that has an offset', async () => {
    // upsertSession keeps the index newest-first; the first hit is the latest day.
    setSessions([
      { date: '2026-09-17', tzOffset: 120 },
      { date: '2026-09-10', tzOffset: 60 },
    ])
    const { venueTzOffsetMin } = await load()
    expect(venueTzOffsetMin()).toBe(120)
  })

  it('skips days that never recorded one', async () => {
    setSessions([
      { date: '2026-09-17' },
      { date: '2026-09-16', tzOffset: null },
      { date: '2026-09-15', tzOffset: -240 },
    ])
    const { venueTzOffsetMin } = await load()
    expect(venueTzOffsetMin()).toBe(-240)
  })

  it('accepts a zero offset rather than reading it as absent', async () => {
    setSessions([{ date: '2026-09-17', tzOffset: 0 }])
    const { venueTzOffsetMin } = await load()
    expect(venueTzOffsetMin()).toBe(0)
  })

  it('is null on a fresh install, and on a corrupt index', async () => {
    const { venueTzOffsetMin } = await load()
    expect(venueTzOffsetMin()).toBeNull()
    store.set('ssa:sessions', 'not json')
    expect(venueTzOffsetMin()).toBeNull()
  })
})

describe('venueTodayIso', () => {
  it('reports the venue’s day, not the viewer’s', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-17T20:30:00Z'))
    setSessions([{ date: '2026-09-17', tzOffset: 13 * 60 }])   // Auckland
    const { venueTodayIso } = await load()
    expect(venueTodayIso()).toBe('2026-09-18')
  })

  it('falls back to the device date when no session fixes a venue', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-15T12:00:00Z'))
    const { venueTodayIso } = await load()
    const { localToday } = await import('../today')
    expect(venueTodayIso()).toBe(localToday())
  })
})
