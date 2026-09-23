// Ask the data — one question from the Analysis tab, answered from the boat's own
// numbers by Mistral on Scaleway (EU). All inference stays inside the Scaleway
// account, like /api/ai/debrief-summary and …/phase-stats/:date/headlines.
//
//   POST { teamId, boatId, date, question, history?, force? }
//     → 200 { answer, steps, suggestions, risk, needsStats, model, ms, logId }
//     → 200 { blocked: true, risk }   the question would be answered by inventing;
//                                     the caller confirms with force: true
//     → 401 / 403 / 503
//
// The shape of the thing (docs/ai-query-analysis-2026-09.md):
//   • The model picks a TOOL and fills arguments. It never writes analysis, never
//     touches a clock, never sees a URL.
//   • lib/ai/askData runs the tool against the CLOUD through the user's own
//     session, so RLS decides what each person may ask about — this route never
//     uses the service key.
//   • Every number in the prose is checked against the tool output and an
//     unsupported sentence is dropped, the same guard headlines already has.
//   • Nothing here writes to the day's data. It reads, and it appends one row to
//     ai_query_log.
//
// Env: SCALEWAY_AI_API_KEY, SCALEWAY_AI_BASE_URL, SCALEWAY_AI_ASK_MODEL
// (default mistral-medium-3.5-128b — swap the env var to upgrade the model).

import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase, authedUserId } from '../../../../lib/supabase/server'
import { chat, DEFAULT_ASK_MODEL, type ChatMessage, type ToolSpec } from '../../../../lib/ai/scaleway'
import { runAsk } from '../../../../lib/ai/askRun'
import { loadContext, makeExecutor, type AskDeps } from '../../../../lib/ai/askData'
import { assessQuestion, assessAnswer, riskNote } from '../../../../lib/ai/askRisk'
import { chartsFor } from '../../../../lib/ai/askCharts'
import { tokensFor } from '../../../../lib/ai/askTools'
import { rolePermissions } from '../../../../lib/rolePermissions'

export const maxDuration = 60
export const dynamic = 'force-dynamic'

const KEY = process.env.SCALEWAY_AI_API_KEY
const BASE = process.env.SCALEWAY_AI_BASE_URL
const MODEL = process.env.SCALEWAY_AI_ASK_MODEL || process.env.SCALEWAY_AI_MODEL || DEFAULT_ASK_MODEL

const MAX_QUESTION = 500
const log = (...a: unknown[]) => { try { console.info('[ai/ask]', ...a) } catch { /* */ } }

