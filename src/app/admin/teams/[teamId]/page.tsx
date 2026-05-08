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
  if (!me || me.global_role !== 'admin' || me.status !== 'active') {
    redirect('/')
  }

  const service = getServiceSupabase()
  const [{ data: team }, { data: boats }, { data: memberships }, { data: users }] =
    await Promise.all([
      service
        .from('teams')
        .select('id, name, created_at')
        .eq('id', params.teamId)
        .maybeSingle(),
      service
        .from('boats')
        .select('id, name, sail_number, created_at')
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

        <BoatsPanel teamId={team.id} boats={boats || []} />

        <MembershipsPanel
          teamId={team.id}
          boats={boats || []}
          memberships={memberships || []}
          activeUsers={users || []}
        />
      </div>
    </div>
  )
}
