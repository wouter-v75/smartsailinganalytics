// One tag: edit it, or get rid of it.
//
//   PATCH { op, … }   move · window · relabel · verify · unverify · reject ·
//                     unreject · reset · reel · note · label-add · label-remove
//   DELETE            removes a hand-placed tag; TOMBSTONES a detected one
//
// Every edit goes through the helpers in merge.ts rather than writing columns
// directly, because those helpers are what record `edited_fields` — and a field
// that is not claimed there gets silently overwritten by the next sync. That is
// the single easiest way to break the tagger's central promise, so the route
// offers named operations rather than a general "patch these columns".

import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase/server'
import {
  moveTag, setTagWindow, relabelTag, verifyTag, unverifyTag,
  rejectTag, unrejectTag, resetToDetector, setReelOrder, addLabel, removeLabel,
} from '@/lib/tagging/merge'
import { TAG_EVENT_COLUMNS, toTagEvent, toTagEventPatch } from '@/lib/tagging/rowMap'
import type { TagEvent } from '@/lib/tagging/types'

type Ctx = { params: { teamId: string; eventId: string } }

async function load(supabase: any, teamId: string, eventId: string): Promise<TagEvent | null> {
  const { data } = await supabase
    .from('ssa_tag_events').select(TAG_EVENT_COLUMNS)
    .eq('team_id', teamId).eq('id', eventId).maybeSingle()
  return data ? toTagEvent(data) : null
}

export async function PATCH(req: NextRequest, { params }: Ctx) {
  const supabase = getServerSupabase()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const body = await req.json().catch(() => null)
  const op = String(body?.op || '')
  const tag = await load(supabase, params.teamId, params.eventId)
  // RLS hides rows the caller may not read, so "not found" covers both cases.
  if (!tag) return NextResponse.json({ error: 'not found' }, { status: 404 })

  let patch: Partial<TagEvent> = {}
  switch (op) {
    case 'move':
      patch = moveTag(tag, Number(body?.delta_ms))
      break
    case 'window':
      patch = setTagWindow(tag, Number(body?.t0), Number(body?.t1))
      break
    case 'relabel':
      patch = relabelTag(tag, String(body?.slug || ''), body?.label)
      break
    case 'verify':
      patch = verifyTag(tag, user.id)
      break
    case 'unverify':
      patch = unverifyTag(tag)
      break
    case 'reject':
      patch = rejectTag(tag, body?.reason)
      break
    case 'unreject':
      patch = unrejectTag(tag)
      break
    case 'reset':
      patch = resetToDetector(tag)
      break
    case 'reel':
      patch = setReelOrder(tag, body?.order == null ? null : Number(body.order))
      break
    case 'note':
      patch = tag.note === (body?.note ?? null) ? {} : { note: body?.note ?? null }
      break
    case 'label-add':
      patch = addLabel(tag, { group: String(body?.group || ''), text: String(body?.text || '') })
      break
    case 'label-remove':
      patch = removeLabel(tag, { group: String(body?.group || ''), text: String(body?.text || '') })
      break
    default:
      return NextResponse.json({ error: `Unknown op '${op}'` }, { status: 400 })
  }

  // A no-op is success, not an error: pressing "verify" twice should be quiet.
  if (!Object.keys(patch).length) return NextResponse.json({ event: tag, changed: false })

  const { data, error } = await supabase
    .from('ssa_tag_events')
    .update(toTagEventPatch(patch))
    .eq('id', params.eventId)
    .select(TAG_EVENT_COLUMNS)
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ event: toTagEvent(data), changed: true })
}

export async function DELETE(req: NextRequest, { params }: Ctx) {
  const supabase = getServerSupabase()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const tag = await load(supabase, params.teamId, params.eventId)
  if (!tag) return NextResponse.json({ error: 'not found' }, { status: 404 })

  // A DETECTED tag is never really deleted — it is tombstoned, so the next sync
  // does not cheerfully recreate it and leave the crew deleting the same tack
  // every evening. A hand-placed tag has no detection behind it, so it goes.
  if (tag.detectionKey) {
    const { searchParams } = new URL(req.url)
    const { data, error } = await supabase
      .from('ssa_tag_events')
      .update(toTagEventPatch(rejectTag(tag, searchParams.get('reason') || undefined)))
      .eq('id', params.eventId)
      .select(TAG_EVENT_COLUMNS)
      .single()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ rejected: true, event: toTagEvent(data) })
  }

  const { error } = await supabase.from('ssa_tag_events').delete().eq('id', params.eventId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ deleted: true })
}
