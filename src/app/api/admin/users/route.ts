// Admin-only API route for user approvals.
//
// Privileged actions (approve / disable / reactivate) are performed with
// the service-role key.
//
// On `approve`, the caller may optionally pass a membership block — the
// route then creates the user → active flip AND the initial membership in
// one request, so a newly-approved user lands in a real workspace instead
// of a void.

import { NextRequest, NextResponse } from 'next/server'
import {
  getServerSupabase,
  getServiceSupabase,
} from '../../../../lib/supabase/server'
import { sendApprovedEmail } from '../../../../lib/email'
import { recordAuthEvent } from '../../../../lib/authEvents'

type Action = 'approve' | 'disable' | 'reactivate'
type Role = 'team_manager' | 'coach' | 'tl3' | 'tl1' | 'owner' | 'consultant' | 'guest'

const STATUS_BY_ACTION: Record<Action, 'active' | 'disabled'> = {
  approve: 'active',
  disable: 'disabled',
  reactivate: 'active',
}

const ROLES: Role[] = ['team_manager', 'coach', 'tl3', 'tl1', 'owner', 'consultant', 'guest']

interface Membership {
  team_id: string
  boat_id?: string | null
  role: Role
  valid_from?: string | null
  valid_to?: string | null
}

export async function POST(req: NextRequest) {
  const ssr = getServerSupabase()
  const {
    data: { user },
  } = await ssr.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const { data: me } = await ssr
    .from('users')
    .select('global_role, status')
    .eq('id', user.id)
    .maybeSingle()
  if (!me || me.global_role !== 'admin' || me.status !== 'active') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const body = (await req.json().catch(() => null)) as
    | {
        userId?: string
        action?: Action
        membership?: Membership
      }
    | null
  if (!body?.userId || !body?.action || !(body.action in STATUS_BY_ACTION)) {
    return NextResponse.json({ error: 'bad request' }, { status: 400 })
  }

  // Validate the optional membership block early so we don't half-apply.
  if (body.action === 'approve' && body.membership) {
    const m = body.membership
    if (!m.team_id || !m.role || !ROLES.includes(m.role)) {
      return NextResponse.json(
        { error: 'invalid membership' },
        { status: 400 }
      )
    }
    if (m.role === 'consultant' && (!m.valid_from || !m.valid_to)) {
      return NextResponse.json(
        { error: 'consultant requires valid_from and valid_to' },
        { status: 400 }
      )
    }
  }

  const newStatus = STATUS_BY_ACTION[body.action]
  const service = getServiceSupabase()

  // Step 1 — update user status.
  const update: Record<string, unknown> = { status: newStatus }
  if (body.action === 'approve') {
    update.approved_at = new Date().toISOString()
    update.approved_by = user.id
    // Clear the invitation hints — they've served their purpose.
    update.requested_team_id = null
    update.requested_role = null
    update.requested_boat_id = null
  }
  const { error: updErr } = await service
    .from('users')
    .update(update)
    .eq('id', body.userId)
  if (updErr) {
    return NextResponse.json({ error: updErr.message }, { status: 500 })
  }

  // Step 2 — optional membership creation on approve.
  let membershipId: string | null = null
  if (body.action === 'approve' && body.membership) {
    const m = body.membership
    const { data: created, error: memErr } = await service
      .from('memberships')
      .insert({
        user_id: body.userId,
        team_id: m.team_id,
        boat_id: m.boat_id || null,
        role: m.role,
        valid_from: m.valid_from || null,
        valid_to: m.valid_to || null,
      })
      .select('id')
      .single()
    if (memErr) {
      // User flipped to active but membership failed. Surface the error;
      // admin can retry from /admin/teams.
      return NextResponse.json(
        {
          error: `user approved but membership failed: ${memErr.message}`,
          status: newStatus,
        },
        { status: 500 }
      )
    }
    membershipId = created.id
  }

  // Audit (one event covers both writes when both happened).
  await service.from('events').insert({
    user_id: user.id,
    action: `user.${body.action}`,
    details: {
      target_user_id: body.userId,
      new_status: newStatus,
      membership_id: membershipId,
      membership: body.action === 'approve' ? body.membership ?? null : null,
    },
  })

  // Step 3 — TELL THEM, on approve. There are two Approve buttons in SSA: the
  // team page's pending queue and this one, and until now only the team page
  // emailed. Which button an admin happened to press decided whether the
  // person ever heard — and the person cannot tell the difference between
  // "waiting" and "approved, nobody said".
  let emailed: { ok: boolean; error?: string; notConfigured?: boolean } = { ok: true }
  if (body.action === 'approve') {
    const [{ data: target }, { data: approver }] = await Promise.all([
      service.from('users').select('email, name').eq('id', body.userId).maybeSingle(),
      service.from('users').select('name').eq('id', user.id).maybeSingle(),
    ])
    const m = body.membership
    const [{ data: team }, { data: boat }] = await Promise.all([
      m?.team_id
        ? service.from('teams').select('name').eq('id', m.team_id).maybeSingle()
        : Promise.resolve({ data: null as { name: string } | null }),
      m?.boat_id
        ? service.from('boats').select('name').eq('id', m.boat_id).maybeSingle()
        : Promise.resolve({ data: null as { name: string } | null }),
    ])

    if (target?.email) {
      const sent = await sendApprovedEmail({
        to: target.email as string,
        // Null when approved without a membership — the mail says so rather
        // than promising a team they have not got.
        team_name: (team?.name as string) || null,
        role: m?.role || null,
        boat_name: (boat?.name as string) || null,
        site_url: process.env.SSA_SITE_URL || req.nextUrl.origin,
        approver_name: (approver?.name as string) || null,
      })
      emailed = sent.ok
        ? { ok: true }
        : { ok: false, error: sent.error, notConfigured: sent.notConfigured }
    } else {
      emailed = { ok: false, error: 'that account has no email address on it' }
    }

    await recordAuthEvent(service, {
      action: emailed.ok ? 'user.approved' : 'user.approve_email_failed',
      actorUserId: user.id,
      details: {
        to: (target?.email as string) || null,
        member_user_id: body.userId,
        team_id: m?.team_id || null,
        role: m?.role || null,
        error: emailed.ok ? null : emailed.error,
        not_configured: emailed.notConfigured || false,
      },
    })
  }

  return NextResponse.json({
    ok: true,
    status: newStatus,
    membership_id: membershipId,
    // The approval SUCCEEDED either way — undoing it because a mail server
    // hiccuped would be the worse answer — so this is a warning the caller
    // shows, not an error.
    email_sent: body.action === 'approve' ? emailed.ok : undefined,
    email_error: body.action === 'approve' ? emailed.error ?? null : undefined,
    email_not_configured: body.action === 'approve' ? emailed.notConfigured || false : undefined,
  })
}
