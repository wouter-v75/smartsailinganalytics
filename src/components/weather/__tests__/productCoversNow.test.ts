import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { productCoversNow } from '../openMeteo'

// The box overwrites each venue's grid.json in place, so a venue whose run was
// skipped keeps serving its last cycle forever. These fixtures are the REAL time
// axes published at Porto Cervo on 31 Aug 2026: the 1 km nest had been held since
// 12 Aug, while the 2 km parent ran that morning. Before the freshness gate the
// app picked the 1 km and showed 12 August as if it were today.
const PORTO_CERVO_1KM_STALE = ['2026-08-12T04:00:00Z', '2026-08-12T12:00:00Z', '2026-08-12T18:00:00Z']
const PORTO_CERVO_2KM_LIVE = ['2026-08-31T06:00:00Z', '2026-08-31T18:00:00Z', '2026-09-01T18:00:00Z']

const NOW = new Date('2026-08-31T09:00:00Z')

describe('productCoversNow', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW) })
  afterEach(() => { vi.useRealTimers() })

  it('rejects the elapsed Porto Cervo 1 km cycle', () => {
    expect(productCoversNow(PORTO_CERVO_1KM_STALE)).toBe(false)
  })

  it('accepts the 2 km cycle that still runs into tomorrow', () => {
    expect(productCoversNow(PORTO_CERVO_2KM_LIVE)).toBe(true)
  })

  it('keeps a cycle usable right up to its last frame', () => {
    vi.setSystemTime(new Date('2026-08-12T18:00:00Z'))
    expect(productCoversNow(PORTO_CERVO_1KM_STALE)).toBe(true)
  })

  it('allows one hour of grace past the last frame, then drops it', () => {
    vi.setSystemTime(new Date('2026-08-12T18:59:00Z'))
    expect(productCoversNow(PORTO_CERVO_1KM_STALE)).toBe(true)
    vi.setSystemTime(new Date('2026-08-12T19:01:00Z'))
    expect(productCoversNow(PORTO_CERVO_1KM_STALE)).toBe(false)
  })

  it('reads a zone-less stamp as UTC, not local', () => {
    // Without the Z, Date.parse() would read this as local time — west of UTC that
    // would keep a dead cycle alive for hours.
    expect(productCoversNow(['2026-08-12T18:00:00'])).toBe(false)
    expect(productCoversNow(['2026-09-01T18:00:00'])).toBe(true)
  })

  it('treats missing / empty / unparseable axes as not covering now', () => {
    expect(productCoversNow(undefined as unknown as string[])).toBe(false)
    expect(productCoversNow([])).toBe(false)
    expect(productCoversNow(['not-a-date'])).toBe(false)
    // windweight rows map to `h && h.t`, so a malformed tail row yields undefined
    expect(productCoversNow([undefined as unknown as string])).toBe(false)
  })
})
