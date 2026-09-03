import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

// The day's log: TWS 8 kt through the morning, 20 kt through the afternoon.
// A scan re-timed from one to the other must show the OTHER number.
const DAY = '2026-09-02'
const T0 = Date.parse('2026-09-02T08:00:00Z')   // morning, 8 kt
const T1 = Date.parse('2026-09-02T13:00:00Z')   // afternoon, 20 kt
const rows = Array.from({ length: 7 * 60 }, (_, i) => {
  const utc = T0 + i * 60000
  const morning = utc < Date.parse('2026-09-02T11:00:00Z')
  return { utc, tws: morning ? 8 : 20, twa: morning ? 40 : 140, aws: morning ? 10 : 24, awa: 30, bsp: 7, vsPerfPct: 100, forestay: 300 }
})

vi.mock('../../lib/localStore', () => ({ getLogData: vi.fn(async () => ({ rows })) }))

import SailScanDetail from '../SailScanDetail'

const scanAt = (ms: number) => ({
  id: 'scan-1', sail_id: null, stripes: [],
  captured_at: new Date(ms).toISOString(),
  conditions: { captured_local: DAY + ' ' + new Date(ms).toISOString().slice(11, 16) },
})

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => ({ window: null }) })))
})

const twsShown = () => screen.getByText('TWS').parentElement?.textContent || ''

describe('sail scan detail — re-timing the capture', () => {
  it('recomputes the log window when the capture time changes', async () => {
    const { rerender } = render(
      <SailScanDetail scan={scanAt(T0)} teamId="t1" onClose={() => {}} sessionTzOffset={120} />
    )
    await waitFor(() => expect(twsShown()).toMatch(/8\.0/))

    // What the parent does after a successful save: same id, new stamps.
    rerender(<SailScanDetail scan={scanAt(T1)} teamId="t1" onClose={() => {}} sessionTzOffset={120} />)

    // Before the fix this stayed at 8.0 — the effect keyed on scan.id alone.
    await waitFor(() => expect(twsShown()).toMatch(/20\.0/))
  })
})
