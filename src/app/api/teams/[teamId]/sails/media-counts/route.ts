// How many photos, SailScans and video clips there are of each sail in a boat's
// inventory — the numbers on the inventory's Media buttons.
//
//   GET ?boat_id=…  → { counts: { [sailId]: { photos, scans, videos } } }
//
// The same loader and the same placement as one sail's grid (sails/[sailId]/
// media), run once per sail over one read of the boat, so a button's count is
// what its grid will show. Read "light": no URLs are signed for a count.

import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase/server'
import { sailMedia, countSailMedia, type SailMediaCount } from '@/lib/sailMedia'
import { loadBoatMedia, inputFor } from '@/lib/sailMediaLoad'

export async function GET(
  req: NextRequest,
  { params }: { params: { teamId: string } }
) {
  const supabase = getServerSupabase()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const boatId = new URL(req.url).searchParams.get('boat_id')
  if (!boatId) return NextResponse.json({ error: 'boat_id required' }, { status: 400 })

  let media
  try {
    media = await loadBoatMedia(supabase, params.teamId, boatId, { light: true })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }

  const counts: Record<string, SailMediaCount> = {}
  for (const s of media.inventoryRows) counts[s.id] = countSailMedia(sailMedia(inputFor(media, s)))
  return NextResponse.json({ counts })
}
