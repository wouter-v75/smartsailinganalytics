import { describe, it, expect } from 'vitest'
import { missText } from '../../components/SailScanDetail'

// Real numbers from 8-9 Sept 2026, Porto Cervo. Two sail scans showed an empty
// boat-state panel and the message could not say why: the day's log simply
// started after the photos were taken.
describe('missText — why the boat-state panel is empty', () => {
  const CET = 120 // venue is UTC+2

  it('says the scan is BEFORE logging started, and by how much', () => {
    const msg = missText(
      { reason: 'outside-log',
        firstUtc: Date.parse('2026-09-08T09:25:36Z'),
        lastUtc: Date.parse('2026-09-08T13:15:43Z') },
      '2026-09-08T09:17:37Z',
      CET
    )
    expect(msg).toContain('11:25–15:15')      // shown in venue local time
    expect(msg).toContain('11:17')
    expect(msg).toContain('8 min BEFORE logging started')
  })

  it('says AFTER when the scan follows the last row', () => {
    const msg = missText(
      { reason: 'outside-log',
        firstUtc: Date.parse('2026-09-08T09:25:00Z'),
        lastUtc: Date.parse('2026-09-08T13:15:00Z') },
      '2026-09-08T13:45:00Z',
      CET
    )
    expect(msg).toContain('30 min AFTER logging stopped')
  })

  it('distinguishes "no log at all" from "outside the log"', () => {
    expect(missText({ reason: 'no-log' }, '2026-09-08T09:17:37Z', CET))
      .toBe('No log has been uploaded for this boat on this day.')
  })

  it('falls back safely when the reason is unknown or absent', () => {
    expect(missText(null, null, CET)).toContain('No log found')
    expect(missText({ reason: 'something-new' }, null, CET)).toContain('No log found')
  })

  it('does not claim a gap when the times make no sense', () => {
    const msg = missText({ reason: 'outside-log', firstUtc: 1, lastUtc: 2 }, null, 0)
    expect(msg).not.toContain('min BEFORE')
    expect(msg).not.toContain('min AFTER')
  })
})
