'use client'
import * as React from 'react'
import TagButtonBar from '@/components/tagging/TagButtonBar'
import TagTrack from '@/components/tagging/TagTrack'
import ReviewQueue from '@/components/tagging/ReviewQueue'
import DebriefReel from '@/components/tagging/DebriefReel'
import TagSheet from '@/components/tagging/TagSheet'
import { segmentDay } from '@/lib/tagging/segments'
import { withRequests } from '@/lib/tagging/requests'
import { BASE_TAGS } from '@/lib/tagging/baseTags'
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

const events: TagEvent[] = [
  tag({ slug: 'sail-change', label: 'J2 + Main', color: '#F59E0B', source: 'human', producer: 'user',
        detectionKey: null, autoT0: null, confidence: null, t0: T(11, 40), t1: T(11, 40, 20),
        labels: [{ group: 'Change', text: 'hoist' }], meta: {} }),
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

type View = 'track' | 'check' | 'debrief'

export default function TaggerPreview() {
  const [view, setView] = React.useState<View>('track')
  const [openId, setOpenId] = React.useState<string | null>(null)
  const [theme, setTheme] = React.useState<'dark' | 'light'>('dark')
  React.useEffect(() => { document.documentElement.setAttribute('data-theme', theme) }, [theme])

  const items = React.useMemo(() => withRequests(events, requests), [])
  const open = items.find((i) => i.tag.id === openId) || null
  const noop = () => {}

  return (
    <div className="flex h-[100dvh] flex-col bg-bg text-fg">
      <div className="flex shrink-0 items-center gap-2 border-b border-[color:var(--border)] px-3 py-1.5 text-[11px] text-muted">
        <span>Tagger preview · fixture data</span>
        <button onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))} className="ml-auto min-h-[44px] px-2 underline">
          {theme === 'dark' ? 'Light' : 'Dark'}
        </button>
      </div>

      <div role="tablist" className="flex shrink-0 gap-1 border-b border-[color:var(--border)] bg-surface-1 p-2">
        {(['track', 'check', 'debrief'] as View[]).map((v) => (
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

      <div className="min-h-0 flex-1 overflow-y-auto">
        {view === 'track' && (
          <TagTrack items={items} segments={segments} currentUserId="me" onOpen={setOpenId} />
        )}
        {view === 'check' && (
          <ReviewQueue tags={events} onVerify={noop} onReject={noop} onOpen={(t) => setOpenId(t.id)} />
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
        nowUtc={() => T(12, 34)}
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
