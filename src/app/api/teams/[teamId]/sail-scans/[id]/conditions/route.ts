// Boat state around a SailScan capture — the ±2-min log window (averages +
// graph series). Matches the scan to the day's session log by boat + date and
// computes the window centred on the scan's captured_at.
//
//   GET → { window: ScanWindow | null, session: {date} | null }

import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '../../../../../../../lib/supabase/server'
import { computeScanWindow } from '../../../../../../../lib/scanConditions'

const dayStr = (d: Date): string => d.toISOString().slice(0, 10)

export async function GET(req: NextRequest, { params }: { params: { teamId: string; id: string } }) {
  const supabase = getServerSupabase()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const windowSec = Math.min(600, Math.max(20, parseInt(searchParams.get('window') || '120', 10) || 120))

  const { data: scan, error } = await supabase
    .from('sail_scans')
    .select('id,boat_id,captured_at')
    .eq('team_id', params.teamId)
    .eq('id', params.id)
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 404 })
  if (!scan?.captured_at || !scan.boat_id) return NextResponse.json({ window: null, session: null })

  const t = new Date(scan.captured_at).getTime()
  // Candidate sailing days: the capture day ±1 (covers UTC/local date edges).
  const dates = [-1, 0, 1].map((off) => dayStr(new Date(t + off * 86400000)))
  const { data: sessions } = await supabase
    .from('sessions')
    .select('date,log_data')
    .eq('team_id', params.teamId)
    .eq('boat_id', scan.boat_id)
    .in('date', dates)

  // Pick the session whose log brackets the capture instant.
  let chosen: { date: string; rows: any[] } | null = null
  for (const s of sessions || []) {
    const ld: any = s.log_data
    const rows: any[] = Array.isArray(ld) ? ld : Array.isArray(ld?.rows) ? ld.rows : []
    if (!rows.length) continue
    const first = rows[0]?.utc
    const last = rows[rows.length - 1]?.utc
    if (Number.isFinite(first) && Number.isFinite(last) && t >= first - 60000 && t <= last + 60000) {
      chosen = { date: s.date, rows }
      break
    }
    if (!chosen) chosen = { date: s.date, rows } // fallback to any same-day log
  }

  if (!chosen) return NextResponse.json({ window: null, session: null })
  const win = computeScanWindow(chosen.rows, t, windowSec)
  return NextResponse.json({ window: win, session: { date: chosen.date } })
}
