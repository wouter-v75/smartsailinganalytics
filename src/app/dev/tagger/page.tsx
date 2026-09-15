'use client'
import * as React from 'react'
import TagButtonBar from '@/components/tagging/TagButtonBar'
import TagTrack from '@/components/tagging/TagTrack'
import ReviewQueue from '@/components/tagging/ReviewQueue'
import DebriefReel from '@/components/tagging/DebriefReel'
import TagSheet from '@/components/tagging/TagSheet'
import TrackView from '@/components/tagging/TrackView'
import DayPicker from '@/components/tagging/DayPicker'
import SailChangeDetail from '@/components/tagging/SailChangeDetail'
import { normaliseBattenCard } from '@/lib/battens'
import { sailStateAt, type SailState } from '@/lib/tagging/sailState'
import { segmentDay } from '@/lib/tagging/segments'
import { withRequests } from '@/lib/tagging/requests'
import { BASE_TAGS } from '@/lib/tagging/baseTags'
import { mediaMarks } from '@/lib/mediaDecks'
import type { TagDef, TagEvent, TagRequest } from '@/lib/tagging/types'

// Preview harness for the tagging tab — the three views with fixture data and no
// network, so they can be looked at (and screenshotted at phone width) without a
// signed-in session and a day of real sailing behind them.
//
// Not a test: it renders the presentational components directly rather than
// TaggerTab, which fetches. What it checks is the thing tests cannot — whether
// this is usable with one thumb.

const DAY = '2026-09-11'
const T = (h: number, m: number, s = 0) => Date.parse(`${DAY}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}Z`)

const defs: TagDef[] = BASE_TAGS.map((b, i) => ({
  id: `def-${i}`, teamId: 't', boatId: null,
  scope: b.scope, section: b.section, ownerUserId: null,
  slug: b.slug, label: b.label, color: b.color, minRole: b.minRole,
  kind: b.kind, leadSec: b.leadSec, lagSec: b.lagSec,
  labelGroups: b.labelGroups, lane: null, onButtonBar: b.onButtonBar,
  privateByDefault: !!b.privateByDefault,
  builtin: true, archived: false, sort: b.sort,
}))

let n = 0
// autoT0/autoT1 default to the row's OWN t0/t1 unless a fixture deliberately
// overrides them — otherwise every detection renders as "moved", which is how
// the first screenshot of this page came out.
const tag = (over: Partial<TagEvent>): TagEvent => ({
  id: `e${++n}`, teamId: 't', boatId: 'b', sessionId: null, sessionDate: DAY,
  tagDefId: null, slug: 'tack', label: 'Tack', color: '#1D9E75',
  scope: 'general', section: null, ownerUserId: null,
  t0: T(12, 10), t1: T(12, 10, 22),
  targetKind: 'track', targetId: null, note: null, labels: [],
  source: 'auto', producer: 'manoeuvres', detectionKey: `k${n}`,
  confidence: 0.86,
  editedFields: [], verifiedByUserId: null, verifiedAt: null,
  rejected: false, rejectedReason: null, reelOrder: null,
  createdByUserId: 'me', meta: { raceNum: 1 },
  ...over,
  autoT0: 'autoT0' in over ? over.autoT0! : (over.t0 ?? T(12, 10)),
  autoT1: 'autoT1' in over ? over.autoT1! : (over.t1 ?? T(12, 10, 22)),
})

// A synthetic windward/leeward: two laps up and down with a tack every couple
// of minutes, so the track view has a recognisable course rather than a blob.
const TRACK_ROWS = (() => {
  const out: { utc: number; lat: number; lon: number }[] = []
  const t0 = T(11, 20)
  const legs = 8               // beat, run, beat, run …
  const legSec = 8 * 60
  for (let i = 0; i < legs * legSec; i += 5) {
    const leg = Math.floor(i / legSec)
    const f = (i % legSec) / legSec
    const up = leg % 2 === 0
    const lat = 39.50 + (up ? f : 1 - f) * 0.018
    // Tack every ~110 s on the beats; the runs are gybed once in the middle.
    const zig = up
      ? (Math.floor((i % legSec) / 110) % 2 ? 1 : -1) * 0.004 * Math.sin((f * Math.PI))
      : (f < 0.5 ? -1 : 1) * 0.003
    out.push({ utc: t0 + i * 1000, lat, lon: 2.62 + zig + leg * 0.0006 })
  }
  return out
})()

