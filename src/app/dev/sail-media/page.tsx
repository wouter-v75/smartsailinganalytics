'use client'
import * as React from 'react'
import dynamic from 'next/dynamic'

// Preview harness for Boat config → Sail media: one sail's scans, SailTrim
// frames, 360 video, photos and video by wind band. Fixture data, no session —
// the media route is answered in the page, so the grid, the "+N more" cells and
// the event chips can be looked at without a database.
const SailMediaPanel = dynamic(() => import('@/components/boat/SailMediaPanel'), { ssr: false })

const SAILS = [
  { id: 'j2', name: 'J2_2026', category: 'J2' },
  { id: 'j3', name: 'J3_2026', category: 'J3' },
  { id: 'main', name: 'MAIN_2026', category: 'MAIN' },
]

const img = (seed: number, w = 320, h = 240) =>
  `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="hsl(${(seed * 47) % 360},45%,35%)"/><path d="M${w * 0.45} ${h * 0.1} L${w * 0.45} ${h * 0.9} L${w * 0.8} ${h * 0.85} Z" fill="#e2e8f0" opacity=".85"/></svg>`
  )}`

function fixture(sailId: string) {
  const items: any[] = []
  const t = Date.parse('2026-09-11T11:00:00Z')
  const days = [['2026-09-11', 'Worlds 2026'], ['2026-09-12', 'Worlds 2026'], ['2026-09-06', null], ['2026-08-28', 'Cowes Week']]
  let n = 0
  const add = (kind: string, tws: number | null, count: number, extra: any = {}) => {
    for (let i = 0; i < count; i++) {
      const [date, event] = days[(n + i) % days.length]
      n++
      const thumb = img(n, kind === 'video360' ? 400 : 320, 200)
      const isPhoto = kind === 'photo' || kind === 'trim'
      items.push({
        kind, id: `${kind}${n}`, t: t - n * 60_000, date, event, tws: tws == null ? null : tws + (i % 3) * 0.3, thumb,
        ...(isPhoto ? { photo: { thumb, original: img(n, 1600, 1200), inst: { tws } } } : {}), ...extra,
      })
    }
  }
  if (sailId === 'j3') return { items: [], events: [], taggedDays: 0, days: 0 }
  add('scan', 8.2, 2); add('scan', 12.1, 3); add('scan', 16, 1)
  add('trim', 12.4, 5); add('trim', 14.2, 1)
  add('video360', 10.3, 1, { startSec: 95, durSec: 240, title: 'Insta360 masthead' })
  add('video360', 14.1, 2, { startSec: 20, durSec: 600, title: 'VID_0912.insv' })
  add('photo', 6.5, 3); add('photo', 10.1, 14); add('photo', 12.3, 38); add('photo', null, 4)
  add('video', 10.2, 3, { startSec: 0, durSec: 180, title: 'Drone · start 1' })
  add('video', 12.6, 7, { startSec: 312, durSec: 95, title: 'RIB · beat 2' })
  add('video', 22.4, 1, { startSec: 45, durSec: 60, title: 'RIB · top mark' })
  const events = Array.from(new Set(items.map((i) => i.event).filter(Boolean))).sort()
  return { items, events, taggedDays: 2, days: 4 }
}

export default function SailMediaPreview() {
  const [ready, setReady] = React.useState(false)
  const [sailId, setSailId] = React.useState('j2')
  React.useEffect(() => {
    const real = window.fetch
    window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(typeof input === 'string' || input instanceof URL ? input : input.url)
      const m = url.match(/\/sails\/([^/]+)\/media$/)
      if (m) return new Response(JSON.stringify(fixture(m[1])), { headers: { 'content-type': 'application/json' } })
      // The day's full photo rows, which the viewer loads to make Measure work.
      const d = url.match(/\/photos\?date=([\d-]+)/)
      if (d) {
        const photos = fixture('j2').items
          .filter((i: any) => (i.kind === 'photo' || i.kind === 'trim') && i.date === d[1])
          .map((i: any) => ({
            id: i.id, taken_utc: new Date(i.t).toISOString(), thumbnail_url: i.thumb, original_url: i.photo.original,
            bunny_storage_path: `p/${i.id}.jpg`, analysis_data: { inst: { tws: i.tws, twa: 42, bsp: 9.1 } }, sessions: { date: i.date },
          }))
        return new Response(JSON.stringify({ photos }), { headers: { 'content-type': 'application/json' } })
      }
      return real(input, init)
    }) as typeof fetch
    setReady(true)
    return () => { window.fetch = real }
  }, [])
  return (
    <div style={{ minHeight: '100dvh', background: '#04101c', padding: 12, color: '#cbd5e1' }}>
      <div style={{ fontSize: 11, color: '#8A97A9', marginBottom: 10 }}>
        Sail media preview · fixture data · players and viewers need a real session
      </div>
      {ready && (
        <SailMediaPanel teamId="t" boatId="b" sails={SAILS} sailId={sailId} onSailChange={setSailId} onBack={() => {}} />
      )}
    </div>
  )
}
