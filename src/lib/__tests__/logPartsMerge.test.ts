// src/lib/__tests__/logPartsMerge.test.ts
// ─────────────────────────────────────────────────────────────────────────────
// Joining a folder of Expedition log parts back into one day.
//
// The fixture is shaped like the real thing: the 2026-09-30 export's dotted
// `30.09.2026 11:44:26.970` stamp, a high-byte degree sign in the column names,
// and a seam where consecutive parts repeat each other's rows.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest'
import { mergedText, parseStamp, planMerge } from '../logPartsMerge'

// ° is the degree sign as a single high byte — what latin1 reading gives.
const HEADER = 'Date/Time (UTC),True Wind Direction °M,Boat Speed m/s,Alarms,User events'
const row = (t: string, bsp = '5.1') => `${t},212.4,${bsp},,`

const part = (name: string, rows: string[]) => ({ name, text: [HEADER, ...rows].join('\r\n') + '\r\n' })

describe('parseStamp', () => {
  it('reads the dotted layout this export writes', () => {
    expect(parseStamp('30.09.2026 11:44:26.970')).toBe(Date.UTC(2026, 8, 30, 11, 44, 26, 970))
  })
  it('still reads the slash and ISO layouts', () => {
    expect(parseStamp('30/09/2026 11:44:26')).toBe(Date.UTC(2026, 8, 30, 11, 44, 26))
    expect(parseStamp('2026-09-30 11:44:26')).toBe(Date.UTC(2026, 8, 30, 11, 44, 26))
  })
  it('still reads an OLE serial and a FILETIME', () => {
    expect(parseStamp('45930.5')).toBe(Date.UTC(2025, 8, 30, 12, 0, 0))
    expect(parseStamp('1.34282346237428E+17')).toBeGreaterThan(Date.UTC(2026, 0, 1))
  })
  it('is null for anything else', () => {
    for (const s of ['', '   ', undefined, 'RaceTimerRolling']) expect(parseStamp(s)).toBeNull()
  })
})

describe('planMerge', () => {
  it('joins the parts in time order and keeps every column untouched', () => {
    const plan = planMerge([
      part('_b.csv', [row('30.09.2026 12:00:00.000'), row('30.09.2026 12:00:01.000')]),
      part('_a.csv', [row('30.09.2026 11:44:26.970'), row('30.09.2026 11:44:27.970')]),
    ])
    if (!plan.ok) throw new Error(plan.error)
    expect(plan.rows).toBe(4)
    expect(plan.lines[0]).toContain('11:44:26.970')
    expect(plan.lines[3]).toContain('12:00:01.000')
    expect(plan.header).toBe(HEADER)
    expect(mergedText(plan).split('\r\n')[0]).toBe(HEADER)
  })

  it('orders by the stamps, not the filenames', () => {
    // _a through _z sorts fine until there are more than 26 parts, and a part
    // named off-pattern would land in the wrong place in silence.
    const plan = planMerge([
      part('zzz.csv', [row('30.09.2026 11:00:00.000')]),
      part('aaa.csv', [row('30.09.2026 12:00:00.000')]),
    ])
    if (!plan.ok) throw new Error(plan.error)
    expect(plan.lines[0]).toContain('11:00:00')
  })

  it('trims the overlap where two parts repeat each other', () => {
    const plan = planMerge([
      part('_a.csv', [row('30.09.2026 11:00:00.000'), row('30.09.2026 11:00:01.000')]),
      part('_b.csv', [row('30.09.2026 11:00:01.000'), row('30.09.2026 11:00:02.000')]),
    ])
    if (!plan.ok) throw new Error(plan.error)
    expect(plan.rows).toBe(3)
    expect(plan.overlapDropped).toBe(1)
  })

  it('trims the overlap only at the FRONT of a part', () => {
    // Two rows inside one part can share a millisecond at 10 Hz. Those are real
    // rows; only the seam between parts is a repeat.
    const plan = planMerge([
      part('_a.csv', [
        row('30.09.2026 11:00:00.000', '5.0'),
        row('30.09.2026 11:00:00.000', '5.2'),
        row('30.09.2026 11:00:01.000'),
      ]),
    ])
    if (!plan.ok) throw new Error(plan.error)
    expect(plan.rows).toBe(3)
    expect(plan.overlapDropped).toBe(0)
  })

  it('reports where the logger stopped and started again', () => {
    const plan = planMerge([
      part('_a.csv', [row('30.09.2026 11:00:00.000')]),
      part('_b.csv', [row('30.09.2026 13:30:00.000')]),
    ], { gapSec: 60 })
    if (!plan.ok) throw new Error(plan.error)
    expect(plan.gaps).toHaveLength(1)
    expect(plan.gaps[0].seconds).toBe(9000)
    expect(plan.rows).toBe(2)          // a gap is reported, never filled or dropped
  })

  it('refuses parts whose columns differ, rather than joining them anyway', () => {
    // One file's numbers under another file's column names looks completely fine
    // until somebody trusts a chart.
    const other = { name: 'other.csv', text: [HEADER.replace('Boat Speed m/s', 'BSP kts'), row('30.09.2026 11:00:00.000')].join('\r\n') }
    const plan = planMerge([part('_a.csv', [row('30.09.2026 11:00:00.000')]), other])
    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.error).toMatch(/different header/)
    expect(plan.error).toMatch(/column 3/)
  })

  it('names a column-count mismatch plainly', () => {
    const short = { name: 'short.csv', text: ['A,B', 'x,y'].join('\r\n') }
    const plan = planMerge([part('_a.csv', [row('30.09.2026 11:00:00.000')]), short])
    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.error).toMatch(/columns vs/)
  })

  it('keeps a row whose stamp it cannot read, and counts it', () => {
    // It is somebody's data. This is a join, not a filter — but a lot of them
    // means the timestamp layout is not what we think.
    const plan = planMerge([part('_a.csv', [row('30.09.2026 11:00:00.000'), 'nonsense,1,2,,'])])
    if (!plan.ok) throw new Error(plan.error)
    expect(plan.rows).toBe(2)
    expect(plan.unstamped).toBe(1)
  })

  it('survives blank lines, CRLF and a BOM', () => {
    const p = { name: 'bom.csv', text: '﻿' + [HEADER, row('30.09.2026 11:00:00.000'), '', row('30.09.2026 11:00:01.000'), ''].join('\r\n') }
    const plan = planMerge([p])
    if (!plan.ok) throw new Error(plan.error)
    expect(plan.header).toBe(HEADER)
    expect(plan.rows).toBe(2)
  })

  it('says so rather than producing an empty file', () => {
    expect(planMerge([])).toMatchObject({ ok: false, error: /no part files/ })
    expect(planMerge([{ name: 'h.csv', text: HEADER }])).toMatchObject({ ok: false, error: /every part is empty/ })
  })

  it('leaves the degree sign exactly as it found it', () => {
    const plan = planMerge([part('_a.csv', [row('30.09.2026 11:00:00.000')])])
    if (!plan.ok) throw new Error(plan.error)
    expect(mergedText(plan)).toContain('True Wind Direction °M')
  })
})
