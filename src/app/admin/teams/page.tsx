// Admin team list. Server component pulls every team via service-role and
// shows a small create-team form.

import { redirect } from 'next/navigation'
import Link from 'next/link'
import {
  getServerSupabase,
  getServiceSupabase,
} from '../../../lib/supabase/server'
import CreateTeamForm from './CreateTeamForm'

export const dynamic = 'force-dynamic'

export default async function AdminTeamsPage() {
  const ssr = getServerSupabase()
  const {
    data: { user },
  } = await ssr.auth.getUser()
  if (!user) redirect('/login?next=/admin/teams')

  const { data: me } = await ssr
    .from('users')
    .select('global_role, status')
    .eq('id', user.id)
    .maybeSingle()
  if (!me || me.global_role !== 'admin' || me.status !== 'active') {
    redirect('/')
  }

  const service = getServiceSupabase()
  const { data: teams } = await service
    .from('teams')
    .select('id, name, created_at')
    .order('name', { ascending: true })

  return (
    <div className="min-h-screen bg-slate-50 px-4 py-8">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-semibold text-slate-900">Teams</h1>
          <div className="flex gap-3 text-sm">
            <Link href="/admin/users" className="text-blue-600 hover:underline">
              Users →
            </Link>
            <a href="/" className="text-blue-600 hover:underline">
              ← Back to app
            </a>
          </div>
        </div>

        <CreateTeamForm />

        <div className="bg-white rounded-xl shadow border border-slate-200 divide-y divide-slate-100">
          {(teams || []).length === 0 ? (
            <div className="p-6 text-slate-500 text-sm text-center">
              No teams yet. Create one above.
            </div>
          ) : (
            (teams || []).map((t) => (
              <Link
                key={t.id}
                href={`/admin/teams/${t.id}`}
                className="flex items-center justify-between px-4 py-3 hover:bg-slate-50"
              >
                <div className="font-medium text-slate-900">{t.name}</div>
                <span className="text-slate-400 text-sm">
                  Manage →
                </span>
              </Link>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
