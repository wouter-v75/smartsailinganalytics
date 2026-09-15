// Batten cards for a boat's mainsails — what the battens SHOULD be, per batten,
// per wind band. See supabase/migrations/0064 and 0065 for why it is one JSONB
// document per sail rather than a row per cell, and why it moved off the boat.
//
//   GET                       → { cards: [{ sailId, card, updatedAt }] }
//   PUT  { sail_id, card }    → upsert one sail's card → { card, updatedAt }
//
// GET returns every card the boat has, in one request. The batten tab in the
// sail-change composer needs the card for whichever main is UP, and that changes
// as the crew taps — fetching per sail would be a request per press.
//
// A card with sailId null was entered before 0065 and has not been assigned to a
// main. It is returned like any other so the UI can offer it rather than
// throwing away hand-entered work; nothing adopts it automatically.
//
// RLS (0064) is the authority on who may write. This route's job is to make sure
// what lands is a card — normaliseBattenCard is the same function the UI uses, so
// the client and the server cannot disagree about what a blank cell is.

import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase/server'
import { normaliseBattenCard, type SailBattenCard } from '@/lib/battens'

export async function GET(
  _req: NextRequest,
  { params }: { params: { teamId: string; boatId: string } }
) {
  const supabase = getServerSupabase()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const { data, error } = await supabase
    .from('boat_battens')
    .select('sail_id, card, updated_at')
    .eq('team_id', params.teamId)
    .eq('boat_id', params.boatId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const cards: SailBattenCard[] = (data || []).map((r) => ({
    sailId: (r.sail_id as string | null) ?? null,
    card: normaliseBattenCard(r.card),
    updatedAt: (r.updated_at as string | null) ?? null,
  }))

  return NextResponse.json({ cards })
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

  // A card has to belong to a sail. Accepting one without would quietly recreate
  // the unassigned rows 0065 exists to clear up.
  const sailId: string | null = body.sail_id ?? null
  if (!sailId) {
    return NextResponse.json({ error: 'sail_id required — a batten card belongs to a mainsail' }, { status: 400 })
  }

  // The sail must be this boat's. Without this a client could hang a card off
  // another team's sail id and the composite key would happily store it.
  const { data: sail } = await supabase
    .from('sails')
    .select('id, kind')
    .eq('id', sailId)
    .eq('team_id', params.teamId)
    .eq('boat_id', params.boatId)
    .maybeSingle()
  if (!sail) {
    return NextResponse.json({ error: 'that sail is not in this boat’s inventory' }, { status: 400 })
  }

  const card = normaliseBattenCard(body.card)

  const { data, error } = await supabase
    .from('boat_battens')
    .upsert(
      {
        team_id: params.teamId,
        boat_id: params.boatId,
        sail_id: sailId,
        card,
        updated_by_user_id: user.id,
      },
      // Names the unique index from 0065. It is not partial, so PostgREST can
      // generate an ON CONFLICT against it — the lesson from 0062's detection
      // index, which had to stop being partial for exactly this reason.
      { onConflict: 'team_id,boat_id,sail_id' }
    )
    .select('card, updated_at')
    .single()

  if (error) {
    // RLS refusing a write is a permissions answer, not a server fault.
    const denied = /row-level security|permission denied/i.test(error.message)
    return NextResponse.json(
      { error: denied ? 'Not allowed to edit this boat’s batten cards' : error.message },
      { status: denied ? 403 : 500 }
    )
  }

  return NextResponse.json({ card: normaliseBattenCard(data.card), updatedAt: data.updated_at })
}
