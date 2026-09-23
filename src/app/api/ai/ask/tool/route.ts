// Re-run ONE tool with edited search tokens. No model, no key, no inference.
//
//   POST { teamId, boatId, date, tool, args, edit?: { path, value } }
//     → { tokens, summary, tables, charts, media, unavailable }
//
// This is the half of ThoughtSpot's search tokens that matters: they are
// editable. When the model reads "in the breeze" as 14–18 kn and you meant over
// 20, dragging one number is a better tool than retyping the question and hoping
// for a different reading of it.
//
// It is deliberately deterministic. The same arguments always give the same
// table, so an edit is an adjustment rather than a fresh roll of the dice — and
// the written answer stays attached to the question that produced it, which is
// why the UI marks the prose as belonging to the original query once you edit.
//
// The edit goes through validate() exactly as the model's arguments did: a person
// cannot steer a tool anywhere the model could not.

import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase, authedUserId } from '../../../../../lib/supabase/server'
import { makeExecutor, type AskDeps } from '../../../../../lib/ai/askData'
import { applyTokenEdit, tokensFor, validate, TOOL_NAMES, type ToolArgs, type ToolName } from '../../../../../lib/ai/askTools'
import { chartsFor } from '../../../../../lib/ai/askCharts'
import { rolePermissions } from '../../../../../lib/rolePermissions'

export const maxDuration = 30
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const supabase = getServerSupabase()
  const uid = await authedUserId(supabase)
  if (!uid) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const body = await req.json().catch(() => ({})) as {
    teamId?: string; boatId?: string; date?: string
    tool?: string; args?: ToolArgs; edit?: { path?: string; value?: unknown }
  }
  const { teamId, boatId, date } = body
  if (!teamId || !boatId || !date) return NextResponse.json({ error: 'teamId, boatId and date are required' }, { status: 400 })
  if (!body.tool || !(TOOL_NAMES as string[]).includes(body.tool)) {
    return NextResponse.json({ error: 'unknown tool' }, { status: 400 })
  }
  const tool = body.tool as ToolName

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

  // Re-validate what came back from the browser, then apply the edit and validate
  // again — neither the model's arguments nor a person's edit skips the gate.
  const base = validate(tool, JSON.stringify(body.args ?? {}))
  if (!base.ok) return NextResponse.json({ error: base.error }, { status: 400 })
  const next = body.edit?.path
    ? applyTokenEdit(base.name, base.args, body.edit.path, body.edit.value)
    : base
  if (!next.ok) return NextResponse.json({ error: next.error }, { status: 400 })

  const { data: sessionDays } = await supabase
    .from('sessions').select('date, tz_offset_minutes')
    .eq('team_id', teamId).eq('boat_id', boatId)
  const tzByDate = new Map<string, number>(
    ((sessionDays || []) as { date: string; tz_offset_minutes: number | null }[])
      .map(s => [s.date, s.tz_offset_minutes ?? 0]))

  const deps: AskDeps = { supabase, teamId, boatId, openDate: date, tzByDate }
  try {
    const result = await makeExecutor(deps)(next.name, next.args)
    return NextResponse.json({
      tool: next.name,
      args: next.args,
      tokens: tokensFor(next.name, next.args, date),
      summary: result.summary,
      unavailable: result.unavailable ?? null,
      tables: result.tables,
      charts: result.charts ?? result.tables.flatMap(t => chartsFor(t, { time: next.name === 'day_timeseries' })),
      media: result.media,
    })
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'the tool failed' }, { status: 500 })
  }
}