export async function POST(req: NextRequest) {
  if (!KEY || !BASE) {
    return NextResponse.json({ error: 'SCALEWAY_AI_API_KEY / SCALEWAY_AI_BASE_URL not configured' }, { status: 503 })
  }
  const supabase = getServerSupabase()
  const uid = await authedUserId(supabase)
  if (!uid) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const body = await req.json().catch(() => ({})) as {
    teamId?: string; boatId?: string; date?: string; question?: string
    history?: { question: string; answer: string }[]; force?: boolean
  }
  const teamId = body.teamId, boatId = body.boatId, date = body.date
  const question = (body.question || '').trim().slice(0, MAX_QUESTION)
  if (!teamId || !boatId || !date) return NextResponse.json({ error: 'teamId, boatId and date are required' }, { status: 400 })
  if (!question) return NextResponse.json({ error: 'ask a question' }, { status: 400 })

  // The UI hides the box for roles without AI; a hidden control is not a boundary,
  // so the role is checked here too. RLS then decides what the tools can read.
  const [{ data: membership }, { data: me }] = await Promise.all([
    supabase.from('memberships').select('role').eq('team_id', teamId).eq('user_id', uid).maybeSingle(),
    supabase.from('users').select('global_role').eq('id', uid).maybeSingle(),
  ])
  const role = (me as { global_role?: string } | null)?.global_role === 'admin'
    ? 'admin'
    : (membership as { role?: string } | null)?.role || null
  if (!role) return NextResponse.json({ error: 'no access to this team' }, { status: 403 })
  if (!rolePermissions(role).canUseAI) {
    return NextResponse.json({ error: 'your role does not include the AI tools' }, { status: 403 })
  }

  // Venue offsets for every day of this boat, so no timestamp is ever read as UTC.
  const { data: sessionDays } = await supabase
    .from('sessions').select('date, tz_offset_minutes')
    .eq('team_id', teamId).eq('boat_id', boatId)
  const tzByDate = new Map<string, number>(
    ((sessionDays || []) as { date: string; tz_offset_minutes: number | null }[])
      .map(s => [s.date, s.tz_offset_minutes ?? 0]))

  const deps: AskDeps = { supabase, teamId, boatId, openDate: date, tzByDate }

  let ctx, contextPrompt: string
  try {
    const loaded = await loadContext(deps)
    ctx = loaded.ctx
    contextPrompt = loaded.prompt
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'could not read this boat'
    // The table not being there yet is a migration story, not a failure the crew caused.
    const needsMigration = /ai_query_log|does not exist|schema cache/i.test(msg)
    return NextResponse.json({ error: msg, ...(needsMigration ? { needsMigration: true } : {}) }, { status: 500 })
  }

  const before = assessQuestion(question, ctx)
  const needsStats = ctx.phaseCount === 0

  // High risk means the answer would have to be invented. Say so and offer the
  // questions this data CAN answer, rather than spending a model call on it.
  if (before.level === 'high' && !body.force) {
    log('blocked', before.findings.map(f => f.code).join(','), '·', question.slice(0, 80))
    return NextResponse.json({
      blocked: true,
      risk: { level: before.level, before: before.findings, after: [], narrower: before.narrower },
      needsStats,
    })
  }

  const note = riskNote(before)
  const run = await runAsk({
    question,
    context: note ? `${contextPrompt}\n\n${note}` : contextPrompt,
    history: (body.history || []).slice(-3),
    openDate: date,
    // The dates in scope are legitimate numbers even though no tool returned them.
    extraNumbers: [date, ctx.dates, ctx.races, ctx.sailCombos],
    chat: (r: { messages: ChatMessage[]; tools?: ToolSpec[]; json?: boolean }) =>
      chat(r, { key: KEY!, base: BASE!, model: MODEL, timeoutMs: 25_000 }),
    execute: makeExecutor(deps),
  })
  if (!run.ok) {
    log('failed', run.status, run.error)
    return NextResponse.json({ error: run.error, ms: run.ms }, { status: run.status })
  }

  const after = assessAnswer(run.steps, run.answer)
  const level = before.level !== 'ok' || after.length ? (before.level === 'high' ? 'high' : 'caution') : 'ok'

  const steps = run.steps.map(s => ({
    tool: s.tool,
    args: s.args,
    tokens: tokensFor(s.tool, s.args, date),
    summary: s.result.summary,
    unavailable: s.result.unavailable ?? null,
    tables: s.result.tables,
    charts: s.result.charts ?? s.result.tables.flatMap(t => chartsFor(t, { time: s.tool === 'day_timeseries' })),
    media: s.result.media,
  }))

  log('ok', run.ms, 'ms ·', run.steps.map(s => s.tool).join('+') || 'no tools',
    '·', run.answer.lines.length, 'lines,', run.answer.dropped.length, 'dropped')

  // The log is the eval set for this feature: the questions people really ask.
  // A failure to write one must never lose the answer they are waiting for.
  let logId: string | null = null
  try {
    const { data: row } = await supabase.from('ai_query_log').insert({
      team_id: teamId, boat_id: boatId, session_date: date, user_id: uid,
      question,
      answer: { ...run.answer, suggestions: run.suggestions },
      steps: run.steps.map(s => ({
        tool: s.tool, args: s.args, tokens: s.chips,
        rows: s.result.tables.reduce((a, t) => a + t.rows.length, 0),
        media: s.result.media.length,
        unavailable: s.result.unavailable ?? null,
      })),
      risk: { level, before: before.findings, after },
      model: MODEL, latency_ms: run.ms, used_tools: run.usedTools,
    }).select('id').maybeSingle()
    logId = (row as { id?: string } | null)?.id || null
  } catch { /* the answer matters more than the record of it */ }

  return NextResponse.json({
    answer: run.answer,
    steps,
    suggestions: run.suggestions,
    risk: { level, before: before.findings, after, narrower: before.narrower },
    needsStats,
    model: MODEL,
    ms: run.ms,
    logId,
  })
}
