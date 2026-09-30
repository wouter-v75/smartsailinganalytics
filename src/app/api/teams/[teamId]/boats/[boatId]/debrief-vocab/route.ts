// A boat's own debrief vocabulary — the crew, rivals, roles, manoeuvres, slang
// and mishearings that used to live in src/lib/debriefGlossary.ts under
// TEAM_VOCAB and needed a deploy to change. See supabase/migrations/0097 for why
// it is a table rather than a column on boats (boats_update is team_manager
// only, and the person who spots a mishearing is whoever read the transcript).
//
//   GET          → { vocab, updatedAt }
//   PUT { vocab } → upsert this boat's vocabulary → { vocab, updatedAt }
//
// GET is open to anyone who can see the boat: the vocabulary is fed into every
// debrief made on it, and a crew member who cannot read it cannot tell why the
// summary called something what it did. RLS (0097) is the authority on who may
// WRITE; this route's job is to make sure what lands is a vocabulary.
//
// normaliseDebriefVocab is the same function the editor uses, so the browser and
// the column cannot disagree about what a blank row is — a half-typed pair (a
// name with no role) is dropped here exactly as it is there.

import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase/server'
import { EMPTY_VOCAB, normaliseDebriefVocab } from '@/lib/debriefVocab'

export async function GET(
  _req: NextRequest,
  { params }: { params: { teamId: string; boatId: string } }
) {
  const supabase = getServerSupabase()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const { data, error } = await supabase
    .from('boat_debrief_vocab')
    .select('vocab, updated_at')
    .eq('team_id', params.teamId)
    .eq('boat_id', params.boatId)
    .maybeSingle()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // No row is not an error and not an empty vocabulary either — it means this
  // boat has never been edited, so the code defaults still apply. The caller
  // merges; it only needs to know there is nothing to merge.
  return NextResponse.json({
    vocab: data ? normaliseDebriefVocab(data.vocab) : EMPTY_VOCAB,
    updatedAt: (data?.updated_at as string | null) ?? null,
  })
}

export async function PUT(
  req: NextRequest,
  { params }: { params: { teamId: string; boatId: string } }
) {
  const supabase = getServerSupabase()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const body = (await req.json().catch(() => null)) as { vocab?: unknown } | null
  const vocab = normaliseDebriefVocab(body?.vocab)

  const { data, error } = await supabase
    .from('boat_debrief_vocab')
    .upsert(
      {
        team_id: params.teamId,
        boat_id: params.boatId,
        vocab,
        updated_by_user_id: user.id,
      },
      { onConflict: 'team_id,boat_id' }
    )
    .select('vocab, updated_at')
    .single()

  // A refusal here is RLS saying this person may not write the vocabulary, and
  // it has to reach the editor as a refusal. A save that silently does nothing
  // is worse than no save button: the term looks added, the next debrief does
  // not have it, and nobody knows which of the two is wrong.
  if (error) {
    const denied = /row-level security|permission denied/i.test(error.message)
    return NextResponse.json(
      {
        error: denied
          ? 'You do not have permission to edit this boat’s debrief words (coach, TL3 or team manager).'
          : error.message,
      },
      { status: denied ? 403 : 500 }
    )
  }

  return NextResponse.json({
    vocab: normaliseDebriefVocab(data?.vocab),
    updatedAt: (data?.updated_at as string | null) ?? null,
  })
}
