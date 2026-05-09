// Single invitation:
//   DELETE → revoke (sets revoked_at; doesn't hard-delete so audit stays).

import { NextRequest, NextResponse } from 'next/server'
import { getServiceSupabase } from '../../../../../../../lib/supabase/server'
import { requireTeamManager } from '../../../../../../../lib/supabase/admin-guard'

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { teamId: string; invitationId: string } }
) {
  const guard = await requireTeamManager(params.teamId)
  if (!guard.ok) return guard.response

  const service = getServiceSupabase()
  const { error } = await service
    .from('invitations')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', params.invitationId)
    .eq('team_id', params.teamId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  await service.from('events').insert({
    user_id: guard.userId,
    action: 'invitation.revoke',
    details: { team_id: params.teamId, invitation_id: params.invitationId },
  })
  return NextResponse.json({ ok: true })
}
