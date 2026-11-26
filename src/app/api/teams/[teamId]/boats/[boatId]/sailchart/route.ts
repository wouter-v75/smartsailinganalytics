// A boat's sail crossover chart (0106).
//
//   GET          → { chart, updatedAt }   (an empty chart when none is stored)
//   PUT { chart } → upsert → { chart, updatedAt }
//
// RLS is the authority on who may write; this route makes sure what lands is a
// chart, through the same normaliser the editor uses.

import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase/server'
import { EMPTY_CHART, normaliseSailChart } from '@/lib/sailchart/model'

type Params = { params: { teamId: string; boatId: string } }

const missingTable = (msg: string) => /boat_sailcharts/.test(msg) && /does not exist|schema cache/i.test(msg)

export async function GET(_req: NextRequest, { params }: Params) {
  const supabase = getServerSupabase()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const { data, error } = await supabase
    .from('boat_sailcharts')
    .select('chart, updated_at')
    .eq('team_id', params.teamId)
    .eq('boat_id', params.boatId)
    .maybeSingle()

  if (error) {
    return NextResponse.json(
      { error: missingTable(error.message) ? 'The sail chart table is not there yet — paste migration 0106 into the Supabase SQL editor.' : error.message },
      { status: 500 },
    )
  }
  return NextResponse.json({
    chart: data ? normaliseSailChart(data.chart) : EMPTY_CHART,
    updatedAt: (data?.updated_at as string | null) ?? null,
  })
}

export async function PUT(req: NextRequest, { params }: Params) {
  const supabase = getServerSupabase()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const body = (await req.json().catch(() => null)) as { chart?: unknown } | null
  const chart = normaliseSailChart(body?.chart)

  const { data, error } = await supabase
    .from('boat_sailcharts')
    .upsert(
      { team_id: params.teamId, boat_id: params.boatId, chart, updated_by_user_id: user.id },
      { onConflict: 'team_id,boat_id' },
    )
    .select('chart, updated_at')
    .single()

  if (error) {
    const denied = /row-level security|permission denied/i.test(error.message)
    return NextResponse.json(
      {
        error: denied
          ? 'You do not have permission to edit this boat’s sail chart (coach, TL3 or team manager).'
          : missingTable(error.message)
            ? 'The sail chart table is not there yet — paste migration 0106 into the Supabase SQL editor.'
            : error.message,
      },
      { status: denied ? 403 : 500 },
    )
  }
  return NextResponse.json({
    chart: normaliseSailChart(data?.chart),
    updatedAt: (data?.updated_at as string | null) ?? null,
  })
}