const events: TagEvent[] = [
  // Sail changes carry the WHOLE state after them, which is what the track's
  // hover readout reads back. Two of them, so hovering one and then the other
  // gives different answers rather than the same line twice.
  tag({ slug: 'sail-change', label: 'J2 + Main', color: '#F59E0B', source: 'human', producer: 'user',
        detectionKey: null, autoT0: null, confidence: null, t0: T(11, 40), t1: T(11, 40, 20),
        labels: [{ group: 'Change', text: 'hoist' }],
        meta: { sail: {
          up: [{ id: 'i1', name: 'Main' }, { id: 'i3', name: 'J2' }],
          onBoard: [{ id: 'i1', name: 'Main' }, { id: 'i3', name: 'J2' }, { id: 'i4', name: 'J4' }, { id: 'i5', name: 'A2' }],
          battens: [{ no: 1, tension: 'soft', turns: 5 }, { no: 2, tension: 'medium', turns: 0 }, { no: 3, tension: 'stiff', turns: -2 }],
        } } }),
  tag({ slug: 'race-start', label: 'Race 1 start', color: '#EF4444', producer: 'eventfile',
        confidence: 0.98, verifiedAt: T(16, 0), verifiedByUserId: 'me',
        t0: T(11, 59), t1: T(12, 0, 30) }),
  tag({ slug: 'note', label: 'Personal note', color: '#64748B', scope: 'personal', ownerUserId: 'me',
        source: 'human', producer: 'user', detectionKey: null, autoT0: null, confidence: null,
        note: 'Felt bow-down in the puffs — try more forestay next beat.',
        t0: T(12, 4), t1: T(12, 4, 15), meta: {} }),
  tag({ t0: T(12, 6), t1: T(12, 6, 24), confidence: 0.91,
        meta: { raceNum: 1, metrics: { bspBefore: 9.2, bspAfter: 8.8, timeTo95: 19, turnAngle: 72, target: 70, distLost: 38, tws: 14.2 } } }),
  tag({ t0: T(12, 9), t1: T(12, 9, 30), confidence: 0.34,
        meta: { raceNum: 1, logGap: true, shortHitch: true,
                metrics: { bspBefore: 4.1, bspAfter: 3.9, timeTo95: 48, turnAngle: 22, target: 70, tws: 6.1 } } }),
  tag({ slug: 'topmark', label: 'Top mark', color: '#EF4444', producer: 'eventfile', confidence: 0.98,
        t0: T(12, 20), t1: T(12, 20, 30), reelOrder: 1 }),
  tag({ slug: 'sail-change', label: 'A2 up', color: '#F59E0B', source: 'human', producer: 'user',
        detectionKey: null, autoT0: null, confidence: null, t0: T(12, 21, 30), t1: T(12, 21, 50),
        meta: { sail: {
          up: [{ id: 'i1', name: 'Main' }, { id: 'i5', name: 'A2' }],
          onBoard: [{ id: 'i1', name: 'Main' }, { id: 'i3', name: 'J2' }, { id: 'i4', name: 'J4' }, { id: 'i5', name: 'A2' }],
          battens: [{ no: 1, tension: 'soft', turns: 5 }, { no: 2, tension: 'medium', turns: 0 }, { no: 3, tension: 'stiff', turns: -2 }],
        } } }),
  tag({ slug: 'team-note', label: 'Team comment', color: '#7F77DD', source: 'human', producer: 'user',
        detectionKey: null, autoT0: null, confidence: null,
        note: 'Kite hourglassed at the hoist — halyard not clear.',
        t0: T(12, 21), t1: T(12, 21, 15), meta: { raceNum: 1 } }),
  tag({ slug: 'gybe', label: 'Gybe', color: '#7F77DD', t0: T(12, 31), t1: T(12, 31, 26), confidence: 0.58,
        editedFields: ['t0', 't1'], autoT0: T(12, 30, 56),
        meta: { raceNum: 1, atMark: true, metrics: { bspBefore: 12.4, bspAfter: 11.1, timeTo95: 31, turnAngle: 64, target: 60, distLost: 61, tws: 15.0 } } }),
  tag({ slug: 'gate', label: 'Leeward gate', color: '#8B5CF6', producer: 'eventfile', confidence: 0.6,
        t0: T(12, 50), t1: T(12, 50, 30), meta: { raceNum: 1, valid: false } }),
  tag({ slug: 'incident', label: 'Incident', color: '#EF4444', source: 'human', producer: 'user',
        detectionKey: null, autoT0: null, confidence: null,
        note: 'Nearly over early — committee boat end, 8 seconds.',
        t0: T(13, 55), t1: T(13, 55, 20), reelOrder: 2, meta: {} }),
  tag({ slug: 'race-start', label: 'Race 2 start', color: '#EF4444', producer: 'eventfile',
        confidence: 0.98, t0: T(13, 59), t1: T(14, 0, 30), meta: { raceNum: 2 } }),
  tag({ t0: T(14, 12), t1: T(14, 12, 20), confidence: 0.78, meta: { raceNum: 2 } }),
]

