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
import { sailStateAt, hasStatedDeck, weightAboard, type SailState } from '@/lib/tagging/sailState'
import { segmentDay } from '@/lib/tagging/segments'
import { withRequests } from '@/lib/tagging/requests'
import { canEditTagEvent } from '@/lib/tagging/gating'
import { findDuplicates, acceptedWith } from '@/lib/tagging/duplicates'
import { linkDay, missingFromInventory, type LinkableSail } from '@/lib/tagging/sailLink'
import DuplicateList from '@/components/tagging/DuplicateList'
import { UnknownSails } from '@/components/tagging/TaggerTab'
import { sailSheetDetail, type SailContext } from '@/components/tagging/sailChangeDetail.helpers'
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
          // The storm jib is NOT on the day's list — it was passed across from
          // the RIB when the forecast turned. The deck this states is what the
          // rest of the day carries, so the On board tab has to be able to draw
          // a sail the list has never heard of.
          onBoard: [{ id: 'i1', name: 'Main' }, { id: 'i3', name: 'J2' }, { id: 'i4', name: 'J4' }, { id: 'i5', name: 'A2' }, { id: 'i7', name: 'Storm jib' }],
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
  // A sail change the EVENT FILE recorded and nobody opened in the tagger: it
  // carries meta.sails (a plain list of names) and no meta.sail. It must still
  // say what was up.
  tag({ slug: 'sail-change', label: 'Sails changed', color: '#F59E0B', producer: 'eventfile',
        confidence: 0.98, t0: T(12, 15), t1: T(12, 15, 20),
        meta: { raceNum: 1, sails: ['Main', 'J4'] } }),
  // A sail the event file names that the boat's inventory has never heard of.
  tag({ slug: 'sail-change', label: 'A4 up', color: '#F59E0B', producer: 'eventfile',
        confidence: 0.98, t0: T(13, 20), t1: T(13, 20, 20),
        meta: { raceNum: 2, sails: ['Main', 'A4'] } }),
  // And one that is NOT new: the inventory's J4_A_2026 with a space where the
  // underscore should be. Adding it would give the boat two J4_As, the one the
  // file points at having no weight, no battens and no scans — so the bar
  // offers to link it instead.
  tag({ slug: 'sail-change', label: 'J4 up', color: '#F59E0B', producer: 'eventfile',
        confidence: 0.98, t0: T(13, 40), t1: T(13, 40, 20),
        meta: { raceNum: 2, sails: ['Main', 'J4_A 2026'] } }),
  tag({ slug: 'gate', label: 'Leeward gate', color: '#8B5CF6', producer: 'eventfile', confidence: 0.6,
        t0: T(12, 50), t1: T(12, 50, 30), meta: { raceNum: 1, valid: false } }),
  // Tagged on the water; the event file arrived that evening with its own. The
  // crew's carries a note and a place on the reel — which is what makes the
  // choice a real one rather than a coin toss.
  tag({ slug: 'gate', label: 'Leeward gate', color: '#8B5CF6', source: 'human', producer: 'user',
        detectionKey: null, autoT0: null, confidence: null, reelOrder: 3,
        note: 'Came in too hot, lost two lengths.',
        t0: T(12, 50, 14), t1: T(12, 50, 30), meta: { raceNum: 1 } }),
  tag({ slug: 'topmark', label: 'Top mark', color: '#EF4444', source: 'human', producer: 'user',
        detectionKey: null, autoT0: null, confidence: null,
        t0: T(12, 20, 9), t1: T(12, 20, 30), meta: { raceNum: 1 } }),
  // Two crew members tagging the same gybe, neither able to see what the other
  // pressed. Nobody's is authoritative, so the row asks by name.
  tag({ slug: 'mark', label: 'Mark', color: '#F59E0B', source: 'human', producer: 'user',
        detectionKey: null, autoT0: null, confidence: null, createdByUserId: 'me',
        t0: T(12, 40, 2), t1: T(12, 40, 20), meta: { raceNum: 1 } }),
  tag({ slug: 'mark', label: 'Mark', color: '#F59E0B', source: 'human', producer: 'user',
        detectionKey: null, autoT0: null, confidence: null, createdByUserId: 'u-sam',
        note: 'Late on the sheet.',
        t0: T(12, 40, 13), t1: T(12, 40, 30), meta: { raceNum: 1 } }),
  // One person, twice: a glove on a wet screen, or a press that did not look
  // like it registered.
  tag({ slug: 'rig-change', label: 'Rig', color: '#2DD4BF', source: 'human', producer: 'user',
        detectionKey: null, autoT0: null, confidence: null, createdByUserId: 'me',
        t0: T(13, 10), t1: T(13, 10, 15), meta: {} }),
  tag({ slug: 'rig-change', label: 'Rig', color: '#2DD4BF', source: 'human', producer: 'user',
        detectionKey: null, autoT0: null, confidence: null, createdByUserId: 'me',
        t0: T(13, 10, 6), t1: T(13, 10, 21), meta: {} }),
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
  { id: 'i7', name: 'Storm jib' }, { id: 'i8', name: 'J4_A_2026' },
]
// What went out on the water today — the storm jib and the J1 stayed ashore.
const ON_BOARD = INVENTORY.filter((s) => s.id !== 'i7' && s.id !== 'i2')
// Weights as an event file's sail list reports them.
const SAIL_KG: Record<string, number> = {
  i1: 116.6, i2: 62.5, i3: 58.4, i4: 44.1, i5: 49.2, i6: 41.7, i7: 18.9, i8: 43.8,
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
  // duration_ms, as the videos API actually returns it — the fixture used to
  // say `duration` and so hid the bug that drew every real clip as a dot.
  videos: [
    { id: 'v1', start_utc: new Date(T(11, 58)).toISOString(), duration_ms: 240_000, title: 'Onboard start' },
    { id: 'v2', start_utc: new Date(T(12, 18)).toISOString(), duration_ms: 180_000, title: 'Onboard topmark' },
    { id: 'v3', start_utc: new Date(T(12, 4)).toISOString(), duration_ms: 150_000, title: 'DJI_20260911120400_0036_D' },
    // Shorter than the thinned track's own sampling: it has to bracket out to
    // the samples either side rather than collapsing to a point.
    { id: 'v4', start_utc: new Date(T(12, 10)).toISOString(), duration_ms: 25_000, title: 'Onboard short' },
  ],
  photos: [T(11, 52), T(12, 12), T(12, 23)].map((t, i) => ({ id: `p${i}`, taken_utc: new Date(t).toISOString() })),
  scans: [{ id: 's1', captured_at: new Date(T(11, 35)).toISOString(), conditions: { sail_code: 'M-2026' } }],
})

