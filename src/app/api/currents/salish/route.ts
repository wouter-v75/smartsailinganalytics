import { NextRequest, NextResponse } from 'next/server'
import { requireActiveUser } from '@/lib/supabase/admin-guard'
import {
  inSalishSea, fieldHeaderFor, indexWindow, fieldWindowUrl, fieldCurrentsUrl, buildFrames,
} from '@/lib/salishSeaCurrents'

// GET /api/currents/salish?lat=48.56&lon=-122.89[&hours=12]
//
// The Salish Sea counterpart of /api/currents/hires. Returns the same
// {times, frames, header, res_km} shape the Channel's AMM15 field does, so
// currentJsonToField() wraps it and the player, the colour ramp and the
// particles are untouched.
//
// WHY A SERVER ROUTE and not a direct fetch from the browser. SalishSeaCast is
// a 898x398 curvilinear NEMO grid with no lat/lon axes, so turning it into the
// regular grid the player wants means pulling a window of the geo arrays AND a
// window of the velocities and resampling. Measured 27 Oct 2026: a 41x41
// window over 13 hours is 21,853 rows and 1.3 MB from ERDDAP, of which 52 %
// is water. Doing that on a phone, per venue, per hour, is not the deal — the
// browser gets the resampled field, which is the small part.
//
// UNAUTHENTICATED CALLERS ARE REFUSED, like every other currents route: this
// proxies an external service on the user's behalf.

const STRIDE = 2            // ~1 km from SalishSeaCast's ~500 m, which is the
                            // resolution the target grid asks for anyway
const RES_DEG = 0.01        // ~1.1 km N-S, ~0.74 km E-W at 48.5N
const HALF_LAT = 0.30
const HALF_LON = 0.40       // wider in lon: a degree of longitude is 0.66 of a
                            // degree of latitude here, so this is roughly square
const UA = 'SmartSailingAnalytics/1.0 (+https://ssa.wvsailing.co.uk)'

export async function GET(req: NextRequest) {
  const gate = await requireActiveUser()
  if (!gate.ok) return gate.response

  const lat = parseFloat(req.nextUrl.searchParams.get('lat') || '')
  const lon = parseFloat(req.nextUrl.searchParams.get('lon') || '')
  const hours = Math.max(1, Math.min(48, parseInt(req.nextUrl.searchParams.get('hours') || '12', 10) || 12))
  if (Number.isNaN(lat) || Number.isNaN(lon)) {
    return NextResponse.json({ error: 'lat & lon required' }, { status: 400 })
  }
  if (!inSalishSea(lat, lon)) {
    return NextResponse.json({ error: 'outside the SalishSeaCast domain' }, { status: 404 })
  }

  const header = fieldHeaderFor(lat, lon, HALF_LAT, HALF_LON, RES_DEG)
  const win = indexWindow(header)
  const now = Date.now()
  const startIso = new Date(now - 3 * 3600_000).toISOString().slice(0, 19) + 'Z'
  const endIso = new Date(now + hours * 3600_000).toISOString().slice(0, 19) + 'Z'

  try {
    const [geoRes, curRes] = await Promise.all([
      // The geo arrays are STATIC — the grid does not move — so they are cached
      // for a day while the velocities are cached for half an hour.
      fetch(fieldWindowUrl(win, STRIDE), { headers: { 'User-Agent': UA }, next: { revalidate: 86400 } }),
      fetch(fieldCurrentsUrl(win, STRIDE, startIso, endIso), { headers: { 'User-Agent': UA }, next: { revalidate: 1800 } }),
    ])
    if (!geoRes.ok || !curRes.ok) {
      return NextResponse.json({ error: `SalishSeaCast HTTP ${geoRes.status}/${curRes.status}` }, { status: 502 })
    }
    const geo = await geoRes.json()
    const cur = await curRes.json()
    const { times, frames } = buildFrames(geo?.table?.rows ?? [], cur?.table?.rows ?? [], header)
    if (!times.length) {
      return NextResponse.json({ error: 'no current data for that window' }, { status: 404 })
    }
    return NextResponse.json({
      times, frames, header,
      res_km: 1,
      source: 'SalishSeaCast (UBC EOAS), NEMO ~500 m, VelEast5/VelNorth5',
    })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 })
  }
}
