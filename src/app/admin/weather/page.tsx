// Admin-only embed of the AROME/ECMWF/ICON wind-analysis weather tool.
//
// The tool itself is a self-contained app deployed at weather.wvsailing.co.uk.
// We embed it in an admin-gated iframe so it stays maintained in its own repo
// and auto-updates here. Same guard pattern as the other /admin pages:
// must be an active global admin, otherwise redirect.

import { redirect } from 'next/navigation'
import Link from 'next/link'
import { getServerSupabase } from '../../../lib/supabase/server'

export const dynamic = 'force-dynamic'

const WEATHER_URL = 'https://weather.wvsailing.co.uk'

export default async function AdminWeatherPage() {
  const ssr = getServerSupabase()
  const {
    data: { user },
  } = await ssr.auth.getUser()
  if (!user) redirect('/login?next=/admin/weather')

  const { data: me } = await ssr
    .from('users')
    .select('global_role, status')
    .eq('id', user.id)
    .maybeSingle()
  if (!me || me.global_role !== 'admin' || me.status !== 'active') {
    redirect('/')
  }

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      <div className="px-4 py-3 flex items-center justify-between border-b border-slate-200 bg-white">
        <h1 className="text-lg font-semibold text-slate-900">
          Weather tool{' '}
          <span className="text-xs font-normal text-slate-500">(admin)</span>
        </h1>
        <div className="flex gap-3 text-sm">
          <Link
            href="/admin/skill-score"
            className="text-blue-600 hover:underline"
          >
            Skill score
          </Link>
          <Link href="/admin/users" className="text-blue-600 hover:underline">
            Users
          </Link>
          <Link href="/admin/teams" className="text-blue-600 hover:underline">
            Teams
          </Link>
          <a
            href={WEATHER_URL}
            target="_blank"
            rel="noreferrer"
            className="text-blue-600 hover:underline"
          >
            Open in new tab ↗
          </a>
          <a href="/" className="text-blue-600 hover:underline">
            ← Back to app
          </a>
        </div>
      </div>

      <iframe
        src={WEATHER_URL}
        title="AROME / ECMWF / ICON wind analysis"
        className="flex-1 w-full border-0"
        style={{ minHeight: 'calc(100vh - 53px)' }}
      />

      <noscript>
        <p className="p-4 text-sm text-slate-600">
          Open the tool at <a href={WEATHER_URL}>{WEATHER_URL}</a>.
        </p>
      </noscript>
    </div>
  )
}