// Who is on the boat, so a crew-vs-crew row can ask by name.
const CREW: Record<string, string> = { me: 'Wouter van Dam', 'u-sam': 'Sam Whitcombe' }

const SESSIONS = [
  { date: '2026-09-09', hasLog: true, event: 'Palma Week' },
  { date: '2026-09-10', hasLog: true, event: 'Palma Week' },
  { date: DAY, hasLog: true, event: 'Palma Week' },
]

// Everything the sail detail needs, from the fixtures above — so the sheet's
// sail editor can be opened without a session.
const SAIL_CTX: SailContext = {
  inventory: INVENTORY,
  weights: Object.fromEntries(INVENTORY.map((s) => [s.id, SAIL_KG[s.id]])),
  dayList: ON_BOARD,
  battenCards: [{ sailId: 'i1', card: BATTEN_CARD, updatedAt: null }],
  mainsailIds: ['i1'],
  loading: false,
  reload: () => {},
}

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

  // Held in state so a tag dragged on the track actually moves — the whole
  // point of the thing being previewed.
  const [evts, setEvts] = React.useState<TagEvent[]>(events)
  const [role, setRole] = React.useState<'tl3' | 'tl1'>('tl3')
  // The same derived view TaggerTab builds: every sail resolved to its
  // inventory row before anything folds the day.
  // Held in state, because linking a name writes an alias onto a sail and the
  // bar has to empty when it does.
  const [inventory, setInventory] = React.useState<LinkableSail[]>(INVENTORY)
  const linked = React.useMemo(() => linkDay(evts, inventory), [evts, inventory])
  const unknownSails = React.useMemo(() => missingFromInventory(evts, inventory), [evts, inventory])
  const items = React.useMemo(() => withRequests(linked, requests), [linked])
  const open = items.find((i) => i.tag.id === openId) || null
  // Somebody who is not the author: at tl3 they may retime anyone's tag, at tl1
  // only their own — which is what the menu has to reflect.
  const me = { userId: 'someone-else', teamId: 't', boatId: 'b', role, sections: [] }
  const noop = () => {}

  return (
    <div className="relative flex h-[100dvh] flex-col overflow-hidden bg-bg text-fg">
      <div className="flex shrink-0 items-center gap-2 border-b border-[color:var(--border)] px-3 py-1.5 text-[11px] text-muted">
        <span>Tagger preview · fixture data</span>
        <button onClick={() => setShowSail((v) => !v)} className="min-h-[44px] px-2 underline">
          {showSail ? 'Hide sail change' : 'Sail change'}
        </button>
        <button onClick={() => setRole((r) => (r === 'tl3' ? 'tl1' : 'tl3'))} className="min-h-[44px] px-2 underline">
          role: {role}
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
          <>
            {/* The real component, so what is previewed is what ships. Both
                answers are live: linking writes an alias onto the fixture
                inventory, which takes the name off the list exactly as the
                round trip through the sails API does. */}
            <UnknownSails
              names={unknownSails}
              inventory={inventory}
              busy={null}
              error={null}
              onAdd={(name) => setInventory((inv) => [...inv, { id: `new-${name}`, name }])}
              onLink={(name, id) => setInventory((inv) => inv.map(
                (s) => (s.id === id ? { ...s, aliases: [...(s.aliases || []), name] } : s)
              ))}
            />
            {/* The same two states TaggerTab renders: asked while unknown,
                stated once it is known. */}
            {hasStatedDeck(linked) ? (
              (() => {
                const deck = sailStateAt(linked, T(23, 0))
                const kg = weightAboard(deck, (x) => (x.id ? SAIL_KG[x.id] ?? null : null))
                return (
                  <div className="flex w-full items-center gap-2 border-b border-[color:var(--border)] bg-surface-1 px-3 py-2">
                    <span className="min-w-0 flex-1 truncate text-[11px] text-secondary">
                      <span className="font-semibold">On board</span>{' '}
                      {deck.onBoard.map((x) => x.name).join(' + ')}
                    </span>
                    {kg && <span className="shrink-0 font-mono text-[11px] text-muted">{kg.kg.toFixed(1)} kg</span>}
                  </div>
                )
              })()
            ) : (
              <div className="flex items-center gap-2 border-b border-[color:var(--border)] bg-accent-bg px-3 py-2">
                <span className="min-w-0 flex-1 text-xs text-accent">
                  What is on board today? Set it once and it holds for the day.
                </span>
                <button className="min-h-[40px] shrink-0 rounded-lg bg-accent px-3 text-xs font-semibold text-accent-fg">
                  Set the deck
                </button>
              </div>
            )}
            <TagTrack items={items} segments={segments} currentUserId="me" onOpen={setOpenId} />
          </>
        )}
        {view === 'track' && (
          <TrackView
            rows={TRACK_ROWS} items={items} segments={segments}
            media={DAY_MEDIA}
            canEditTag={(tag) => canEditTagEvent(tag, me)}
            onMoveTag={(id, utc) => setEvts((prev) => prev.map((e) => (
              e.id === id ? { ...e, t0: utc, t1: utc + (e.t1 - e.t0) } : e
            )))}
            selectedUtc={picked} onSelect={setPicked} onOpenTag={setOpenId}
          />
        )}
        {view === 'check' && (
          <>
            <DuplicateList
              pairs={findDuplicates(evts)}
              meId="me"
              nameOf={(id) => CREW[id] ?? null}
              canEdit={(tag) => canEditTagEvent(tag, me)}
              onOpen={setOpenId}
              onDrop={(p, drop) => setEvts((prev) =>
                drop.source === 'human'
                  ? prev.filter((e) => e.id !== drop.id)
                  : prev.map((e) => (e.id === drop.id ? { ...e, rejected: true } : e))
              )}
              onKeepBoth={(p) => setEvts((prev) => prev.map((e) => (
                e.id === p.a.id
                  ? { ...e, meta: { ...(e.meta || {}), dupOkWith: acceptedWith(p.a, p.b.id) } }
                  : e
              )))}
            />
            <ReviewQueue
              tags={evts} onVerify={noop} onReject={noop}
              onOpen={(t) => setOpenId(t.id)}
              keysPaused={!!open}
            />
          </>
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
          detail={sailSheetDetail({ tag: open.tag, events: linked, ctx: { ...SAIL_CTX, inventory } })}
          canEditDetail={canEditTagEvent(open.tag, me)}
          onRecompose={(patch) => setEvts((prev) => prev.map((e) => (
            e.id === open.tag.id
              ? {
                  ...e,
                  ...(patch.label ? { label: patch.label } : {}),
                  ...(patch.note !== undefined ? { note: patch.note } : {}),
                  ...(patch.labels ? { labels: patch.labels } : {}),
                  ...(patch.meta ? { meta: { ...(e.meta || {}), ...patch.meta } } : {}),
                }
              : e
          )))}
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
