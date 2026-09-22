// Join codes for a squad — how a squad manager invites a team they do not run.
//
// A code is an opaque token the manager sends however they like. The other
// team's own coach or manager redeems it on their team page, which creates an
// INVITED row and nothing more: the receiving team still chooses its
// categories and presses Join, so a code can never make anybody share
// anything.
//
// The alternative was a picker listing every team in the system, which would
// hand any team manager the names of every campaign in it. See 0076.
//
// RLS decides who may mint and read these: squad_join_codes_all is the squad's
// manager (or an admin), and nobody else — a code is a capability, so other
// member teams must not be able to read one off the table and pass it on.

import { NextRequest, NextResponse } from 'next/server'
import { randomBytes } from 'crypto'
import { getServerSupabase, authedUserId } from '@/lib/supabase/server'

type Params = { params: { squadId: string } }

const SELECT = 'id, squad_id, token, note, max_uses, used_count, expires_at, revoked_at, created_at'
const DEFAULT_DAYS = 30
const MAX_DAYS = 365

function dbError(error: { code?: string; message?: string }) {
  if (['42P01', 'PGRST205', 'PGRST204', '42703'].includes(error.code || '')) {
    return NextResponse.json({ codes: [], needsMigration: true })
  }
  return NextResponse.json({ error: error.message }, { status: 500 })
}

export async function GET(_req: NextRequest, { params }: Params) {
  const supabase = getServerSupabase()
  const uid = await authedUserId(supabase)
  if (!uid) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const { data, error } = await supabase
    .from('squad_join_codes')
    .select(SELECT)
    .eq('squad_id', params.squadId)
    .order('created_at', { ascending: false })
  if (error) return dbError(error)
  return NextResponse.json({ codes: data || [] })
}

// POST { note?, max_uses?, expires_in_days? }
export async function POST(req: NextRequest, { params }: Params) {
  const supabase = getServerSupabase()
  const uid = await authedUserId(supabase)
  if (!uid) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const body = (await req.json().catch(() => ({}))) as {
    note?: string; max_uses?: number; expires_in_days?: number
  }
  const days = Math.min(Math.max(Number(body.expires_in_days) || DEFAULT_DAYS, 1), MAX_DAYS)
  const maxUses = Math.min(Math.max(Number(body.max_uses) || 10, 1), 200)

  // 18 bytes base64url — long enough that guessing is not a threat model, short
  // enough to read aloud at a briefing if it comes to that.
  const token = randomBytes(18).toString('base64url')

  const { data, error } = await supabase
    .from('squad_join_codes')
    .insert({
      squad_id: params.squadId,
      token,
      note: body.note?.trim() || null,
      max_uses: maxUses,
      expires_at: new Date(Date.now() + days * 86400_000).toISOString(),
      created_by_user_id: uid,
    })
    .select(SELECT)
    .single()

  if (error) {
    const denied = /row-level security/i.test(error.message || '')
    return NextResponse.json(
      { error: denied ? 'only the squad’s manager can create join codes' : error.message },
      { status: denied ? 403 : 500 }
    )
  }
  return NextResponse.json({ code: data })
}

// DELETE ?id=… — withdraw a code. Revoked rather than deleted: the row is the
// record of who was invited and when, and a withdrawn code is dead immediately
// regardless of its expiry. Teams that already JOINED are unaffected — they
// consented, and taking that back is ejecting them, not revoking a link.
export async function DELETE(req: NextRequest, { params }: Params) {
  const supabase = getServerSupabase()
  const uid = await authedUserId(supabase)
  if (!uid) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const id = req.nextUrl.searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  const { data, error } = await supabase
    .from('squad_join_codes')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', id)
    .eq('squad_id', params.squadId)
    .select(SELECT)
  if (error) return dbError(error)
  if (!data?.length) {
    return NextResponse.json({ error: 'not found, or not yours to withdraw' }, { status: 403 })
  }
  return NextResponse.json({ code: data[0] })
}
