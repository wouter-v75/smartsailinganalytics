// Where the drone was filming on a given day, and which of it is already cut.
//
//   GET ?date=YYYY-MM-DD → { coverage: { footage, clips, scannedAt, … } }
//
// Measured off the card by scripts/drone-coverage.ts when the drive is plugged
// in, stored on the session (migration 0098), and drawn as two bands on the
// Tags tab track: light green for footage, dark green for the clips.
//
// READ ONLY. The browser has never seen the card and never will, so there is no
// PUT here — the scan writes with the service-role key, from the one machine the
// drive is connected to.
//
// A day nobody has scanned returns an empty coverage rather than a 404: the
// track asks for every day it draws, and a missing answer is the normal case,
// not an error worth a console full of red.

import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase/server'
import { EMPTY_COVERAGE, normaliseCoverage } from '@/lib/droneCoverage'

export async function GET(
  req: NextRequest,
  { params }: { params: { teamId: string; boatId: string } }
) {
  const supabase = getServerSupabase()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const date = req.nextUrl.searchParams.get('date')
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: 'date=YYYY-MM-DD required' }, { status: 400 })
  }

  const { data, error } = await supabase
    .from('sessions')
    .select('drone_coverage')
    .eq('team_id', params.teamId)
    .eq('boat_id', params.boatId)
    .eq('date', date)
    .maybeSingle()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({
    coverage: data?.drone_coverage ? normaliseCoverage(data.drone_coverage) : EMPTY_COVERAGE,
  })
}
