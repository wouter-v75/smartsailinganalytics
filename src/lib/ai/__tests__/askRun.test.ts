import { describe, it, expect, vi } from 'vitest'
import { runAsk, MAX_ROUNDS } from '../askRun'
import type { ChatResult } from '../scaleway'
import type { ToolResult } from '../askTypes'
import type { ToolArgs, ToolName } from '../askTools'

// A model that says exactly what the script tells it to, turn by turn. The whole
// loop is testable because both the model and the executor are injected.
const scriptedModel = (turns: Partial<ChatResult>[]) => {
  let i = 0
  const calls: { tools: boolean; messages: unknown[] }[] = []
  const chat = async (req: { messages: unknown[]; tools?: unknown[] }) => {
    // A copy: runAsk keeps pushing onto the same array, so holding the reference
    // would mean every recorded turn shows the final state of the conversation.
    calls.push({ tools: !!req.tools?.length, messages: [...req.messages] })
    const t = turns[Math.min(i++, turns.length - 1)]
    return { ok: true, content: '', toolCalls: [], raw: {}, ms: 1, ...t } as ChatResult
  }
  return { chat, calls }
}

const table = (rows: (string | number | null)[][]) => ({
  title: 'VMG% by tack',
  columns: [
    { key: 'tack', label: 'Tack', group: true },
    { key: 'n', label: 'n' },
    { key: 'vmgPct', label: 'VMG%', unit: '%', decimals: 1 },
  ],
  rows,
})

const goodResult: ToolResult = { summary: '34 phases.', tables: [table([['Port', 18, 96.4], ['Stbd', 16, 99.1]])], media: [] }

const toolCall = (name: string, args: unknown, id = 'c1') =>
  ({ id, name, argumentsRaw: JSON.stringify(args) })

const base = { question: 'port or starboard upwind?', context: 'a day', openDate: '2026-09-11' }

