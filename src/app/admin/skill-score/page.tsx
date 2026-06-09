// Admin-only wind-model skill-score dashboard (MVP scaffold).
//
// Reads wv_venue + wv_model_score (created in migration 0034). Speed and
// direction are scored SEPARATELY. With no data yet it shows an empty state
// and the intended layout; the conditioning / forecast-fetch / scoring
// pipeline writes wv_model_score, which this page then renders.
//
// MVP = one boat, but the schema carries boat_id so more yachts slot in later.

import { redirect } from 'next/navigation'
import Link from 'next/link'
import {
  getServerSupabase,
  getServiceSupabase,
} from '../../../lib/supabase/server'

export const dynamic = 'force-dynamic'

interface Venue {
  id: string
  name: string
}

interface ScoreRow {
  model: string
  lead_bin: string | null
  regime: string | null
  n: number | null
  rating_spd: number | null
  mae_spd: number | null
  bias_spd: number | null
  rating_dir: number | null
  mae_dir: number | null
  confidence: string | null
}

function fmt(v: number | null, suffix = '', dp = 1): string {
  return v == null ? '—' : `${v.toFixed(dp)}${suffix}`
}

export default async function AdminSkillScorePage({
  searchParams,
}: {
  searchParams: { venue?: string }
}) {
  const ssr = getServerSupabase()
  const {
    data: { user },
  } = await ssr.auth.getUser()
  if (!user) redirect('/login?next=/admin/skill-score')

  const { data: me } = await ssr
    .from('users')
    .select('global_role, status')
    .eq('id', user.id)
    .maybeSingle()
  if (!me || me.global_role !== 'admin' || me.status !== 'active') {
    redirect('/')
  }

  const service = getServiceSupabase()
  const { data: venuesData } = await service
    .from('wv_venue')
    .select('id, name')
    .order('name')
  const venues = (venuesData || []) as Venue[]

  const venueId = searchParams.venue || venues[0]?.id || ''
  let scores: ScoreRow[] = []
  if (venueId) {
    const { data } = await service
      .from('wv_model_score')
      .select(
        'model, lead_bin, regime, n, rating_spd, mae_spd, bias_spd, rating_dir, mae_dir, confidence'
      )
      .eq('venue_id', venueId)
      .order('rating_spd', { ascending: false })
    scores = (data || []) as ScoreRow[]
  }

  return (
    <div className="min-h-screen bg-slate-50 px-4 py-8">
      <div className="max-w-5xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-semibold text-slate-900">
            Wind-model skill score
          </h1>
          <div className="flex gap-3 text-sm">
            <Link
              href="/admin/weather"
              className="text-blue-600 hover:underline"
            >
              Weather tool
            </Link>
            <Link href="/admin/users" className="text-blue-600 hover:underline">
              Users
            </Link>
            <a href="/" className="text-blue-600 hover:underline">
              ← Back to app
            </a>
          </div>
        </div>

        <p className="text-sm text-slate-600 mb-6">
          Models rated against on-water logs, verified at <strong>mast height</strong>.
          Wind <strong>speed</strong> and <strong>direction</strong> are scored
          separately. <span className="text-slate-400">(MVP — pipeline writes
          scores into <code>wv_model_score</code>.)</span>
        </p>

        {venues.length === 0 ? (
          <div className="bg-white rounded-xl shadow border border-slate-200 p-6 text-sm text-slate-600">
            No venues yet. Add a venue in <code>wv_venue</code>, then upload logs
            for it to start building scores.
          </div>
        ) : (
          <>
            <form method="GET" className="mb-6 flex gap-2 items-end">
              <label className="text-xs text-slate-600">
                Venue
                <select
                  name="venue"
                  defaultValue={venueId}
                  className="block mt-1 w-64 rounded-lg border border-slate-300 bg-white text-slate-900 px-2 py-1.5 text-sm"
                >
                  {venues.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="submit"
                className="rounded-lg bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 text-sm font-medium"
              >
                View
              </button>
            </form>

            <div className="bg-white rounded-xl shadow border border-slate-200 overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-slate-100 text-slate-700">
                  <tr>
                    <th className="text-left px-4 py-2 font-medium">Model</th>
                    <th className="text-right px-3 py-2 font-medium">Speed ★</th>
                    <th className="text-right px-3 py-2 font-medium">Speed MAE</th>
                    <th className="text-right px-3 py-2 font-medium">Speed bias</th>
                    <th className="text-right px-3 py-2 font-medium">Dir ★</th>
                    <th className="text-right px-3 py-2 font-medium">Dir MAE</th>
                    <th className="text-right px-3 py-2 font-medium">n</th>
                    <th className="text-left px-3 py-2 font-medium">Conf.</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {scores.length === 0 ? (
                    <tr>
                      <td
                        colSpan={8}
                        className="px-4 py-8 text-center text-slate-500"
                      >
                        No scores yet for this venue. Upload logs and run the
                        analysis to populate the leaderboard.
                      </td>
                    </tr>
                  ) : (
                    scores.map((s, i) => (
                      <tr key={i}>
                        <td className="px-4 py-2 font-medium text-slate-900">
                          {s.model}
                        </td>
                        <td className="px-3 py-2 text-right">
                          {fmt(s.rating_spd, '', 0)}
                        </td>
                        <td className="px-3 py-2 text-right">
                          {fmt(s.mae_spd, ' kt')}
                        </td>
                        <td className="px-3 py-2 text-right">
                          {fmt(s.bias_spd, ' kt')}
                        </td>
                        <td className="px-3 py-2 text-right">
                          {fmt(s.rating_dir, '', 0)}
                        </td>
                        <td className="px-3 py-2 text-right">
                          {fmt(s.mae_dir, '°', 0)}
                        </td>
                        <td className="px-3 py-2 text-right text-slate-500">
                          {s.n ?? '—'}
                        </td>
                        <td className="px-3 py-2 text-slate-500">
                          {s.confidence ?? '—'}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            <div className="mt-4 text-xs text-slate-500">
              Next steps: log upload → 10-min binning → fetch archived forecasts
              (Open-Meteo historical / previous-runs) → interpolate to mast
              height → score → write <code>wv_model_score</code>. Adjustment
              factors land in <code>wv_model_adjustment</code>.
            </div>
          </>
        )}
      </div>
    </div>
  )
}
