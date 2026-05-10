// Admin-only audit log viewer. Reads from public.events.
//
// Filters: action prefix (?action=), user (?email=), days back (?days=).
// All filtering is server-side via SQL — no client logic. Pagination is
// last-N-days; with the default 7 days you'll see ~hundreds of rows even
// for an active workspace.

import { redirect } from 'next/navigation'
import Link from 'next/link'
import {
  getServerSupabase,
  getServiceSupabase,
} from '../../../lib/supabase/server'

export const dynamic = 'force-dynamic'

interface SearchParams {
  action?: string
  email?: string
  days?: string
}

interface JoinedUser {
  email: string | null
  name: string | null
}

interface EventRow {
  id: number
  ts: string
  action: string
  details: unknown
  user_id: string | null
  users: JoinedUser | JoinedUser[] | null
}

function firstUser(u: EventRow['users']): JoinedUser | null {
  if (!u) return null
  return Array.isArray(u) ? u[0] || null : u
}

export default async function AdminEventsPage({
  searchParams,
}: {
  searchParams: SearchParams
}) {
  const ssr = getServerSupabase()
  const {
    data: { user },
  } = await ssr.auth.getUser()
  if (!user) redirect('/login?next=/admin/events')

  const { data: me } = await ssr
    .from('users')
    .select('global_role, status')
    .eq('id', user.id)
    .maybeSingle()
  if (!me || me.global_role !== 'admin' || me.status !== 'active') {
    redirect('/')
  }

  const days = Math.max(
    1,
    Math.min(180, parseInt(searchParams.days || '7', 10) || 7)
  )
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()

  const service = getServiceSupabase()
  let q = service
    .from('events')
    .select(
      'id, ts, action, details, user_id, users:users(email, name)'
    )
    .gte('ts', since)
    .order('ts', { ascending: false })
    .limit(500)

  if (searchParams.action) {
    q = q.ilike('action', `${searchParams.action}%`)
  }
  if (searchParams.email) {
    q = q.eq('users.email', searchParams.email)
  }

  const { data: events } = await q
  const list = (events || []) as EventRow[]

  // Aggregate counts by action for the summary row.
  const counts = list.reduce<Record<string, number>>((acc, e) => {
    acc[e.action] = (acc[e.action] || 0) + 1
    return acc
  }, {})
  const topActions = Object.entries(counts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 8)

  return (
    <div className="min-h-screen bg-slate-50 px-4 py-8">
      <div className="max-w-5xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-semibold text-slate-900">
            Audit log
          </h1>
          <div className="flex gap-3 text-sm">
            <Link href="/admin/users" className="text-blue-600 hover:underline">
              Users
            </Link>
            <Link href="/admin/teams" className="text-blue-600 hover:underline">
              Teams
            </Link>
            <a href="/" className="text-blue-600 hover:underline">
              ← Back to app
            </a>
          </div>
        </div>

        <form method="GET" className="mb-6 flex flex-wrap gap-2 items-end">
          <label className="text-xs text-slate-600">
            Days back
            <input
              type="number"
              name="days"
              min={1}
              max={180}
              defaultValue={days}
              className="block mt-1 w-24 rounded-lg border border-slate-300 bg-white text-slate-900 px-2 py-1.5 text-sm"
            />
          </label>
          <label className="text-xs text-slate-600">
            Action prefix
            <input
              type="text"
              name="action"
              placeholder="e.g. invitation"
              defaultValue={searchParams.action || ''}
              className="block mt-1 w-44 rounded-lg border border-slate-300 bg-white text-slate-900 px-2 py-1.5 text-sm"
            />
          </label>
          <label className="text-xs text-slate-600">
            User email
            <input
              type="email"
              name="email"
              placeholder="exact match"
              defaultValue={searchParams.email || ''}
              className="block mt-1 w-56 rounded-lg border border-slate-300 bg-white text-slate-900 px-2 py-1.5 text-sm"
            />
          </label>
          <button
            type="submit"
            className="rounded-lg bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 text-sm font-medium"
          >
            Filter
          </button>
        </form>

        <div className="mb-6 bg-white rounded-xl shadow border border-slate-200 p-4">
          <div className="text-sm font-medium text-slate-900 mb-2">
            Activity in the last {days} day{days === 1 ? '' : 's'} ·{' '}
            {list.length} events
          </div>
          {topActions.length === 0 ? (
            <div className="text-slate-500 text-sm">No events.</div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {topActions.map(([a, n]) => (
                <span
                  key={a}
                  className="text-xs bg-slate-100 text-slate-700 rounded-full px-2.5 py-0.5"
                >
                  {a} · {n}
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="bg-white rounded-xl shadow border border-slate-200 divide-y divide-slate-100">
          {list.length === 0 ? (
            <div className="p-6 text-center text-slate-500 text-sm">
              No events match these filters.
            </div>
          ) : (
            list.map((e) => {
              const u = firstUser(e.users)
              return (
                <div
                  key={e.id}
                  className="px-4 py-3 grid grid-cols-12 gap-2 text-sm"
                >
                  <div className="col-span-3 text-xs text-slate-500 font-mono">
                    {new Date(e.ts).toLocaleString()}
                  </div>
                  <div className="col-span-3 font-medium text-slate-900">
                    {e.action}
                  </div>
                  <div className="col-span-3 text-xs text-slate-600 truncate">
                    {u?.email || (e.user_id ? '(deleted user)' : 'system')}
                  </div>
                  <div className="col-span-3 text-xs text-slate-500 truncate font-mono">
                    {e.details ? JSON.stringify(e.details) : ''}
                  </div>
                </div>
              )
            })
          )}
        </div>
        {list.length === 500 && (
          <p className="mt-3 text-xs text-slate-500 text-center">
            Showing the most recent 500 events. Narrow the filter (action /
            email) or shorten the date range to see specific older events.
          </p>
        )}
      </div>
    </div>
  )
}
