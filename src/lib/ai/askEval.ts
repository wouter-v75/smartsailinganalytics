// src/lib/ai/askEval.ts
// ─────────────────────────────────────────────────────────────────────────────
// Grading one Ask answer against a golden case. Pure — the runner
// (scripts/ask-eval.ts) does the network and Supabase, this does the judging, so
// the judging itself is under test.
//
// It grades the TOOL CALL, not the prose. That is deliberate and it is the
// finding the whole feature is built on: a weak model produced 44 % executable
// requests and only 17 % correct ones, because "endpoint choice, target
// grounding and temporal filtering can all be subtly wrong even when the payload
// passes validation" (arXiv 2605.21027 §5). Which tool ran, over which dates,
// with which filter, IS the answer's correctness. The sentence on top is checked
// separately and mechanically — it must carry numbers, and none that the tools
// did not produce.
//
// No LLM-as-judge here. A grader that hallucinates gives a pass rate that means
// nothing, and every check below can be made exactly.
// ─────────────────────────────────────────────────────────────────────────────

import type { ToolName } from './askTools'

export interface GoldCase {
  id: string
  question: string
  /** The day open on screen when it is asked. */
  date: string
  why?: string
  expect: {
    /** Tools that MUST have been called. */
    tools?: ToolName[]
    /** Tools that must NOT — the wrong-tool failures worth pinning. */
    notTools?: ToolName[]
    /** Argument values a named tool's call must carry. Arrays match as subsets. */
    args?: Partial<Record<ToolName, Record<string, unknown>>>
    /** The call must span more than one day — how "the season" is checked. */
    multiDay?: boolean
    /** It must decline rather than answer. */
    blocked?: boolean
    minLines?: number
    /** Sentences dropped by the number check. Defaults to 0. */
    maxDropped?: number
    /** Every one of these must appear in some table, chart or media item. */
    mentions?: string[]
  }
}

export interface EvalOutcome {
  blocked?: boolean
  steps: { tool: ToolName; args: Record<string, unknown> }[]
  lines: string[]
  dropped: string[]
  /** Flattened text of everything the tools returned — for `mentions`. */
  evidence: string
}

export interface CaseResult {
  id: string
  pass: boolean
  failures: string[]
}

const subsetOf = (want: unknown, got: unknown): boolean => {
  if (Array.isArray(want)) {
    if (!Array.isArray(got)) return false
    return want.every(w => got.some(g => String(g) === String(w)))
  }
  return String(want) === String(got)
}

export function gradeCase(gold: GoldCase, out: EvalOutcome): CaseResult {
  const f: string[] = []
  const e = gold.expect
  const called = out.steps.map(s => s.tool)

  if (e.blocked && !out.blocked) f.push('should have declined, but answered')
  if (!e.blocked && out.blocked) f.push('declined, but should have answered')

  for (const t of e.tools || []) {
    if (!called.includes(t)) f.push(`did not call ${t} (called ${called.join(', ') || 'nothing'})`)
  }
  for (const t of e.notTools || []) {
    if (called.includes(t)) f.push(`called ${t}, which is the wrong tool here`)
  }

  for (const [tool, want] of Object.entries(e.args || {})) {
    const calls = out.steps.filter(s => s.tool === tool)
    if (!calls.length) continue    // already reported by the tools check
    // Any ONE call of that tool must satisfy all of it — a question may legitimately
    // call the same tool twice, and only one of them has to be the one asked about.
    const ok = calls.some(c => Object.entries(want).every(([k, v]) => subsetOf(v, c.args[k])))
    if (!ok) {
      f.push(`${tool} args wrong: wanted ${JSON.stringify(want)}, got ${calls.map(c => JSON.stringify(c.args)).join(' | ')}`)
    }
  }

  if (e.multiDay) {
    const spans = out.steps.some(s => {
      const from = s.args.dateFrom, to = s.args.dateTo
      return typeof from === 'string' && typeof to === 'string' && from < to
    })
    if (!spans) f.push('no call spanned more than one day, so "the season" was read as one')
  }

  if (!out.blocked) {
    const min = e.minLines ?? 1
    if (out.lines.length < min) f.push(`${out.lines.length} answer lines, wanted at least ${min}`)
  }
  const maxDropped = e.maxDropped ?? 0
  if (out.dropped.length > maxDropped) {
    f.push(`${out.dropped.length} sentences dropped by the number check: ${out.dropped.join(' / ')}`)
  }

  for (const m of e.mentions || []) {
    if (!out.evidence.toLowerCase().includes(m.toLowerCase())) f.push(`nothing in the evidence mentions "${m}"`)
  }

  return { id: gold.id, pass: f.length === 0, failures: f }
}

export interface EvalSummary {
  total: number
  passed: number
  results: CaseResult[]
}

export const summarise = (results: CaseResult[]): EvalSummary =>
  ({ total: results.length, passed: results.filter(r => r.pass).length, results })

/** One line per case, and the reasons under the ones that failed. */
export function formatSummary(s: EvalSummary): string {
  const lines = s.results.map(r =>
    r.pass ? `  ✓ ${r.id}` : [`  ✗ ${r.id}`, ...r.failures.map(x => `      ${x}`)].join('\n'))
  return [...lines, '', `${s.passed}/${s.total} passed`].join('\n')
}
