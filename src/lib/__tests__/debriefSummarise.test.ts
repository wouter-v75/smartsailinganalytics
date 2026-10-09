// src/lib/__tests__/debriefSummarise.test.ts
// ─────────────────────────────────────────────────────────────────────────────
// The continuation loop, end to end, against a model that runs out of room.
//
// This could not be tested while it lived in the route: it only ran behind an
// authenticated Next.js handler against a paid API, so the one time it mattered
// — Baraka's Admiral's Cup debrief — was also the first time it ran.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi } from 'vitest'
import { summariseWithContinuation, coerce, toResult, type Ask } from '../debriefSummarise'

const KEYS = ['learnings'] as const

/** A model that gives these replies in order. `cut` = ran out mid-string. */
const scripted = (replies: { body: string; cut?: boolean }[]): { ask: Ask; calls: unknown[][] } => {
  const calls: unknown[][] = []
  let i = 0
  const ask: Ask = async (messages) => {
    calls.push(messages)
    const r = replies[Math.min(i++, replies.length - 1)]
    return { ok: true, content: r.body, finishReason: r.cut ? 'length' : 'stop' }
  }
  return { ask, calls }
}

describe('summariseWithContinuation', () => {
  it('returns a complete reply untouched, with no extra calls', async () => {
    const { ask, calls } = scripted([{ body: '{"learnings":"all of it"}' }])
    const out = await summariseWithContinuation({ ask, baseMessages: [], keys: KEYS, budgetMs: 280_000 })
    expect(out.result.learnings).toBe('all of it')
    expect(out.truncated).toBe(false)
    expect(out.rounds).toBe(0)
    expect(calls).toHaveLength(1)        // nothing paid for that was not needed
  })

  it('finishes a cut reply and reports it complete', async () => {
    // The real shape: first reply stops mid-sentence, second supplies the rest.
    const { ask, calls } = scripted([
      { body: '{"learnings":"- Apparel: Assign someone to handle team clothing/gear (e.g., with', cut: true },
      { body: '{"learnings":" a supplier chosen by March."}' },
    ])
    const out = await summariseWithContinuation({ ask, baseMessages: [], keys: KEYS, budgetMs: 280_000 })
    expect(out.result.learnings)
      .toBe('- Apparel: Assign someone to handle team clothing/gear (e.g., with a supplier chosen by March.')
    expect(out.truncated).toBe(false)
    expect(out.rounds).toBe(1)
    expect(calls).toHaveLength(2)
  })

  it('detects truncation from a REPAIRED payload even when the provider says stop', async () => {
    // The bug that started this: finish_reason said something other than
    // 'length', so nothing fired and a half-written note was saved.
    const { ask } = scripted([
      { body: '{"learnings":"cut here and the JSON never closed' },   // finishReason: 'stop'
      { body: '{"learnings":" — and this is the rest."}' },
    ])
    const out = await summariseWithContinuation({ ask, baseMessages: [], keys: KEYS, budgetMs: 280_000 })
    expect(out.rounds).toBe(1)
    expect(out.result.learnings).toContain('the rest')
    expect(out.truncated).toBe(false)
  })

  it('keeps asking, up to the cap, and then says it is still short', async () => {
    const { ask, calls } = scripted([{ body: '{"learnings":"never ends', cut: true }])
    const out = await summariseWithContinuation({ ask, baseMessages: [], keys: KEYS, budgetMs: 280_000 })
    expect(out.rounds).toBe(3)           // MAX_CONTINUATIONS
    expect(calls).toHaveLength(4)        // the first, plus three more
    expect(out.truncated).toBe(true)     // and it SAYS so rather than hiding it
  })

  it('does not start a round it cannot finish', async () => {
    // A call that overruns turns a short summary into a 504 and nothing at all,
    // which is the whole reason the ceiling exists.
    const { ask, calls } = scripted([{ body: '{"learnings":"cut', cut: true }])
    const out = await summariseWithContinuation({
      ask, baseMessages: [], keys: KEYS, budgetMs: 280_000,
      startedAt: Date.now() - 275_000,   // 5 s left
    })
    expect(calls).toHaveLength(1)
    expect(out.rounds).toBe(0)
    expect(out.truncated).toBe(true)
  })

  it('hands the model what it wrote, so it can carry on from it', async () => {
    const { ask, calls } = scripted([
      { body: '{"learnings":"first part', cut: true },
      { body: '{"learnings":" second part"}' },
    ])
    await summariseWithContinuation({ ask, baseMessages: [{ role: 'system', content: 'sys' }], keys: KEYS, budgetMs: 280_000 })
    const second = calls[1] as { role: string; content: string }[]
    expect(second[0].content).toBe('sys')                       // the original brief
    expect(second[1].role).toBe('assistant')
    expect(second[1].content).toContain('first part')           // …and what it wrote
    expect(second[2].content).toMatch(/CUT OFF/)
    expect(second[2].content).toMatch(/"learnings"/)            // which key to resume
  })

  it('fills a key the model never reached', async () => {
    // planning has two keys; running out inside `plan` means `timings` exists
    // only in the continuation.
    const { ask } = scripted([
      { body: '{"plan":"the plan, cut', cut: true },
      { body: '{"plan":" and its end.","timings":"0900 dock out"}' },
    ])
    const out = await summariseWithContinuation({ ask, baseMessages: [], keys: ['plan', 'timings'], budgetMs: 280_000 })
    expect(out.result.plan).toBe('the plan, cut and its end.')
    expect(out.result.timings).toBe('0900 dock out')
  })

  it('keeps the first reply when a continuation comes back unparseable', async () => {
    const { ask } = scripted([
      { body: '{"learnings":"worth keeping', cut: true },
      { body: 'sorry, I cannot do that' },
    ])
    const out = await summariseWithContinuation({ ask, baseMessages: [], keys: KEYS, budgetMs: 280_000 })
    expect(out.result.learnings).toBe('worth keeping')
    expect(out.truncated).toBe(true)
  })

  it('reports a failed first call rather than inventing a summary', async () => {
    const ask: Ask = async () => ({ ok: false, status: 502, text: 'upstream died' })
    const out = await summariseWithContinuation({ ask, baseMessages: [], keys: KEYS, budgetMs: 280_000 })
    expect(out.error).toEqual({ kind: 'call', status: 502, detail: 'upstream died' })
  })

  it('logs what it did, since the route is where this is diagnosed', async () => {
    const log = vi.fn()
    const { ask } = scripted([
      { body: '{"learnings":"cut', cut: true },
      { body: '{"learnings":" rest"}' },
    ])
    await summariseWithContinuation({ ask, baseMessages: [], keys: KEYS, budgetMs: 280_000, log })
    const said = log.mock.calls.flat().join(' ')
    expect(said).toContain('finish_reason')
    expect(said).toContain('continuing')
  })
})

describe('coerce / toResult — the model does not always return a string', () => {
  it('turns an array of bullets into markdown', () => {
    expect(coerce(['one', '- two'])).toBe('- one\n- two')
  })

  it('turns a nested object into labelled bullets', () => {
    expect(coerce({ upwind: 'fast', downwind: 'slow' })).toBe('- upwind: fast\n- downwind: slow')
  })

  it('matches a key however the model capitalised or spaced it', () => {
    expect(toResult({ 'Speed Learnings': 'x' }, ['speed_learnings']).speed_learnings).toBe('x')
    expect(toResult({ 'speed-learnings': 'x' }, ['speed_learnings']).speed_learnings).toBe('x')
  })

  it('gives an empty string for a key the model omitted', () => {
    expect(toResult({}, ['learnings']).learnings).toBe('')
  })
})
