// Invitations for a team:
//   GET  → list active (non-revoked, non-expired) invitations.
//   POST → create. Body shape varies by type:
//          targeted: { email, role, boat_id?, valid_from?, valid_to? }
//          open    : { open: true, role, boat_id?, max_uses?, expires_in_days? }

import { NextRequest, NextResponse } from 'next/server'
import { getServiceSupabase } from '../../../../../../lib/supabase/server'
import { requireTeamManager } from '../../../../../../lib/supabase/admin-guard'
import { generateInviteToken } from '../../../../../../lib/invitation-token'
import { sendInviteEmail } from '../../../../../../lib/email'

const ROLES = ['team_manager', 'coach', 'tl1', 'tl2', 'consultant'] as const
type Role = (typeof ROLES)[number]

const DEFAULT_OPEN_MAX_USES = 25
const DEFAULT_OPEN_EXPIRY_DAYS = 30
const DEFAULT_EMAIL_EXPIRY_DAYS = 7

export async function GET(
  _req: NextRequest,
  { params }: { params: { teamId: string } }
) {
  const guard = await requireTeamManager(params.teamId)
  if (!guard.ok) return guard.response

  const service = getServiceSupabase()
  const { data, error } = await service
    .from('invitations')
    .select(
      'id, team_id, email, role, boat_id, valid_from, valid_to, token, auto_approve, max_uses, used_count, expires_at, revoked_at, created_by_user_id, created_at'
    )
    .eq('team_id', params.teamId)
    .order('created_at', { ascending: false })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ invitations: data || [] })
}

interface TargetedBody {
  email: string
  role: Role
  boat_id?: string | null
  valid_from?: string | null
  valid_to?: string | null
  expires_in_days?: number
}
interface OpenBody {
  open: true
  role: Role
  boat_id?: string | null
  max_uses?: number
  expires_in_days?: number
}

export async function POST(
  req: NextRequest,
  { params }: { params: { teamId: string } }
) {
  const guard = await requireTeamManager(params.teamId)
  if (!guard.ok) return guard.response

  const body = (await req.json().catch(() => null)) as
    | TargetedBody
    | OpenBody
    | null
  if (!body || !body.role || !ROLES.includes(body.role)) {
    return NextResponse.json({ error: 'role required' }, { status: 400 })
  }
  if (body.role === 'consultant') {
    const vf = (body as TargetedBody).valid_from
    const vt = (body as TargetedBody).valid_to
    if (!vf || !vt) {
      return NextResponse.json(
        { error: 'consultant invites need valid_from and valid_to' },
        { status: 400 }
      )
    }
  }

  const isOpen = 'open' in body && body.open === true
  const now = new Date()

  let row: Record<string, unknown>
  if (isOpen) {
    const ob = body as OpenBody
    const days = Math.max(1, Math.min(365, ob.expires_in_days ?? DEFAULT_OPEN_EXPIRY_DAYS))
    const max = Math.max(1, Math.min(500, ob.max_uses ?? DEFAULT_OPEN_MAX_USES))
    row = {
      team_id: params.teamId,
      email: null,
      role: ob.role,
      boat_id: ob.boat_id || null,
      token: generateInviteToken(),
      auto_approve: false,
      max_uses: max,
      used_count: 0,
      expires_at: new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString(),
      created_by_user_id: guard.userId,
    }
  } else {
    const tb = body as TargetedBody
    if (!tb.email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(tb.email.trim())) {
      return NextResponse.json({ error: 'valid email required' }, { status: 400 })
    }
    const days = Math.max(1, Math.min(60, tb.expires_in_days ?? DEFAULT_EMAIL_EXPIRY_DAYS))
    row = {
      team_id: params.teamId,
      email: tb.email.trim().toLowerCase(),
      role: tb.role,
      boat_id: tb.boat_id || null,
      valid_from: tb.valid_from || null,
      valid_to: tb.valid_to || null,
      token: generateInviteToken(),
      auto_approve: true,
      max_uses: 1,
      used_count: 0,
      expires_at: new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString(),
      created_by_user_id: guard.userId,
    }
  }

  const service = getServiceSupabase()
  const { data, error } = await service
    .from('invitations')
    .insert(row)
    .select()
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  await service.from('events').insert({
    user_id: guard.userId,
    action: 'invitation.create',
    details: {
      team_id: params.teamId,
      invitation_id: data.id,
      email: row.email,
      role: row.role,
      open: isOpen,
    },
  })

  // Send the invite email if it's email-targeted. Open links don't get
  // emails (they're posted in WhatsApp etc).
  let emailSent: { ok: boolean; error?: string } = { ok: true }
  if (!isOpen && row.email) {
    const [{ data: team }, { data: boat }, { data: inviter }] = await Promise.all([
      service.from('teams').select('name').eq('id', params.teamId).maybeSingle(),
      row.boat_id
        ? service.from('boats').select('name').eq('id', row.boat_id as string).maybeSingle()
        : Promise.resolve({ data: null as { name: string } | null }),
      service.from('users').select('name').eq('id', guard.userId).maybeSingle(),
    ])
    const origin = req.nextUrl.origin
    const result = await sendInviteEmail({
      to: row.email as string,
      team_name: team?.name || 'the team',
      role: row.role as string,
      boat_name: boat?.name || null,
      invite_url: `${origin}/join/${row.token}`,
      inviter_name: inviter?.name || null,
    })
    emailSent = result.ok
      ? { ok: true }
      : { ok: false, error: result.error }
    await service.from('events').insert({
      user_id: guard.userId,
      action: result.ok ? 'invitation.email_sent' : 'invitation.email_failed',
      details: {
        invitation_id: data.id,
        to: row.email,
        error: result.ok ? null : result.error,
      },
    })
  }

  return NextResponse.json({ invitation: data, email_sent: emailSent })
}
