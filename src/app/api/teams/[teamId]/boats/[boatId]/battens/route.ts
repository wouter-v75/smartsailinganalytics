// The boat's batten card — what the battens SHOULD be, per batten, per wind
// band. See supabase/migrations/0064_boat_battens.sql for why it is one JSONB
// document per boat rather than a row per cell.
//
//   GET                → { card, updatedAt }
//   PUT  { card }      → upsert the whole grid → { card, updatedAt }
//
// The whole grid every time, deliberately: it is edited as a grid, and a
// half-applied diff is a card that is wrong in the boat.
//
// RLS (0064) is the authority on who may write. This route's job is to make sure
// what lands is a card — normaliseBattenCard is the same function the UI uses, so
// the client and the server cannot disagree about what a blank cell is.

import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase/server'
import { normaliseBattenCard, defaultBattenCard } from '@/lib/battens'

export async function GET(
  _req: NextRequest,
  { params }: { params: { teamId: string; boatId: string } }
) {
  const supabase = getServerSupabase()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const { data, error } = await supabase
    .from('boat_battens')
    .select('card, updated_at')
    .eq('team_id', params.teamId)
    .eq('boat_id', params.boatId)
    .maybeSingle()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // A boat with no card yet gets a blank one rather than a 404 — "three battens,
  // nothing filled in" is the correct starting state and the UI should render it
  // as an empty card to fill, not as an error.
  return NextResponse.json({
    card: data ? normaliseBattenCard(data.card) : defaultBattenCard(),
    updatedAt: data?.updated_at ?? null,
    exists: !!data,
  })
}

export async function PUT(
  req: NextRequest,
  { params }: { params: { teamId: string; boatId: string } }
) {
  const supabase = getServerSupabase()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object' || !body.card) {
    return NextResponse.json({ error: 'card required' }, { status: 400 })
  }

  const card = normaliseBattenCard(body.card)

  const { data, error } = await supabase
    .from('boat_battens')
    .upsert(
      {
        team_id: params.teamId,
        boat_id: params.boatId,
        card,
        updated_by_user_id: user.id,
      },
      // Names the plain unique constraint from 0064. A partial index could not
      // arbitrate here — PostgREST cannot repeat its predicate. Same lesson as
      // the detection index in 0062.
      { onConflict: 'team_id,boat_id' }
    )
    .select('card, updated_at')
    .single()

  if (error) {
    // RLS refusing a write is a permissions answer, not a server fault.
    const denied = /row-level security|permission denied/i.test(error.message)
    return NextResponse.json(
      { error: denied ? 'Not allowed to edit this boat’s batten card' : error.message },
      { status: denied ? 403 : 500 }
    )
  }

  return NextResponse.json({ card: normaliseBattenCard(data.card), updatedAt: data.updated_at })
}
