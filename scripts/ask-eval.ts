// scripts/ask-eval.ts
// ─────────────────────────────────────────────────────────────────────────────
// Run the golden set against the real model and the real database.
//
//   npm run eval:ask                 every case
//   npm run eval:ask -- --id sailscan-by-name
//   npm run eval:ask -- --boat <id>  a boat other than the one it guesses
//
// The set (evals/ask/gold.jsonl) is seeded from ai_query_log — the questions
// people REALLY asked, including the ones that failed. That is the whole reason
// the log exists: a golden set invented up front tests the questions we imagined,
// and every case here is one somebody actually typed.
//
// It grades TOOL CHOICE AND ARGUMENTS, not prose (see lib/ai/askEval). Run it
// before and after any change to a tool description, the context pack or the
// rules — those are exactly the edits that feel harmless and silently move which
// tool gets picked.
//
// Needs .env.local (Supabase service key + the Scaleway key) and network, so it
// runs outside Claude Code's sandbox. It uses the SERVICE key deliberately: this
// is a harness measuring the model, not a user session, and RLS is tested
// elsewhere.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync } from 'fs'
import { resolve } from 'path'
import { createClient } from '@supabase/supabase-js'
import { chat, DEFAULT_ASK_MODEL, type ChatMessage, type ToolSpec } from '../src/lib/ai/scaleway'
import { runAsk } from '../src/lib/ai/askRun'
import { loadContext, makeExecutor, type AskDeps } from '../src/lib/ai/askData'
import { assessQuestion, riskNote } from '../src/lib/ai/askRisk'
import { gradeCase, summarise, formatSummary, type EvalOutcome, type GoldCase } from '../src/lib/ai/askEval'

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const fail = (m: string): never => { console.error(m); process.exit(1) }

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY
const KEY = process.env.SCALEWAY_AI_API_KEY
const BASE = process.env.SCALEWAY_AI_BASE_URL
const MODEL = process.env.SCALEWAY_AI_ASK_MODEL || process.env.SCALEWAY_AI_MODEL || DEFAULT_ASK_MODEL
if (!URL || !SERVICE) fail('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing — is .env.local loaded?')
if (!KEY || !BASE) fail('SCALEWAY_AI_API_KEY / SCALEWAY_AI_BASE_URL missing')

const supabase = createClient(URL!, SERVICE!, { auth: { persistSession: false } })

async function main() {
  const only = arg('id')
  const cases: GoldCase[] = readFileSync(resolve('evals/ask/gold.jsonl'), 'utf8')
    .split('\n').map(l => l.trim()).filter(Boolean).map(l => JSON.parse(l) as GoldCase)
    .filter(c => !only || c.id.includes(only))
  if (!cases.length) fail(only ? `no case matching "${only}"` : 'evals/ask/gold.jsonl is empty')

  // The boat with the most stored days — the one the questions were asked about.
  let boatId = arg('boat')
  let teamId = ''
  const { data: rows } = await supabase
    .from('session_phase_stats').select('team_id, boat_id, date').order('date', { ascending: false }).limit(500)
  const counts = new Map<string, { team: string; n: number }>()
  for (const r of (rows || []) as { team_id: string; boat_id: string }[]) {
    const c = counts.get(r.boat_id) || { team: r.team_id, n: 0 }
    c.n++; counts.set(r.boat_id, c)
  }
  const best = Array.from(counts.entries()).sort((a, b) => b[1].n - a[1].n)[0]
  if (!best) fail('no stored phase stats on any boat — nothing to evaluate against')
  const boat: string = boatId || best[0]
  teamId = counts.get(boat)?.team || best[1].team
  console.log(`model ${MODEL} · boat ${boat} · ${counts.get(boat)?.n ?? 0} stored days · ${cases.length} cases\n`)

  const { data: sessionDays } = await supabase
    .from('sessions').select('date, tz_offset_minutes').eq('team_id', teamId).eq('boat_id', boat)
  const tzByDate = new Map<string, number>(
    ((sessionDays || []) as { date: string; tz_offset_minutes: number | null }[])
      .map(s => [s.date, s.tz_offset_minutes ?? 0]))

  const results = []
  for (const c of cases) {
    const deps: AskDeps = { supabase, teamId, boatId: boat, openDate: c.date, tzByDate }
    let outcome: EvalOutcome
    const t0 = Date.now()
    try {
      const { ctx, prompt } = await loadContext(deps)
      const before = assessQuestion(c.question, ctx)
      if (before.level === 'high') {
        // The route declines here without spending a model call; the eval must
        // measure the same behaviour, not a different one with force set.
        outcome = { blocked: true, steps: [], lines: [], dropped: [], evidence: '' }
      } else {
        const note = riskNote(before)
        const run = await runAsk({
          question: c.question,
          context: note ? `${prompt}\n\n${note}` : prompt,
          openDate: c.date,
          extraNumbers: [c.date, ctx.dates, ctx.races, ctx.sailCombos],
          chat: (r: { messages: ChatMessage[]; tools?: ToolSpec[]; json?: boolean }) =>
            chat(r, { key: KEY!, base: BASE!, model: MODEL, timeoutMs: 30_000 }),
          execute: makeExecutor(deps),
        })
        if (!run.ok) {
          results.push({ id: c.id, pass: false, failures: [`the model call failed: ${run.error}`] })
          console.log(`  ✗ ${c.id} — ${run.error}`)
          continue
        }
        outcome = {
          steps: run.steps.map(s => ({ tool: s.tool, args: s.args as unknown as Record<string, unknown> })),
          lines: run.answer.lines,
          dropped: run.answer.dropped,
          evidence: JSON.stringify(run.steps.map(s => s.result)),
        }
      }
    } catch (e: unknown) {
      results.push({ id: c.id, pass: false, failures: [`threw: ${e instanceof Error ? e.message : String(e)}`] })
      console.log(`  ✗ ${c.id} — threw`)
      continue
    }
    const r = gradeCase(c, outcome)
    results.push(r)
    const took = `${((Date.now() - t0) / 1000).toFixed(1)}s`
    console.log(r.pass ? `  ✓ ${c.id}  ${took}` : `  ✗ ${c.id}  ${took}\n${r.failures.map(x => `      ${x}`).join('\n')}`)
  }

  const s = summarise(results)
  console.log(`\n${formatSummary(s)}`)
  // Non-zero on any failure, so this can gate a change without anyone reading it.
  process.exit(s.passed === s.total ? 0 : 1)
}

main().catch(e => fail(String(e?.stack || e)))
