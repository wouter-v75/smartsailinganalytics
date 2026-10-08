// Team-scoped user approval. Used by the pending-requests panel on the
// team detail page so a team_manager can one-click admit a user who
// redeemed an open-link invite for THEIR team.
//
// Body: { user_id }.
// Pulls the user's requested_role / requested_boat_id (set on redeem),
// flips status='active', creates the membership, clears the requested_*
// hints. Refuses if the user isn't actually requesting this team.
//
// TWO KINDS OF APPLICANT, one button. A brand-new account is `pending` and
// this is what makes it real. An account that is already `active` in ANOTHER
// team is joining a second one — the schema has always allowed several
// memberships per user — and for them the only write that matters is the
// membership: their status, approved_at and approved_by belong to whoever
// admitted them the first time and are left exactly as they are. Refusing
// anything that was not `pending` is what blocked the second team.

import { NextRequest, NextResponse } from 'next/server'
import { getServiceSupabase } from '../../../../../../lib/supabase/server'
import { requireTeamManager } from '../../../../../../lib/supabase/admin-guard'
import { sendApprovedEmail } from '../../../../../../lib/email'
import { recordAuthEvent } from '../../../../../../lib/authEvents'

export async function POST(
  req: NextRequest,
  { params }: { params: { teamId: string } }
) {
  const guard = await requireTeamManager(params.teamId)
  if (!guard.ok) return guard.response

  const body = (await req.json().catch(() => null)) as
    | { user_id?: string }
    | null
  if (!body?.user_id) {
    return NextResponse.json({ error: 'user_id required' }, { status: 400 })
  }

  const service = getServiceSupabase()
  const { data: target } = await service
    .from('users')
    .select(
      'id, email, name, status, requested_team_id, requested_role, requested_boat_id'
    )
    .eq('id', body.user_id)
    .maybeSingle()

  if (!target) {
    return NextResponse.json({ error: 'user not found' }, { status: 404 })
  }
  // 'disabled' (or anything else unexpected) is not admitted: an account that
  // was switched off is switched back on by whoever did it, not joined to a new
  // team around the side.
  if (target.status !== 'pending' && target.status !== 'active') {
    return NextResponse.json(
      {
        error:
          target.status === 'disabled'
            ? 'That account has been switched off. Switch it back on before joining it to this team.'
            : `That account cannot be approved from here (status: ${target.status}).`,
      },
      { status: 400 }
    )
  }
  const existingAccount = target.status === 'active'
  if (target.requested_team_id !== params.teamId) {
    return NextResponse.json(
      { error: 'user did not request this team' },
      { status: 403 }
    )
  }

  // Default role to tl1 if requested_role wasn't set somehow.
  const role = target.requested_role || 'tl1'
  const boatId = target.requested_boat_id || null

  // Step 1 — create membership.
  const { error: memErr } = await service.from('memberships').insert({
    user_id: target.id,
    team_id: params.teamId,
    boat_id: boatId,
    role,
  })
  if (memErr && !String(memErr.message).includes('duplicate')) {
    return NextResponse.json({ error: memErr.message }, { status: 500 })
  }

  // Step 2 — clear the hints, and for a new account flip it to active. An
  // account that was already active keeps its original approved_at /
  // approved_by: that is the record of who let them into SSA, and a second
  // team does not rewrite it.
  const { error: usrErr } = await service
    .from('users')
    .update({
      ...(existingAccount
        ? {}
        : {
            status: 'active',
            approved_at: new Date().toISOString(),
            approved_by: guard.userId,
          }),
      requested_team_id: null,
      requested_role: null,
      requested_boat_id: null,
    })
    .eq('id', target.id)
  if (usrErr) {
    return NextResponse.json({ error: usrErr.message }, { status: 500 })
  }

  // Step 3 — TELL THEM. An approval nobody hears about is the same as no
  // approval: they chose a password when they scanned the code and are now
  // waiting for permission to use it, with no way to tell whether it came.
  const siteUrl = process.env.SSA_SITE_URL || req.nextUrl.origin
  const [{ data: team }, { data: boat }, { data: approver }] = await Promise.all([
    service.from('teams').select('name').eq('id', params.teamId).maybeSingle(),
    boatId
      ? service.from('boats').select('name').eq('id', boatId).maybeSingle()
      : Promise.resolve({ data: null as { name: string } | null }),
    service.from('users').select('name').eq('id', guard.userId).maybeSingle(),
  ])

  let emailed: { ok: boolean; error?: string; notConfigured?: boolean } = { ok: true }
  if (target.email) {
    const sent = await sendApprovedEmail({
      to: target.email as string,
      team_name: (team?.name as string) || 'the team',
      role,
      boat_name: (boat?.name as string) || null,
      site_url: siteUrl,
      approver_name: (approver?.name as string) || null,
      // Changes the last line of the mail: somebody joining a second team has
      // no "password you chose when you scanned the code" to be told about.
      existing_account: existingAccount,
    })
    emailed = sent.ok ? { ok: true } : { ok: false, error: sent.error, notConfigured: sent.notConfigured }
  } else {
    emailed = { ok: false, error: 'that account has no email address on it' }
  }

  await recordAuthEvent(service, {
    action: emailed.ok ? 'user.approved' : 'user.approve_email_failed',
    actorUserId: guard.userId,
    details: {
      to: (target.email as string) || null,
      member_user_id: target.id,
      team_id: params.teamId,
      role,
      boat_id: boatId,
      existing_account: existingAccount,
      error: emailed.ok ? null : emailed.error,
      not_configured: emailed.notConfigured || false,
    },
  })

  // The approval itself SUCCEEDED even if the email did not, so this is a 200
  // with a warning rather than an error — rolling back a membership because a
  // mail server hiccuped would be the worse answer. The panel shows the
  // warning so the manager can tell them another way.
  return NextResponse.json({
    ok: true,
    existing_account: existingAccount,
    email_sent: emailed.ok,
    email_error: emailed.error ?? null,
    email_not_configured: emailed.notConfigured || false,
  })
}
