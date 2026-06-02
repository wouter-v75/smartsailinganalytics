// Team detail: rename, list of boats, list of memberships. All write actions
// hit the /api/admin/teams/* routes.

import { redirect, notFound } from 'next/navigation'
import Link from 'next/link'
import {
  getServerSupabase,
  getServiceSupabase,
} from '../../../../lib/supabase/server'
import TeamHeader from './TeamHeader'
import BoatsPanel from './BoatsPanel'
import MembershipsPanel from './MembershipsPanel'
import SubteamsPanel from './SubteamsPanel'
import InvitationsPanel from './InvitationsPanel'
import PendingRequestsPanel from './PendingRequestsPanel'
import BackfillPanel from './BackfillPanel'
import WipeLocalCachePanel from '../../../../components/WipeLocalCachePanel'

export const dynamic = 'force-dynamic'

export default async function TeamDetailPage({
  params,
}: {
  params: { teamId: string }
}) {
  const ssr = getServerSupabase()
  const {
    data: { user },
  } = await ssr.auth.getUser()
  if (!user) redirect(`/login?next=/admin/teams/${params.teamId}`)
  const { data: me } = await ssr
    .from('users')
    .select('global_role, status')
    .eq('id', user.id)
    .maybeSingle()
  if (!me || me.status !== 'active') redirect('/')

  // Allow access for global admin OR active team_manager of THIS team.
  const service: ReturnType<typeof getServiceSupabase> = getServiceSupabase()
  if (me.global_role !== 'admin') {
    const { data: mgr } = await service
      .from('memberships')
      .select('id, valid_from, valid_to')
      .eq('user_id', user.id)
      .eq('team_id', params.teamId)
      .eq('role', 'team_manager')
    const now = Date.now()
    const ok = (mgr || []).some((m) => {
      if (m.valid_from && new Date(m.valid_from).getTime() > now) return false
      if (m.valid_to && new Date(m.valid_to).getTime() < now) return false
      return true
    })
    if (!ok) redirect('/')
  }
  const [{ data: team }, { data: boats }, { data: memberships }, { data: users }] =
    await Promise.all([
      service
        .from('teams')
        .select('id, name, created_at')
        .eq('id', params.teamId)
        .maybeSingle(),
      service
        .from('boats')
        .select('id, name, sail_number, length_m, created_at')
        .eq('team_id', params.teamId)
        .order('name', { ascending: true }),
      service
        .from('memberships')
        .select(
          'id, user_id, boat_id, role, valid_from, valid_to, users:users(id, name, email, status)'
        )
        .eq('team_id', params.teamId)
        .order('created_at', { ascending: true }),
      // For the "add member" picker — only active users are eligible.
      service
        .from('users')
        .select('id, name, email')
        .eq('status', 'active')
        .order('name', { ascending: true }),
    ])

  // Pending users requesting THIS team via an open invite.
  const { data: pendingForTeam } = await service
    .from('users')
    .select(
      'id, email, name, created_at, requested_role, requested_boat_id'
    )
    .eq('status', 'pending')
    .eq('requested_team_id', params.teamId)
    .order('created_at', { ascending: false })

  if (!team) notFound()

  // ── Campaign engine (NORTHSTAR-gated) ──────────────────────────────────────
  // Campaign engine is generic — every team can manage sub-teams. The
  // 0014+ tables must exist (they do once that migration's been applied).
  // supabase-js returns { error } rather than throwing, so a pre-migration
  // environment just yields empty arrays here.
  let subteams: Array<{
    id: string
    category: 'racing' | 'technical' | 'whole-team'
    key: string
    label: string
    seq: number
    active: boolean
  }> = []
  let subteamAssignments: Array<{ membership_id: string; subteam_id: string }> =
    []
  const [{ data: st }, { data: ms }] = await Promise.all([
    service
      .from('subteams')
      .select('id, category, key, label, seq, active')
      .eq('team_id', params.teamId)
      .order('seq', { ascending: true }),
    service
      .from('membership_subteams')
      .select('membership_id, subteam_id')
      .eq('team_id', params.teamId),
  ])
  subteams = st || []
  subteamAssignments = ms || []

  return (
    <div className="min-h-screen bg-slate-50 px-4 py-8">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <Link
            href="/admin/teams"
            className="text-sm text-blue-600 hover:underline"
          >
            ← All teams
          </Link>
          <a href="/" className="text-sm text-blue-600 hover:underline">
            ← Back to app
          </a>
        </div>

        <TeamHeader team={team} />

        <PendingRequestsPanel
          teamId={team.id}
          pendingUsers={pendingForTeam || []}
          boats={boats || []}
        />

        <BoatsPanel teamId={team.id} boats={boats || []} />

        <MembershipsPanel
          teamId={team.id}
          boats={boats || []}
          memberships={memberships || []}
          // Admins see the full active-user list (they need to be able to
          // grant any user a membership across the system). Team_managers
          // only see users who already have a membership on this team —
          // adding net-new users to the team goes through invitations.
          activeUsers={
            me.global_role === 'admin'
              ? (users || [])
              : (users || []).filter((u) =>
                  (memberships || []).some((m) => m.user_id === u.id)
                )
          }
        />

        <SubteamsPanel
          teamId={team.id}
          subteams={subteams}
          memberships={memberships || []}
          assignments={subteamAssignments}
        />

        <InvitationsPanel teamId={team.id} boats={boats || []} />

        <BackfillPanel teamId={team.id} boats={boats || []} />

        <WipeLocalCachePanel />
      </div>
    </div>
  )
}
