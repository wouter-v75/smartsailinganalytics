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
    // Punctuated, because that is what a finished note looks like — and since
    // the mid-sentence signal, it is also what "finished" MEANS to this loop.
    const { ask, calls } = scripted([{ body: '{"learnings":"all of it."}' }])
    const out = await summariseWithContinuation({ ask, baseMessages: [], keys: KEYS, budgetMs: 280_000 })
    expect(out.result.learnings).toBe('all of it.')
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
      { body: '{"learnings":" second part."}' },
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
      { body: '{"plan":" and its end.","timings":"0900 dock out."}' },
    ])
    const out = await summariseWithContinuation({ ask, baseMessages: [], keys: ['plan', 'timings'], budgetMs: 280_000 })
    expect(out.result.plan).toBe('the plan, cut and its end.')
    expect(out.result.timings).toBe('0900 dock out.')
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

// ─────────────────────────────────────────────────────────────────────────────
// Ryujin, 7 Nov 2026. 17:52 of audio, a complete 13,870-character transcript,
// and 1,151 characters saved as a whole note, ending "…allowed for a quick ".
//
// Mistral returned a VALID, CLOSED JSON object and reported
// `finish_reason: "stop"`. So `repaired` was false and `stoppedCleanly` was
// true: both of the loop's signals said finished, no continuation ran, and no
// warning was shown. Re-running it stops in the SAME sentence, so it is
// reproducible and the metadata is simply wrong.
//
// The content is the only witness left, and these pin it down.
// ─────────────────────────────────────────────────────────────────────────────
describe('summariseWithContinuation · the reply that stops mid-sentence and says it did not', () => {
  it('continues anyway when the text ends mid-sentence', async () => {
    const { ask, calls } = scripted([
      // Closed JSON, finish_reason 'stop' — and unfinished all the same.
      { body: '{"learnings":"- Packing the A1.5: tack zipped first, head optional, which allowed for a quick "}' },
      { body: '{"learnings":"hoist out of the bag."}' },
    ])
    const out = await summariseWithContinuation({ ask, baseMessages: [], keys: KEYS, budgetMs: 280_000 })

    expect(calls).toHaveLength(2)
    expect(out.rounds).toBe(1)
    expect(out.result.learnings).toContain('hoist out of the bag.')
    expect(out.truncated).toBe(false)
  })

  it('says WHICH signal fired, because the three need different next steps', async () => {
    const { ask } = scripted([
      { body: '{"learnings":"stops here and nobody admits it"}' },
      { body: '{"learnings":"never finishes either"}' },
    ])
    const out = await summariseWithContinuation({ ask, baseMessages: [], keys: KEYS, budgetMs: 280_000 })

    expect(out.signals.midSentence).toBe(true)
    expect(out.signals.repaired).toBe(false)
    expect(out.signals.finishReason).toBe(false)
    expect(out.truncated).toBe(true)
  })

  it('leaves a properly finished note alone, and pays for nothing', async () => {
    const { ask, calls } = scripted([
      { body: '{"learnings":"**Overall**\n- Strong day for the deck team.\n- Best sailing so far."}' },
    ])
    const out = await summariseWithContinuation({ ask, baseMessages: [], keys: KEYS, budgetMs: 280_000 })

    expect(calls).toHaveLength(1)
    expect(out.rounds).toBe(0)
    expect(out.truncated).toBe(false)
    expect(out.signals).toEqual({ repaired: false, finishReason: false, midSentence: false })
  })

  it('re-tests the MERGED text, not just the latest reply', async () => {
    // The second reply is itself a complete JSON string ending in a full stop,
    // but what matters is whether the NOTE is finished once joined on.
    const { ask } = scripted([
      { body: '{"learnings":"first, cut"}' },
      { body: '{"learnings":" and the rest."}' },
    ])
    const out = await summariseWithContinuation({ ask, baseMessages: [], keys: KEYS, budgetMs: 280_000 })
    expect(out.result.learnings).toBe('first, cut and the rest.')
    expect(out.signals.midSentence).toBe(false)
    expect(out.rounds).toBe(1)
  })

  it('stops after a round that adds nothing, rather than spending the budget', async () => {
    // The bound on a false positive: a note that genuinely ends without a full
    // stop costs ONE extra call, not three.
    const { ask, calls } = scripted([
      { body: '{"learnings":"- Everyone: take notes"}' },
      { body: '{"learnings":""}' },
    ])
    const out = await summariseWithContinuation({ ask, baseMessages: [], keys: KEYS, budgetMs: 280_000 })
    expect(calls).toHaveLength(2)
    expect(out.rounds).toBe(1)
    expect(out.result.learnings).toBe('- Everyone: take notes')
  })

  it('tests the key that was being WRITTEN, not the first one', async () => {
    // planning has two keys. `plan` finished cleanly; `timings` is the one that
    // stopped, and testing `plan` would report the note as complete.
    const { ask } = scripted([
      { body: '{"plan":"Sail the plan.","timings":"0900 dock out, warning signal at"}' },
      { body: '{"timings":" 1055."}' },
    ])
    const out = await summariseWithContinuation({ ask, baseMessages: [], keys: ['plan', 'timings'], budgetMs: 280_000 })
    expect(out.rounds).toBe(1)
    expect(out.result.timings).toBe('0900 dock out, warning signal at 1055.')
    expect(out.result.plan).toBe('Sail the plan.')
  })
})

describe('summariseWithContinuation · contentSignal', () => {
  it('a dictated note that ends without a full stop costs nothing extra', async () => {
    // `note` mode is one tidied line in the speaker's own words. "- Check the
    // jib lead" is finished. Firing the mid-sentence signal here would buy a
    // round trip on a phone, on the dock, to guard against a 40-second
    // recording exhausting an 8,000-token ceiling.
    const { ask, calls } = scripted([{ body: '{"note":"- Check the jib lead"}' }])
    const out = await summariseWithContinuation({
      ask, baseMessages: [], keys: ['note'], budgetMs: 280_000, contentSignal: false,
    })
    expect(calls).toHaveLength(1)
    expect(out.truncated).toBe(false)
    expect(out.signals.midSentence).toBe(false)
    expect(out.result.note).toBe('- Check the jib lead')
  })

  it('but the provider saying it cut off still counts, whatever the mode', async () => {
    // Turning the CONTENT signal off must not turn the other two off with it.
    const { ask } = scripted([
      { body: '{"note":"half a note', cut: true },
      { body: '{"note":" and the other half."}' },
    ])
    const out = await summariseWithContinuation({
      ask, baseMessages: [], keys: ['note'], budgetMs: 280_000, contentSignal: false,
    })
    expect(out.rounds).toBe(1)
    expect(out.result.note).toBe('half a note and the other half.')
  })

  it('is on by default, so a caller that forgets gets the protection', async () => {
    const { ask, calls } = scripted([
      { body: '{"learnings":"stops dead"}' },
      { body: '{"learnings":" right here."}' },
    ])
    const out = await summariseWithContinuation({ ask, baseMessages: [], keys: KEYS, budgetMs: 280_000 })
    expect(calls).toHaveLength(2)
    expect(out.result.learnings).toBe('stops dead right here.')
  })
})
