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
import InvitationsPanel from './InvitationsPanel'
import SquadPanel from './SquadPanel'
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

  // Allow access for global admin OR an active team_manager or COACH of THIS
  // team. Coach was added for the squad panel: joining a squad is a decision
  // the team takes for itself, and on a dinghy programme the person who takes
  // it is the coach, not a manager. The squad_members policy gates the write
  // either way — this only decides who can reach the page.
  //
  // TWO LEVELS, because the page now has two audiences. A COACH may reach it
  // for the Squad panel — joining a squad is the team's own decision and on a
  // dinghy programme the coach is who takes it. Everything else here (invite,
  // approve, memberships, boats) is guarded server-side by requireTeamManager,
  // so showing those panels to a coach would offer buttons that answer 403.
  // `canManage` decides what renders; the API is still the authority.
  const service: ReturnType<typeof getServiceSupabase> = getServiceSupabase()
  const inWindow = (m: { valid_from: string | null; valid_to: string | null }) => {
    const now = Date.now()
    if (m.valid_from && new Date(m.valid_from).getTime() > now) return false
    if (m.valid_to && new Date(m.valid_to).getTime() < now) return false
    return true
  }
  let canManage = me.global_role === 'admin'
  if (!canManage) {
    const { data: rows } = await service
      .from('memberships')
      .select('role, valid_from, valid_to')
      .eq('user_id', user.id)
      .eq('team_id', params.teamId)
      .in('role', ['team_manager', 'coach'])
    const live = (rows || []).filter(inWindow)
    if (!live.length) redirect('/')
    // Several rows is normal: one person is often manager AND coach.
    canManage = live.some((m) => m.role === 'team_manager')
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
          'id, user_id, boat_id, role, valid_from, valid_to, data_from, data_to, users:users(id, name, email, status)'
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

        {/* The Squad panel is the one thing a coach may use here. */}
        <SquadPanel teamId={team.id} />

        {!canManage && (
          <p className="text-xs text-slate-500 mb-8">
            Inviting people, approving them and editing boats are a team
            manager&rsquo;s job — ask yours, or a site administrator.
          </p>
        )}

        {canManage && (
        <>
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

        <InvitationsPanel teamId={team.id} boats={boats || []} />

        <BackfillPanel teamId={team.id} boats={boats || []} />

        <WipeLocalCachePanel />
        </>
        )}
      </div>
    </div>
  )
}
