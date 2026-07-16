// Numerical data analysis — verbal questions + reasoning over a team's own
// performance data, answered by Mistral (Scaleway Generative APIs).
//
// SANDBOX MODEL (why this is safe against cross-team leakage):
//   1. The model never touches the database and never writes SQL.
//   2. We fetch the context server-side through getServerSupabase(), which uses
//      the caller's session cookie — so Row-Level Security applies. A user only
//      ever pulls rows their team/boat access allows (has_boat_access). The
//      model is strictly downstream of RLS.
//   3. Only that already-authorised, bounded slice is sent to Scaleway. Nothing
//      is persisted there (synchronous call, EU-only, no training).
//
//   GET                       → health check { configured, model, baseUrl }
//   POST { teamId, question, boatId? }
//                             → { answer, figuresUsed[], caveats[], _usage, _ms }
import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '../../../../lib/supabase/server'
import { aiConfig, aiConfigured, mistralJSON, AiError } from '../../../../lib/ai/mistral'
import { ANALYZE_SYSTEM, ANALYZE_FEWSHOT, analyzeUserContent } from '../../../../lib/ai/analyzePrompt'

export const maxDuration = 60
export const dynamic = 'force-dynamic'

// Bound the context we send so token cost stays predictable and small.
const MAX_ROWS = 40

export async function GET() {
  return NextResponse.json(aiConfig())
}

export async function POST(req: NextRequest) {
  const t0 = Date.now()
  if (!aiConfigured()) {
    return NextResponse.json({ error: 'SCALEWAY_AI_API_KEY not configured' }, { status: 503 })
  }

  const supabase = getServerSupabase()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const body = await req.json().catch(() => null)
  const teamId: string | undefined = body?.teamId
  const question: string | undefined = body?.question?.trim()
  const boatId: string | undefined = body?.boatId
  if (!teamId || !question) {
    return NextResponse.json({ error: 'teamId and question required' }, { status: 400 })
  }

  // ── Gather RLS-scoped context. Every query below is filtered by the caller's
  // access via RLS; team_id/boat_id filters just narrow within that. ──────────
  const datasetsQ = supabase
    .from('datasets')
    .select('id,kind,metrics,window_start_utc,run_id,boat_id,created_at')
    .eq('team_id', teamId)
    .order('created_at', { ascending: false })
    .limit(MAX_ROWS)
  const configsQ = supabase
    .from('configs')
    .select('id,run_id,sail_config,keel_cant_deg,rudder_toe_deg,rake_mm,forestay_mm,settings,notes,created_at')
    .eq('team_id', teamId)
    .order('created_at', { ascending: false })
    .limit(MAX_ROWS)
  const polarsQ = supabase
    .from('polars')
    .select('id,boat_id,name,source,is_active,valid_from')
    .eq('team_id', teamId)
    .eq('is_active', true)
    .limit(10)

  const [dsRes, cfgRes, polRes] = await Promise.all([
    boatId ? datasetsQ.eq('boat_id', boatId) : datasetsQ,
    boatId ? configsQ.eq('boat_id', boatId) : configsQ,
    boatId ? polarsQ.eq('boat_id', boatId) : polarsQ,
  ])

  const firstErr = dsRes.error || cfgRes.error || polRes.error
  if (firstErr) return NextResponse.json({ error: firstErr.message }, { status: 500 })

  const datasets = dsRes.data || []
  const configs = cfgRes.data || []
  const polars = polRes.data || []

  if (!datasets.length && !configs.length) {
    return NextResponse.json({
      answer: 'No performance data is available for this team/boat (or you do not have access to it), so there is nothing to analyse yet.',
      figuresUsed: [],
      caveats: ['No datasets or configs were returned under your access.'],
      logId: null,
      _ms: Date.now() - t0,
    })
  }

  const context = {
    truncated: {
      datasets: datasets.length >= MAX_ROWS,
      configs: configs.length >= MAX_ROWS,
    },
    datasets,
    configs,
    polars,
  }

  try {
    const { data, usage } = await mistralJSON<{ answer: string; figuresUsed: string[]; caveats: string[] }>({
      system: ANALYZE_SYSTEM,
      examples: ANALYZE_FEWSHOT,
      user: analyzeUserContent(question, context),
      maxTokens: 1500,
    })

    // Log the exchange for the feedback + eval loop. Best-effort: RLS lets a user
    // insert only their own row, for a team they belong to. We store a lean
    // context_summary (counts + ids), NOT the raw rows. Never fail the answer if
    // logging fails.
    let logId: string | null = null
    try {
      const { data: logRow } = await supabase
        .from('ai_query_log')
        .insert({
          team_id: teamId,
          boat_id: boatId ?? null,
          user_id: user.id,
          route: 'analyze',
          model: aiConfig().model,
          question,
          answer: data,
          context_summary: {
            datasets: datasets.length,
            configs: configs.length,
            polars: polars.length,
            truncated: context.truncated,
            boat_id: boatId ?? null,
            dataset_ids: datasets.map((d: { id: string }) => d.id),
            config_ids: configs.map((c: { id: string }) => c.id),
          },
          input_tokens: usage?.input ?? null,
          output_tokens: usage?.output ?? null,
          latency_ms: Date.now() - t0,
        })
        .select('id')
        .single()
      logId = logRow?.id ?? null
    } catch { /* logging is best-effort — never block the answer on it */ }

    return NextResponse.json({ ...data, logId, _usage: usage, _ms: Date.now() - t0 })
  } catch (e) {
    const status = e instanceof AiError ? e.status : 500
    const message = e instanceof Error ? e.message : 'analysis failed'
    return NextResponse.json({ error: message, _ms: Date.now() - t0 }, { status })
  }
}
