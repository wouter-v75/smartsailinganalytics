// Admin-only user-approval queue.
//
// On approve, the admin can also pick a starting team / boat / role inline
// so the user doesn't land in an empty workspace. The teams + boats are
// fetched here (server-side) and passed down to the actions component.

import { redirect } from 'next/navigation'
import Link from 'next/link'
import {
  getServerSupabase,
  getServiceSupabase,
} from '../../../lib/supabase/server'
import type { AppUser } from '../../../lib/supabase/types'
import UserActions from './UserActions'

export const dynamic = 'force-dynamic'

export interface TeamWithBoats {
  id: string
  name: string
  boats: { id: string; name: string }[]
}

export default async function AdminUsersPage() {
  const supabase = getServerSupabase()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login?next=/admin/users')

  const { data: me } = await supabase
    .from('users')
    .select('global_role, status')
    .eq('id', user.id)
    .maybeSingle()
  if (!me || me.global_role !== 'admin' || me.status !== 'active') {
    redirect('/')
  }

  const service = getServiceSupabase()
  const [{ data: users }, { data: teams }, { data: boats }] = await Promise.all([
    service
      .from('users')
      .select(
        'id, email, name, status, global_role, created_at, approved_at, approved_by, last_seen_at, requested_team_id, requested_role, requested_boat_id'
      )
      .order('created_at', { ascending: false }),
    service.from('teams').select('id, name').order('name'),
    service
      .from('boats')
      .select('id, name, team_id')
      .order('name'),
  ])

  const teamsWithBoats: TeamWithBoats[] = (teams || []).map((t) => ({
    id: t.id,
    name: t.name,
    boats: (boats || [])
      .filter((b) => b.team_id === t.id)
      .map((b) => ({ id: b.id, name: b.name })),
  }))

  const list = (users || []) as AppUser[]
  const pending = list.filter((u) => u.status === 'pending')
  const active = list.filter((u) => u.status === 'active')
  const disabled = list.filter((u) => u.status === 'disabled')

  return (
    <div className="min-h-screen bg-slate-50 px-4 py-8">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-semibold text-slate-900">
            User approvals
          </h1>
          <div className="flex gap-3 text-sm">
            <Link href="/admin/teams" className="text-blue-600 hover:underline">
              Teams →
            </Link>
            <a href="/" className="text-blue-600 hover:underline">
              ← Back to app
            </a>
          </div>
        </div>

        <Section
          title={`Pending (${pending.length})`}
          users={pending}
          teams={teamsWithBoats}
        />
        <Section
          title={`Active (${active.length})`}
          users={active}
          teams={teamsWithBoats}
        />
        <Section
          title={`Disabled (${disabled.length})`}
          users={disabled}
          teams={teamsWithBoats}
        />
      </div>
    </div>
  )
}

function Section({
  title,
  users,
  teams,
}: {
  title: string
  users: AppUser[]
  teams: TeamWithBoats[]
}) {
  if (users.length === 0) {
    return (
      <section className="mb-8">
        <h2 className="text-sm font-semibold text-slate-700 uppercase tracking-wide mb-2">
          {title}
        </h2>
        <p className="text-slate-500 text-sm">No users in this state.</p>
      </section>
    )
  }
  return (
    <section className="mb-8">
      <h2 className="text-sm font-semibold text-slate-700 uppercase tracking-wide mb-2">
        {title}
      </h2>
      <div className="bg-white rounded-xl shadow border border-slate-200 divide-y divide-slate-100">
        {users.map((u) => (
          <div
            key={u.id}
            className="flex items-start justify-between gap-3 px-4 py-3"
          >
            <div className="min-w-0 flex-1">
              <div className="font-medium text-slate-900 truncate">
                {u.name || '—'}
                {u.global_role === 'admin' && (
                  <span className="ml-2 text-[10px] uppercase tracking-wide bg-amber-100 text-amber-800 px-1.5 py-0.5 rounded">
                    Admin
                  </span>
                )}
              </div>
              <div className="text-sm text-slate-500 truncate">{u.email}</div>
              <div className="text-xs text-slate-400 mt-0.5">
                Joined {formatDate(u.created_at)}
                {u.approved_at && ` · Approved ${formatDate(u.approved_at)}`}
              </div>
            </div>
            <UserActions
              userId={u.id}
              status={u.status}
              teams={teams}
              requestedTeamId={u.requested_team_id}
              requestedRole={u.requested_role}
              requestedBoatId={u.requested_boat_id}
            />
          </div>
        ))}
      </div>
    </section>
  )
}

function formatDate(iso: string) {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    })
  } catch {
    return iso
  }
}
