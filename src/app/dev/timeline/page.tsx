'use client'
import * as React from 'react'
import DayTimeline from '@/components/timeline/DayTimeline'
import { MyCommentsCard, MyDebriefNotesCard } from '@/components/CampaignTab'
import type { TimelineNode } from '@/lib/timeline/types'

// Preview harness for the day's Comments column and the two personal Day cards.
//
// Both read the network, so this stubs `fetch` for exactly the four endpoints
// they touch and lets everything else through. Not a test: what it checks is
// the thing tests cannot — whether a comment is readable at rest, whether the
// fisheye buys anything, and whether five decks still work with a thumb.

const DAY = '2026-09-11'
const T = (h: number, m: number, s = 0) =>
  Date.parse(`${DAY}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}Z`)

const ME = 'u-me'

const COMMENTS = [
  { id: 'c1', t0: T(11, 44), slug: 'team-note', label: 'Team comment', color: '#7F77DD',
    text: 'Jib lead one hole aft of the card — felt closed in the bottom.', personal: false,
    authorId: 'u-sam', authorName: 'Sam Whitcombe' },
  { id: 'c2', t0: T(12, 6, 30), slug: 'tack', label: 'Tack', color: '#1D9E75',
    text: 'Late release, we stalled the whole way out of it.', personal: false,
    authorId: ME, authorName: 'Wouter van Dam' },
  { id: 'c3', t0: T(12, 21), slug: 'team-note', label: 'Team comment', color: '#7F77DD',
    text: 'Kite hourglassed at the hoist — halyard was not clear behind the jib and nobody called it.',
    personal: false, authorId: 'u-sam', authorName: 'Sam Whitcombe' },
  { id: 'c4', t0: T(12, 52), slug: 'team-note', label: 'Team comment', color: '#7F77DD',
    text: 'Good gate call.', personal: false, authorId: 'u-ines', authorName: 'Inès Moreau' },
  { id: 'c5', t0: T(13, 58), slug: 'note', label: 'Personal note', color: '#64748B',
    text: 'Remember: ask about the rake for race 2.', personal: true,
    authorId: ME, authorName: 'Wouter van Dam' },
]

const day: TimelineNode = {
  id: `day:${DAY}`, parentId: null, kind: 'day', t0: T(11, 20), t1: T(15, 30),
  title: 'Palma Week · day 3', source: 'auto', producer: 'eventfile', meta: { date: DAY },
}
const events: TimelineNode[] = [
  { id: 'e1', parentId: day.id, kind: 'sail_change', t0: T(11, 40), t1: T(11, 40), title: 'J2 + Main', source: 'human', producer: 'user' },
  { id: 'e2', parentId: day.id, kind: 'start', t0: T(12, 0), t1: T(12, 0), title: 'Race 1 start', source: 'auto', producer: 'eventfile' },
  { id: 'e3', parentId: day.id, kind: 'tack', t0: T(12, 6), t1: T(12, 6), title: 'Tack', source: 'auto', producer: 'log' },
  { id: 'e4', parentId: day.id, kind: 'mark', t0: T(12, 20), t1: T(12, 20), title: 'Top mark', source: 'auto', producer: 'eventfile' },
  { id: 'e5', parentId: day.id, kind: 'mark', t0: T(12, 50), t1: T(12, 50), title: 'Leeward gate', source: 'auto', producer: 'eventfile' },
  { id: 'e6', parentId: day.id, kind: 'start', t0: T(14, 0), t1: T(14, 0), title: 'Race 2 start', source: 'auto', producer: 'eventfile' },
]

// A one-pixel PNG, so the photo deck has something to draw without a network.
const DOT = 'data:image/gif;base64,R0lGODlhAQABAIAAAJ7X7wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw=='

const PHOTOS = [T(12, 2), T(12, 24), T(12, 55), T(14, 4)].map((t, i) => ({
  id: `p${i}`, thumbnail_url: DOT, original_url: DOT,
  taken_utc: new Date(t).toISOString(),
  analysis_data: { inst: { tws: 12 + i, twa: 42 + i * 30, twaTarg: 42, sails: ['J2'] } },
}))
const VIDEOS = [T(11, 58), T(13, 57)].map((t, i) => ({
  id: `v${i}`, thumbnail: DOT, start_utc: new Date(t).toISOString(), title: `Onboard ${i + 1}`, tags: [],
}))

function stubFetch() {
  const real = window.fetch.bind(window)
  let noteBody = 'Ask about the rake for race 2.\nAnd the jib lead — one hole forward on the second beat.'
  window.fetch = async (input: any, init?: any) => {
    const url = String(typeof input === 'string' ? input : input?.url || '')
    const json = (body: any) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })
    if (url.includes('/tags/comments')) return json({ comments: COMMENTS, me: ME })
    if (url.includes('/day-notes')) {
      if ((init?.method || 'GET').toUpperCase() === 'PUT') {
        noteBody = JSON.parse(init.body).body
        return json({ note: { body: noteBody, updatedAt: Date.now() } })
      }
      return json({ note: { body: noteBody, updatedAt: Date.now() } })
    }
    if (url.includes('/photos')) return json({ photos: PHOTOS })
    if (url.includes('/videos')) return json({ videos: VIDEOS })
    if (url.includes('/sail-scans')) return json({ scans: [] })
    if (url.includes('/sails')) return json({ sails: [] })
    return real(input, init)
  }
}

export default function TimelinePreview() {
  const [ready, setReady] = React.useState(false)
  const [theme, setTheme] = React.useState<'dark' | 'light'>('dark')
  React.useEffect(() => { stubFetch(); setReady(true) }, [])
  React.useEffect(() => { document.documentElement.setAttribute('data-theme', theme) }, [theme])

  if (!ready) return null
  return (
    <div className="min-h-[100dvh] bg-bg p-3 text-fg">
      <div className="mb-3 flex items-center gap-2 text-[11px] text-muted">
        <span>Timeline preview · fixture data</span>
        <button onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))} className="ml-auto min-h-[44px] px-2 underline">
          {theme === 'dark' ? 'Light' : 'Dark'}
        </button>
      </div>

      <DayTimeline day={day} events={events} tz={120} teamId="t1" boatId="b1" />

      <div className="mt-6 flex flex-col gap-3 lg:flex-row">
        <MyCommentsCard teamId="t1" boatId="b1" date={DAY} tzMin={120} wrapperStyle={{ flex: '1 1 0' }} />
        <MyDebriefNotesCard teamId="t1" boatId="b1" date={DAY} wrapperStyle={{ flex: '1 1 0' }} />
      </div>
    </div>
  )
}
