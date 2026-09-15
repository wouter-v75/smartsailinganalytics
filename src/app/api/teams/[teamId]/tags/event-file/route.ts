// The SSA event file — a day's tags, out of the building.
//
//   GET ?boat_id=…&date=…[&format=json|sportscode][&reel=1][&download=1]
//
// Two formats, for two different readers:
//
//   json        the canonical .ssa.json. Carries scopes, sections, provenance
//               and the vocabulary the day used, so it can be imported back.
//   sportscode  the XML Catapult, Wyscout, Dartfish and Nacsport all read, so a
//               visiting analyst opens SSA's tags in the tool they already own.
//
// `reel=1` exports only the debrief reel — the shortlist, which is what a
// debrief actually works through and what usually wants sharing. A whole day's
// hundred-and-forty tags is an archive; the five on the reel are the point.
//
// Personal tags never leave, whatever the format. That rule lives in
// eventFile.isExportable so it cannot be forgotten in one exporter and not the
// other.

import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase/server'
import { buildEventFile, serializeEventFile, eventFileName } from '@/lib/tagging/eventFile'
import { toSportscodeXml, sportscodeFileName } from '@/lib/tagging/sportscode'
import { TAG_EVENT_COLUMNS, TAG_DEF_COLUMNS, toTagEvent, toTagDef } from '@/lib/tagging/rowMap'

export async function GET(req: NextRequest, { params }: { params: { teamId: string } }) {
  const supabase = getServerSupabase()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const boatId = searchParams.get('boat_id')
  const date = searchParams.get('date')
  const format = searchParams.get('format') || 'json'
  const reelOnly = searchParams.get('reel') === '1'
  if (!boatId || !date) {
    return NextResponse.json({ error: 'boat_id and date required' }, { status: 400 })
  }

  let q = supabase
    .from('ssa_tag_events')
    .select(TAG_EVENT_COLUMNS)
    .eq('team_id', params.teamId)
    .eq('boat_id', boatId)
    .eq('session_date', date)
    .eq('rejected', false)
  if (reelOnly) q = q.not('reel_order', 'is', null)

  const { data: rows, error } = await q.order(reelOnly ? 'reel_order' : 't0', { ascending: true })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  const tags = (rows || []).map(toTagEvent)

  const [{ data: team }, { data: boat }] = await Promise.all([
    supabase.from('teams').select('id,name').eq('id', params.teamId).maybeSingle(),
    supabase.from('boats').select('id,name').eq('id', boatId).maybeSingle(),
  ])
  const boatName = boat?.name || null

  if (format === 'sportscode') {
    const xml = toSportscodeXml(tags, {
      includeProvenance: searchParams.get('provenance') === '1',
    })
    return new NextResponse(xml, {
      status: 200,
      headers: {
        'Content-Type': 'application/xml; charset=utf-8',
        ...(searchParams.get('download') === '1'
          ? { 'Content-Disposition': `attachment; filename="${sportscodeFileName(boatName, date)}"` }
          : {}),
      },
    })
  }

  // Only the vocabulary the day actually used travels with it — buildEventFile
  // narrows the list, so fetching the team's general + section defs is enough.
  const { data: defRows } = await supabase
    .from('ssa_tag_defs')
    .select(TAG_DEF_COLUMNS)
    .eq('team_id', params.teamId)
    .neq('scope', 'personal')

  const file = buildEventFile({
    team: { id: params.teamId, name: team?.name ?? null },
    boat: { id: boatId, name: boatName },
    date,
    sessionId: null,
    tzOffsetMin: Number(searchParams.get('tz_offset_min')) || 0,
    tags,
    phases: [],                       // phases ship with the Phases tab (M7)
    vocabulary: (defRows || []).map(toTagDef),
  })

  const body = serializeEventFile(file)
  return new NextResponse(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...(searchParams.get('download') === '1'
        ? { 'Content-Disposition': `attachment; filename="${eventFileName(boatName, date)}"` }
        : {}),
    },
  })
}