const requests: TagRequest[] = [
  { id: 'r1', teamId: 't', boatId: 'b', sessionDate: DAY, tagEventId: 'e7', kind: 'debrief',
    mediaKind: null, status: 'open', note: null, requestedByUserId: 'u2', requestedAt: T(16, 5),
    decidedByUserId: null, decidedAt: null, decisionNote: null, assetKind: null, assetId: null },
  { id: 'r2', teamId: 't', boatId: 'b', sessionDate: DAY, tagEventId: 'e7', kind: 'debrief',
    mediaKind: null, status: 'open', note: null, requestedByUserId: 'u3', requestedAt: T(16, 6),
    decidedByUserId: null, decidedAt: null, decisionNote: null, assetKind: null, assetId: null },
  { id: 'r3', teamId: 't', boatId: 'b', sessionDate: DAY, tagEventId: 'e7', kind: 'video',
    mediaKind: 'drone', status: 'open', note: 'from the hoist', requestedByUserId: 'me', requestedAt: T(16, 7),
    decidedByUserId: null, decidedAt: null, decisionNote: null, assetKind: null, assetId: null },
  { id: 'r4', teamId: 't', boatId: 'b', sessionDate: DAY, tagEventId: 'e8', kind: 'debrief',
    mediaKind: null, status: 'open', note: null, requestedByUserId: 'u2', requestedAt: T(16, 8),
    decidedByUserId: null, decidedAt: null, decisionNote: null, assetKind: null, assetId: null },
]

const segments = segmentDay({
  guns: [{ utc: T(12, 0), raceNum: 1 }, { utc: T(14, 0), raceNum: 2 }],
  markRoundings: [{ utc: T(12, 20) }, { utc: T(12, 50) }, { utc: T(14, 25) }],
  dayStartUtc: T(11, 20), dayStopUtc: T(15, 30),
})

// Enough of a boat to exercise the sail-change composer.
const INVENTORY = [
  { id: 'i1', name: 'Main' }, { id: 'i2', name: 'J1' }, { id: 'i3', name: 'J2' },
  { id: 'i4', name: 'J4' }, { id: 'i5', name: 'A2' }, { id: 'i6', name: 'A3' },
  { id: 'i7', name: 'Storm jib' },
]
// What went out on the water today — the storm jib and the J1 stayed ashore.
const ON_BOARD = INVENTORY.filter((s) => s.id !== 'i7' && s.id !== 'i2')
// Weights as an event file's sail list reports them.
const SAIL_KG: Record<string, number> = {
  i1: 116.6, i2: 62.5, i3: 58.4, i4: 44.1, i5: 49.2, i6: 41.7, i7: 18.9,
}
const BATTEN_CARD = normaliseBattenCard({
  count: 3,
  rows: [
    { '0-5': { tension: 'soft', turns: 5 }, '10-15': { tension: 'medium', turns: 2 }, '20-25': { tension: 'stiff', turns: -1 } },
    { '0-5': { tension: 'soft', turns: 3 }, '10-15': { tension: 'medium', turns: 0 } },
    { '10-15': { tension: 'stiff', turns: -2 } },
  ],
})
// The day's media, drawn on the track in the timeline's deck colours: two
// onboard clips and a drone one as stretches of water, photos and a sail scan
// as points.
const DAY_MEDIA = mediaMarks({
  videos: [
    { id: 'v1', start_utc: new Date(T(11, 58)).toISOString(), duration: 240, title: 'Onboard start' },
    { id: 'v2', start_utc: new Date(T(12, 18)).toISOString(), duration: 180, title: 'Onboard topmark' },
    { id: 'v3', start_utc: new Date(T(12, 4)).toISOString(), duration: 150, title: 'DJI_20260911120400_0036_D' },
  ],
  photos: [T(11, 52), T(12, 12), T(12, 23)].map((t, i) => ({ id: `p${i}`, taken_utc: new Date(t).toISOString() })),
  scans: [{ id: 's1', captured_at: new Date(T(11, 35)).toISOString(), conditions: { sail_code: 'M-2026' } }],
})

const SESSIONS = [
  { date: '2026-09-09', hasLog: true, event: 'Palma Week' },
  { date: '2026-09-10', hasLog: true, event: 'Palma Week' },
  { date: DAY, hasLog: true, event: 'Palma Week' },
]

