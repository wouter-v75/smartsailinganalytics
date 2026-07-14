// Set a clip's display rotation.
//
//   PATCH body { rotation: 0 | 90 | 180 | 270 }
//
// Rotation is a PRESENTATION property: we store the angle and every client applies it
// on playback. The source file is never re-encoded — which is the whole point. Rotating
// in QuickTime Player transcodes the file and strips Apple's Keys:CreationDate, so the
// clip arrives carrying its EDIT time instead of its capture time and the instrument
// overlay drifts against the footage. Rotating here keeps the original bytes, and with
// them the capture timestamp.
//
// RLS gates the write (videos_update = own_or_coach), so a crew member can rotate the
// clips they uploaded and a coach can rotate anyone's.

import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '../../../../../lib/supabase/server'

const ALLOWED = [0, 90, 180, 270]

export async function PATCH(
  req: NextRequest,
  { params }: { params: { videoId: string } }
) {
  const supabase = getServerSupabase()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const body = (await req.json().catch(() => null)) as { rotation?: number } | null
  const rotation = Number(body?.rotation)
  if (!ALLOWED.includes(rotation)) {
    return NextResponse.json(
      { error: 'rotation must be 0, 90, 180 or 270' },
      { status: 400 }
    )
  }

  const { data, error } = await supabase
    .from('videos')
    .update({ rotation_deg: rotation })
    .eq('id', params.videoId)
    .select('id, rotation_deg')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data) return NextResponse.json({ error: 'video not found' }, { status: 404 })
  return NextResponse.json({ video: data })
}
