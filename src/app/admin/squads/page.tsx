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
  if (!me || me.global_role !== 'admin' || me.status !== 'active') redirect('/')

  // Service role for the TEAM PICKER only: an admin creating a squad needs the
  // full list, and teams(name) is not sensitive. Everything that decides
  // visibility still runs as the user through /api/squads, so RLS remains the
  // single access rule.
  const service = getServiceSupabase()
  const { data: teams } = await service
    .from('teams')
    .select('id, name')
    .order('name', { ascending: true })

  return (
    <div className="min-h-screen bg-slate-50 px-4 py-8">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-semibold text-slate-900">Squads</h1>
          <a href="/" className="text-sm text-blue-600 hover:underline">← Back to app</a>
        </div>
        <p className="text-sm text-slate-600 mb-6">
          A squad lets teams that train together see each other&rsquo;s days. You
          create it and say which teams may join; each team then decides for
          itself whether to join and what it contributes. Inviting a team shares
          nothing.{' '}
          <Link href="/admin/teams" className="text-blue-600 hover:underline">Teams →</Link>
        </p>
        <SquadsAdmin teams={teams || []} />
      </div>
    </div>
  )
}