type View = 'tagger' | 'track' | 'check' | 'debrief'

export default function TaggerPreview() {
  const [view, setView] = React.useState<View>('tagger')
  const [picked, setPicked] = React.useState<number | null>(null)
  const [day, setDay] = React.useState(DAY)
  const [sail, setSail] = React.useState<SailState>(() => sailStateAt(events, T(12, 34)))
  const [showSail, setShowSail] = React.useState(false)
  const [openId, setOpenId] = React.useState<string | null>(null)
  const [theme, setTheme] = React.useState<'dark' | 'light'>('dark')
  React.useEffect(() => { document.documentElement.setAttribute('data-theme', theme) }, [theme])

  const items = React.useMemo(() => withRequests(events, requests), [])
  const open = items.find((i) => i.tag.id === openId) || null
  const noop = () => {}

  return (
    <div className="relative flex h-[100dvh] flex-col overflow-hidden bg-bg text-fg">
      <div className="flex shrink-0 items-center gap-2 border-b border-[color:var(--border)] px-3 py-1.5 text-[11px] text-muted">
        <span>Tagger preview · fixture data</span>
        <button onClick={() => setShowSail((v) => !v)} className="min-h-[44px] px-2 underline">
          {showSail ? 'Hide sail change' : 'Sail change'}
        </button>
        <button onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))} className="ml-auto min-h-[44px] px-2 underline">
          {theme === 'dark' ? 'Light' : 'Dark'}
        </button>
      </div>

      <DayPicker date={day} sessions={SESSIONS} onSelect={setDay} />

      <div role="tablist" className="flex shrink-0 gap-1 border-b border-[color:var(--border)] bg-surface-1 p-2">
        {(['tagger', 'track', 'check', 'debrief'] as View[]).map((v) => (
          <button
            key={v}
            role="tab"
            aria-selected={view === v}
            onClick={() => setView(v)}
            className={`min-h-[44px] flex-1 rounded-lg text-sm font-medium capitalize ${
              view === v ? 'bg-accent text-accent-fg' : 'bg-surface-2 text-secondary'
            }`}
          >
            {v}
          </button>
        ))}
      </div>

      {showSail && (
        <div className="shrink-0 overflow-y-auto px-2 pt-2" style={{ maxHeight: '55dvh' }}>
          <SailChangeDetail
            value={sail}
            onChange={setSail}
            inventory={INVENTORY}
            dayList={ON_BOARD}
            weightOf={(s) => SAIL_KG[s.id || ''] ?? null}
            previous={{
              state: {
                up: [{ id: 'i1', name: 'Main' }, { id: 'i3', name: 'J2' }],
                onBoard: [{ id: 'i1', name: 'Main' }, { id: 'i3', name: 'J2' }],
                battens: [],
              },
              utc: T(11, 40),
            }}
            battenCard={BATTEN_CARD}
            battenCardSail="Main 2026"
            twsKn={12.4}
            onEditSailList={() => {}}
          />
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {view === 'tagger' && (
          <TagTrack items={items} segments={segments} currentUserId="me" onOpen={setOpenId} />
        )}
        {view === 'track' && (
          <TrackView
            rows={TRACK_ROWS} items={items} segments={segments}
            media={DAY_MEDIA}
            selectedUtc={picked} onSelect={setPicked} onOpenTag={setOpenId}
          />
        )}
        {view === 'check' && (
          <ReviewQueue
            tags={events} onVerify={noop} onReject={noop}
            onOpen={(t) => setOpenId(t.id)}
            keysPaused={!!open}
          />
        )}
        {view === 'debrief' && (
          <DebriefReel
            items={items} canCurate currentUserId="me"
            onNominate={noop} onSetReel={noop} onOpen={setOpenId}
          />
        )}
      </div>

      <TagButtonBar
        defs={defs.filter((d) => d.onButtonBar)}
        allDefs={defs}
        nowUtc={() => picked ?? T(12, 34)}
        bounds={{ min: T(11, 20), max: T(15, 30) }}
        onApply={async () => {}}
      />

      {open && (
        <TagSheet
          item={open}
          def={defs.find((d) => d.slug === open.tag.slug)}
          currentUserId="me"
          canApproveVideo
          canCurateReel
          onClose={() => setOpenId(null)}
          onVerify={noop} onReject={noop} onDelete={noop}
          onNote={noop} onLabel={noop}
          onRequestVideo={noop} onNominate={noop} onSetReel={noop}
          onSnap={noop} onReset={noop}
        />
      )}
    </div>
  )
}
