// Admin: squads. Creating one and deciding which teams MAY join is an admin
// job; whether a team joins, and what it contributes, is that team's own —
// taken on its team page. See SquadsAdmin.tsx for why the authority is split.

import { redirect } from 'next/navigation'
import Link from 'next/link'
import { getServerSupabase, getServiceSupabase } from '../../../lib/supabase/server'
import SquadsAdmin from './SquadsAdmin'

export const dynamic = 'force-dynamic'

export default async function AdminSquadsPage() {
  const ssr = getServerSupabase()
  const { data: { user } } = await ssr.auth.getUser()
  if (!user) redirect('/login?next=/admin/squads')

  const { data: me } = await ssr
    .from('users')
    .select('global_role, status')
    .eq('id', user.id)
    .maybeSingle()
  if (!me || me.status !== 'active') redirect('/')
  const isAdmin = me.global_role === 'admin'

  // THE TEAM PICKER IS THE WHOLE SECURITY QUESTION ON THIS PAGE.
  //
  // An admin founding a squad may pick any team. A TEAM MANAGER may pick only
  // teams they actually run — listing every team would hand them the names of
  // every campaign in the system, across organisations with nothing to do with
  // each other, and a squad page is not a reason to publish a customer list.
  //
  // This is also why inviting another team is a CODE rather than a picker
  // (0076): there is no version of "choose the team to invite" that does not
  // leak the directory.
  const service = getServiceSupabase()
  let teams: { id: string; name: string }[] = []
  if (isAdmin) {
    const { data } = await service.from('teams').select('id, name').order('name', { ascending: true })
    teams = data || []
  } else {
    const { data: mine } = await service
      .from('memberships')
      .select('team_id, role, valid_from, valid_to')
      .eq('user_id', user.id)
      .in('role', ['team_manager', 'coach'])
    const now = Date.now()
    const ids = Array.from(new Set((mine || [])
      .filter((m) => {
        if (m.valid_from && new Date(m.valid_from).getTime() > now) return false
        if (m.valid_to && new Date(m.valid_to).getTime() < now) return false
        return true
      })
      .map((m) => m.team_id)))
    if (!ids.length) redirect('/')
    const { data } = await service.from('teams').select('id, name').in('id', ids).order('name', { ascending: true })
    teams = data || []
  }

  return (
    <div className="min-h-screen bg-slate-50 px-4 py-8">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-semibold text-slate-900">Squads</h1>
          <a href="/" className="text-sm text-blue-600 hover:underline">← Back to app</a>
        </div>
        <p className="text-sm text-slate-600 mb-6">
          A squad lets teams that train together see each other&rsquo;s days. You
          create it, then send a JOIN CODE to the other teams&rsquo; coaches or
          managers. They redeem it on their own team page, and each team decides
          for itself whether to join and what it contributes. A code shares
          nothing and cannot make anyone share anything.{' '}
          <Link href="/admin/teams" className="text-blue-600 hover:underline">Teams →</Link>
        </p>
        <SquadsAdmin teams={teams} isAdmin={isAdmin} />
      </div>
    </div>
  )
}