describe('runAsk', () => {
  it('calls a tool, then writes an answer checked against what it returned', async () => {
    const model = scriptedModel([
      { toolCalls: [toolCall('compare_phases', { by: ['tack'], metrics: ['vmgPct'] })] },
      { content: '{"answer":["VMG% was 99.1 on starboard against 96.4 on port."],"bottomLine":[],"suggestions":[]}' },
    ])
    const execute = vi.fn(async () => goodResult)
    const r = await runAsk({ ...base, chat: model.chat, execute })

    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.steps).toHaveLength(1)
    expect(r.steps[0].tool).toBe('compare_phases')
    expect(r.answer.lines).toHaveLength(1)
    expect(r.usedTools).toBe(true)
    expect(execute).toHaveBeenCalledOnce()
  })

  it('attaches readable chips to every step', async () => {
    const model = scriptedModel([
      { toolCalls: [toolCall('compare_phases', { by: ['tack'], metrics: ['vmgPct'], modes: ['up'], twsMin: 14, twsMax: 18 })] },
      { content: '{"answer":[]}' },
    ])
    const r = await runAsk({ ...base, chat: model.chat, execute: async () => goodResult })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.steps[0].chips.join(' · ')).toContain('TWS 14–18 kn')
  })

  it('runs several tools from one turn — the numbers and the picture together', async () => {
    const model = scriptedModel([
      {
        toolCalls: [
          toolCall('compare_phases', { by: ['tack'], metrics: ['vmgPct'] }, 'a'),
          toolCall('find_media', { kinds: ['photo'], twsMin: 18 }, 'b'),
        ],
      },
      { content: '{"answer":["VMG% was 99.1 on starboard."]}' },
    ])
    const seen: ToolName[] = []
    const r = await runAsk({
      ...base, chat: model.chat,
      execute: async (name: ToolName) => { seen.push(name); return goodResult },
    })
    expect(r.ok).toBe(true)
    expect(seen).toEqual(['compare_phases', 'find_media'])
  })

  // A bad enum must cost a retry, not a 500 — the model can read the sentence.
  it('hands an invalid tool call back to the model instead of failing', async () => {
    const model = scriptedModel([
      { toolCalls: [toolCall('compare_phases', { by: ['tack'], metrics: ['speed'] })] },
      { toolCalls: [toolCall('compare_phases', { by: ['tack'], metrics: ['vmgPct'] }, 'c2')] },
      { content: '{"answer":["VMG% was 99.1 on starboard."]}' },
    ])
    const execute = vi.fn(async () => goodResult)
    const r = await runAsk({ ...base, chat: model.chat, execute })

    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(execute).toHaveBeenCalledOnce()          // only the valid one ran
    expect(r.steps).toHaveLength(1)
    const toolMessages = model.calls[1].messages.filter((m: any) => m.role === 'tool')
    expect(JSON.stringify(toolMessages)).toContain('speed')
  })

  it('turns a throwing executor into an unavailable note, not a crash', async () => {
    const model = scriptedModel([
      { toolCalls: [toolCall('compare_phases', { by: ['tack'], metrics: ['vmgPct'] })] },
      { content: '{"answer":["There is nothing stored for that day."]}' },
    ])
    const r = await runAsk({
      ...base, chat: model.chat,
      execute: async () => { throw new Error('no stored stats for this day') },
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.steps[0].result.unavailable).toContain('no stored stats')
  })

  it('drops the sentence when the model does its own arithmetic', async () => {
    const model = scriptedModel([
      { toolCalls: [toolCall('compare_phases', { by: ['tack'], metrics: ['vmgPct'] })] },
      { content: '{"answer":["VMG% was 99.1 on starboard.","Starboard was 2.7 points better."]}' },
    ])
    const r = await runAsk({ ...base, chat: model.chat, execute: async () => goodResult })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.answer.lines).toEqual(['VMG% was 99.1 on starboard.'])
    expect(r.answer.dropped).toEqual(['Starboard was 2.7 points better.'])
  })

  it('answers with suggestions and no tools when the question cannot be answered', async () => {
    const model = scriptedModel([
      { content: '' },
      { content: '{"answer":[],"suggestions":["Was VMG% better on port or starboard?","Which tacks cost the most?"]}' },
    ])
    const r = await runAsk({ ...base, chat: model.chat, execute: async () => goodResult })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.usedTools).toBe(false)
    expect(r.suggestions).toHaveLength(2)
  })

  it('never lets a tool URL into the prompt', async () => {
    const withMedia: ToolResult = {
      summary: '1 photo.', tables: [], media: [{
        kind: 'photo', id: 'p1', title: 'J4 2026', atLocal: '14:32', utc: 1, date: '2026-09-11',
        thumbUrl: 'https://cdn.example/secret-signed-thumb.jpg',
        fullUrl: 'https://cdn.example/secret-signed-full.jpg',
        conditions: 'TWS 21.4 kn', note: null,
      }],
    }
    const model = scriptedModel([
      { toolCalls: [toolCall('find_media', { kinds: ['photo'] })] },
      { content: '{"answer":["A photo at 14:32 shows TWS 21.4 kn."]}' },
    ])
    const r = await runAsk({ ...base, chat: model.chat, execute: async () => withMedia })
    expect(r.ok).toBe(true)
    const prompt = JSON.stringify(model.calls[1].messages)
    expect(prompt).not.toContain('secret-signed')
    expect(prompt).toContain('14:32')
  })

  it('stops after MAX_ROUNDS rather than looping on a model that will not stop', async () => {
    const model = scriptedModel([{ toolCalls: [toolCall('compare_phases', { by: ['tack'], metrics: ['vmgPct'] })] }])
    const execute = vi.fn(async () => goodResult)
    const r = await runAsk({ ...base, chat: model.chat, execute })
    expect(r.ok).toBe(true)
    expect(execute.mock.calls.length).toBeLessThanOrEqual(MAX_ROUNDS)
  })

  it('stops starting new rounds once the time budget is gone', async () => {
    const execute = vi.fn(async () => goodResult)
    let first = true
    const chat = async () => {
      if (first) { first = false; return { ok: true, content: '', toolCalls: [toolCall('compare_phases', { by: ['tack'], metrics: ['vmgPct'] })], raw: {}, ms: 1 } as ChatResult }
      return { ok: true, content: '{"answer":[]}', toolCalls: [], raw: {}, ms: 1 } as ChatResult
    }
    const r = await runAsk({ ...base, chat, execute, budgetMs: -1 })
    expect(r.ok).toBe(true)
    expect(execute).not.toHaveBeenCalled()
  })

  it('passes a model failure straight through', async () => {
    const chat = async () => ({ ok: false, status: 504, error: 'aborted', ms: 1 }) as ChatResult
    const r = await runAsk({ ...base, chat, execute: async () => goodResult })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.status).toBe(504)
  })

  it('carries earlier turns so a follow-up knows what was just said', async () => {
    const model = scriptedModel([{ content: '' }, { content: '{"answer":[]}' }])
    await runAsk({
      ...base, chat: model.chat, execute: async () => goodResult,
      history: [{ question: 'and downwind?', answer: 'VMG% was 101.2.' }],
    })
    const roles = (model.calls[0].messages as { role: string }[]).map(m => m.role)
    expect(roles).toEqual(['system', 'user', 'assistant', 'user'])
  })
})

// Kept honest about the arguments the executor receives: they are the VALIDATED
// ones, never the raw JSON the model wrote.
describe('what reaches the executor', () => {
  it('is the validated arguments, with the defaults filled in', async () => {
    const model = scriptedModel([
      { toolCalls: [toolCall('compare_phases', { by: ['tack', 'tack'], metrics: ['vmgPct'], minPhases: 999 })] },
      { content: '{"answer":[]}' },
    ])
    let got: ToolArgs | null = null
    await runAsk({ ...base, chat: model.chat, execute: async (_n, a) => { got = a; return goodResult } })
    expect(got).toMatchObject({ by: ['tack'], metrics: ['vmgPct'], minPhases: 50 })
  })
})
