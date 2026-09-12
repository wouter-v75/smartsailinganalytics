// Invitations for a team:
//   GET  → list active (non-revoked, non-expired) invitations.
//   POST → create. Body shape varies by type:
//          targeted: { email, role, boat_id?, valid_from?, valid_to? }
//          open    : { open: true, role, boat_id?, max_uses?, expires_in_days? }

import { NextRequest, NextResponse } from 'next/server'
import { getServiceSupabase } from '../../../../../../lib/supabase/server'
import { requireTeamManager } from '../../../../../../lib/supabase/admin-guard'
import { generateInviteToken } from '../../../../../../lib/invitation-token'
import { sendInviteEmail, sendMembershipReadyEmail } from '../../../../../../lib/email'
import { provisionTeamMember, firstLoginLink } from '../../../../../../lib/provision-member'

const ROLES = ['team_manager', 'coach', 'tl3', 'tl2', 'tl1', 'consultant', 'guest'] as const
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
      'id, team_id, email, role, boat_id, valid_from, valid_to, data_from, data_to, token, auto_approve, max_uses, used_count, expires_at, revoked_at, created_by_user_id, created_at'
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
  data_from?: string | null // earliest session date the consultant may VIEW
  data_to?: string | null   // latest session date the consultant may VIEW
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
      data_from: tb.data_from || null,
      data_to: tb.data_to || null,
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

  // Email-targeted invite: set the person up NOW rather than asking them to
  // sign up, confirm an address the invite was already sent to, and wait for an
  // approval that the invite said was automatic. Open links keep the old flow —
  // they are posted in WhatsApp and have no address to provision.
  let emailSent: { ok: boolean; error?: string } = { ok: true }
  let provisioned: { user_id?: string; created?: boolean } | null = null
  if (!isOpen && row.email) {
    const [{ data: team }, { data: boat }, { data: inviter }] = await Promise.all([
      service.from('teams').select('name').eq('id', params.teamId).maybeSingle(),
      row.boat_id
        ? service.from('boats').select('name').eq('id', row.boat_id as string).maybeSingle()
        : Promise.resolve({ data: null as { name: string } | null }),
      service.from('users').select('name').eq('id', guard.userId).maybeSingle(),
    ])
    const origin = req.nextUrl.origin
    const siteUrl = process.env.SSA_SITE_URL || 'https://ssa.wvsailing.co.uk'
    const email = row.email as string

    const prov = await provisionTeamMember(service, {
      email,
      teamId: params.teamId,
      role: row.role as string,
      boatId: (row.boat_id as string) || null,
      validFrom: (row.valid_from as string) || null,
      validTo: (row.valid_to as string) || null,
      dataFrom: (row.data_from as string) || null,
      dataTo: (row.data_to as string) || null,
      approvedBy: guard.userId,
    })

    if (prov.ok) {
      // The membership exists, so the /join link has nothing left to do: consume
      // the invite row (kept for the audit trail).
      await service
        .from('invitations')
        .update({ used_count: row.max_uses as number })
        .eq('id', data.id)
      // Only a brand-new account needs a way in; an existing user has a password.
      const setPasswordUrl = prov.created ? await firstLoginLink(service, email, origin) : null
      const result = await sendMembershipReadyEmail({
        to: email,
        team_name: team?.name || 'the team',
        role: row.role as string,
        boat_name: boat?.name || null,
        site_url: siteUrl,
        set_password_url: setPasswordUrl,
        inviter_name: inviter?.name || null,
      })
      emailSent = result.ok ? { ok: true } : { ok: false, error: result.error }
      provisioned = { user_id: prov.userId, created: prov.created }
      await service.from('events').insert({
        user_id: guard.userId,
        action: 'invitation.provisioned',
        details: {
          invitation_id: data.id,
          to: email,
          member_user_id: prov.userId,
          account_created: prov.created,
          email_sent: result.ok,
          email_error: result.ok ? null : result.error,
        },
      })
    } else if (prov.disabled) {
      // Deliberate refusal, not a failure: never paper over it with an invite link.
      await service.from('events').insert({
        user_id: guard.userId,
        action: 'invitation.provision_refused',
        details: { invitation_id: data.id, to: email, reason: prov.error },
      })
      await service.from('invitations').update({ revoked_at: new Date().toISOString() }).eq('id', data.id)
      return NextResponse.json({ error: prov.error }, { status: 409 })
    } else {
      // Could not set them up (e.g. the address exists in auth only). Fall back to
      // the old invite-link email so the invitation is never silently lost.
      const result = await sendInviteEmail({
        to: email,
        team_name: team?.name || 'the team',
        role: row.role as string,
        boat_name: boat?.name || null,
        invite_url: `${origin}/join/${row.token}`,
        inviter_name: inviter?.name || null,
      })
      emailSent = result.ok ? { ok: true } : { ok: false, error: result.error }
      await service.from('events').insert({
        user_id: guard.userId,
        action: 'invitation.provision_failed',
        details: { invitation_id: data.id, to: email, error: prov.error, fell_back_to_link: true },
      })
    }
  }

  return NextResponse.json({ invitation: data, email_sent: emailSent, provisioned })
}
