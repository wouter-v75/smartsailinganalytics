import { describe, it, expect } from 'vitest'
import {
  planSync, planIsEmpty, isHumanTouched, driftFromDetector,
  moveTag, setTagWindow, relabelTag, verifyTag, unverifyTag,
  rejectTag, unrejectTag, resetToDetector, setReelOrder, addLabel, removeLabel,
  type SyncContext,
} from '../merge'
import type { Detection } from '../detect'
import type { TagEvent } from '../types'

const T = (mins: number) => Date.parse('2026-09-11T12:00:00Z') + mins * 60_000
const CTX: SyncContext = { teamId: 'team', boatId: 'boat', sessionDate: '2026-09-11' }

const detection = (over: Partial<Detection> = {}): Detection => ({
  key: 'boat:2026-09-11:r1:tack:1',
  slug: 'tack', label: 'Tack',
  t0: T(10), t1: T(10) + 22_000,
  segmentKey: 'r1', raceNum: 1,
  confidence: 0.8, producer: 'manoeuvres',
  ...over,
})

/** A row as planSync would have inserted it, optionally edited since. */
const row = (over: Partial<TagEvent> = {}): TagEvent => ({
  id: 'row-1',
  teamId: 'team', boatId: 'boat', sessionId: null, sessionDate: '2026-09-11',
  tagDefId: null, slug: 'tack', label: 'Tack', color: '#1D9E75',
  scope: 'general', section: null, ownerUserId: null,
  t0: T(10), t1: T(10) + 22_000,
  targetKind: 'track', targetId: null, note: null, labels: [],
  source: 'auto', producer: 'manoeuvres',
  detectionKey: 'boat:2026-09-11:r1:tack:1',
  autoT0: T(10), autoT1: T(10) + 22_000,
  confidence: 0.8, editedFields: [],
  verifiedByUserId: null, verifiedAt: null,
  rejected: false, rejectedReason: null, reelOrder: null,
  createdByUserId: null, meta: null,
  ...over,
})

// ─────────────────────────────────────────────────────────────────────────────
describe('planSync — the contract', () => {
  it('inserts a detection nobody has seen', () => {
    const plan = planSync([], [detection()], CTX)
    expect(plan.insert).toHaveLength(1)
    expect(plan.insert[0].detectionKey).toBe('boat:2026-09-11:r1:tack:1')
    expect(plan.insert[0].source).toBe('auto')
    expect(plan.insert[0].t0).toBe(plan.insert[0].autoT0)
    expect(plan.insert[0].verifiedAt).toBeNull()
  })

  it('does nothing when the detector repeats itself', () => {
    const plan = planSync([row()], [detection()], CTX)
    expect(planIsEmpty(plan)).toBe(true)
    expect(plan.summary.unchanged).toBe(1)
  })

  // ── THE guarantee ────────────────────────────────────────────────────────
  it('never moves a tag a human has moved', () => {
    const moved = row({ t0: T(10) + 4000, t1: T(10) + 26_000, editedFields: ['t0', 't1'] })
    const plan = planSync([moved], [detection({ t0: T(10) - 2000, t1: T(10) + 20_000 })], CTX)

    const patch = plan.update[0].patch
    expect(patch.t0).toBeUndefined()          // the human's position stands
    expect(patch.t1).toBeUndefined()
    expect(patch.autoT0).toBe(T(10) - 2000)   // …but the detector's view updates
  })

  it('keeps the detector’s view current so “snap back” means something', () => {
    const moved = row({ t0: T(10) + 4000, t1: T(10) + 26_000, editedFields: ['t0', 't1'] })
    const plan = planSync([moved], [detection({ t0: T(10) + 1000 })], CTX)
    const after = { ...moved, ...plan.update[0].patch }
    expect(driftFromDetector(after as TagEvent)).toBe(3000)
  })

  it('retimes a tag nobody has touched', () => {
    const plan = planSync([row()], [detection({ t0: T(11), t1: T(11) + 22_000 })], CTX)
    expect(plan.update[0].patch.t0).toBe(T(11))
    expect(plan.update[0].reasons).toContain('retimed')
  })

  it('never relabels a tag a human relabelled', () => {
    const fixed = row({ slug: 'gybe', label: 'Gybe', editedFields: ['slug'] })
    const plan = planSync([fixed], [detection({ slug: 'tack' })], CTX)
    expect(plan.update.find((u) => u.patch.slug)).toBeUndefined()
  })

  it('never touches descriptors, notes, verification or the reel', () => {
    const rich = row({
      labels: [{ group: 'Quality', text: 'slow' }],
      note: 'crew late on the runner',
      verifiedByUserId: 'u1', verifiedAt: T(60),
      reelOrder: 2,
    })
    const plan = planSync([rich], [detection({ t0: T(12), confidence: 0.4 })], CTX)
    const patch = plan.update[0].patch
    expect(patch.labels).toBeUndefined()
    expect(patch.note).toBeUndefined()
    expect(patch.verifiedAt).toBeUndefined()
    expect(patch.reelOrder).toBeUndefined()
    expect(patch.confidence).toBe(0.4)   // but the score is the detector's
  })

  // ── The tombstone ────────────────────────────────────────────────────────
  it('does not resurrect a rejected detection', () => {
    const tomb = row({ rejected: true, rejectedReason: 'that was a luff' })
    const plan = planSync([tomb], [detection()], CTX)
    expect(plan.insert).toHaveLength(0)
    expect(plan.update).toHaveLength(0)
    expect(plan.remove).toHaveLength(0)
    expect(plan.skipped).toEqual([{ key: 'boat:2026-09-11:r1:tack:1', reason: 'rejected' }])
  })

  it('holds the tombstone across repeated syncs', () => {
    let rows = [row({ rejected: true })]
    for (let i = 0; i < 3; i++) {
      const plan = planSync(rows, [detection({ t0: T(10) + i * 1000 })], CTX)
      expect(planIsEmpty(plan)).toBe(true)
      expect(plan.summary.skippedRejected).toBe(1)
      rows = rows.map((r) => ({ ...r }))
    }
  })

  // ── When the detector changes its mind ───────────────────────────────────
  it('removes an untouched auto row the detector no longer finds', () => {
    const plan = planSync([row()], [], CTX)
    expect(plan.remove).toEqual(['row-1'])
  })

  it('keeps a VERIFIED row the detector no longer finds, and flags it', () => {
    const vouched = row({ verifiedByUserId: 'u1', verifiedAt: T(60) })
    const plan = planSync([vouched], [], CTX)
    expect(plan.remove).toHaveLength(0)
    expect(plan.update[0].reasons).toContain('orphaned')
    expect((plan.update[0].patch.meta as any).orphaned).toBe(true)
    expect(plan.summary.orphaned).toBe(1)
  })

  it('keeps an EDITED row the detector no longer finds', () => {
    const plan = planSync([row({ editedFields: ['t0', 't1'] })], [], CTX)
    expect(plan.remove).toHaveLength(0)
    expect(plan.summary.orphaned).toBe(1)
  })

  it('clears the orphaned flag when the detector finds it again', () => {
    const lost = row({ verifiedAt: T(60), meta: { orphaned: true } })
    const plan = planSync([lost], [detection()], CTX)
    expect((plan.update[0].patch.meta as any).orphaned).toBe(false)
    expect(plan.update[0].reasons).toContain('refound')
  })

  it('does not re-flag a row already marked orphaned', () => {
    const lost = row({ verifiedAt: T(60), meta: { orphaned: true } })
    expect(planIsEmpty(planSync([lost], [], CTX))).toBe(true)
  })

  // ── Hand-placed tags ─────────────────────────────────────────────────────
  it('never touches a hand-placed tag', () => {
    const manual = row({ id: 'manual-1', detectionKey: null, source: 'human', producer: 'user', autoT0: null })
    const plan = planSync([manual], [detection()], CTX)
    expect(plan.remove).toHaveLength(0)
    expect(plan.update.find((u) => u.id === 'manual-1')).toBeUndefined()
    expect(plan.insert).toHaveLength(1)   // the detection still lands
  })

  it('uses the vocabulary’s label and colour when one exists', () => {
    const ctx: SyncContext = { ...CTX, lookup: (s) => (s === 'tack' ? { label: 'Tack ⛵', color: '#123456' } : null) }
    const plan = planSync([], [detection()], ctx)
    expect(plan.insert[0].label).toBe('Tack ⛵')
    expect(plan.insert[0].color).toBe('#123456')
  })

  it('handles a whole day changing shape at once', () => {
    const existing = [
      row({ id: 'a', detectionKey: 'k:1' }),
      row({ id: 'b', detectionKey: 'k:2', verifiedAt: T(60) }),
      row({ id: 'c', detectionKey: 'k:3', rejected: true }),
      row({ id: 'd', detectionKey: null, source: 'human' }),
    ]
    const found = [
      detection({ key: 'k:1', t0: T(20) }),   // retimed
      detection({ key: 'k:3' }),              // rejected — skipped
      detection({ key: 'k:9' }),              // brand new
    ]
    const plan = planSync(existing, found, CTX)
    expect(plan.insert.map((i) => i.detectionKey)).toEqual(['k:9'])
    expect(plan.remove).toEqual([])                       // 'b' was verified
    expect(plan.summary.orphaned).toBe(1)                 // …so it is flagged
    expect(plan.summary.skippedRejected).toBe(1)
    expect(plan.update.find((u) => u.id === 'a')!.reasons).toContain('retimed')
  })

  it('is idempotent — applying a plan then re-planning changes nothing', () => {
    const d = [detection({ t0: T(15) })]
    const plan1 = planSync([row()], d, CTX)
    const applied = { ...row(), ...plan1.update[0].patch } as TagEvent
    expect(planIsEmpty(planSync([applied], d, CTX))).toBe(true)
  })

  it('survives empty input', () => {
    expect(planIsEmpty(planSync([], [], CTX))).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('the sanctioned edits', () => {
  it('moveTag shifts BOTH endpoints — writing t0 alone trips the window CHECK', () => {
    const p = moveTag(row(), 4000)
    expect(p.t0).toBe(T(10) + 4000)
    expect(p.t1).toBe(T(10) + 26_000)
    expect(p.editedFields).toEqual(['t0', 't1'])
  })

  it('moveTag is a no-op for zero or junk', () => {
    expect(moveTag(row(), 0)).toEqual({})
    expect(moveTag(row(), NaN)).toEqual({})
  })

  it('moveTag accumulates claims rather than replacing them', () => {
    const p = moveTag(row({ editedFields: ['slug'] }), 1000)
    expect(p.editedFields).toEqual(['slug', 't0', 't1'])
  })

  it('setTagWindow normalises a window dragged inside out', () => {
    const p = setTagWindow(row(), T(12), T(11))   // "start" dropped after "end"
    expect(p.t0).toBe(T(11))
    expect(p.t1).toBe(T(12))
    expect(p.editedFields).toEqual(['t0', 't1'])
  })

  it('setTagWindow claims only the edge that moved, and nothing for a no-op', () => {
    expect(setTagWindow(row(), T(10), T(10) + 22_000)).toEqual({})           // unchanged
    expect(setTagWindow(row(), T(10) + 22_000, T(10))).toEqual({})           // same, reversed
    expect(setTagWindow(row(), T(10), T(10) + 30_000).editedFields).toEqual(['t1'])
    expect(setTagWindow(row(), T(9), T(10) + 22_000).editedFields).toEqual(['t0'])
    expect(setTagWindow(row(), NaN, T(11))).toEqual({})
  })

  it('relabelTag claims the slug', () => {
    expect(relabelTag(row(), 'gybe').editedFields).toEqual(['slug'])
    expect(relabelTag(row(), 'tack')).toEqual({})   // already that
    expect(relabelTag(row(), 'gybe', 'Gybe').editedFields).toEqual(['slug', 'label'])
  })

  it('verify and unverify round-trip', () => {
    const v = verifyTag(row(), 'u1', T(60))
    expect(v.verifiedByUserId).toBe('u1')
    expect(verifyTag({ ...row(), ...v } as TagEvent, 'u2')).toEqual({})
    expect(unverifyTag({ ...row(), ...v } as TagEvent).verifiedAt).toBeNull()
    expect(unverifyTag(row())).toEqual({})
  })

  it('rejecting takes a tag off the reel', () => {
    const p = rejectTag(row({ reelOrder: 3 }), 'that was a luff')
    expect(p.rejected).toBe(true)
    expect(p.rejectedReason).toBe('that was a luff')
    expect(p.reelOrder).toBeNull()
  })

  it('unrejecting lifts the tombstone', () => {
    const tomb = row({ rejected: true, rejectedReason: 'x' })
    expect(unrejectTag(tomb)).toEqual({ rejected: false, rejectedReason: null })
    expect(unrejectTag(row())).toEqual({})
  })

  it('resetToDetector returns the tag and releases every claim', () => {
    const edited = row({ t0: T(14), t1: T(15), editedFields: ['t0', 't1', 'slug'] })
    const p = resetToDetector(edited)
    expect(p.t0).toBe(T(10))
    expect(p.editedFields).toEqual([])
    // …and then the next sync tends it again.
    const applied = { ...edited, ...p } as TagEvent
    const plan = planSync([applied], [detection({ t0: T(11) })], CTX)
    expect(plan.update[0].patch.t0).toBe(T(11))
  })

  it('resetToDetector does nothing to a hand-placed tag', () => {
    expect(resetToDetector(row({ autoT0: null }))).toEqual({})
  })

  it('manages the reel and descriptors', () => {
    expect(setReelOrder(row(), 1)).toEqual({ reelOrder: 1 })
    expect(setReelOrder(row({ reelOrder: 1 }), 1)).toEqual({})
    const withLabel = addLabel(row(), { group: 'Quality', text: 'slow' })
    expect(withLabel.labels).toHaveLength(1)
    expect(addLabel({ ...row(), ...withLabel } as TagEvent, { group: 'Quality', text: 'slow' })).toEqual({})
    expect(removeLabel({ ...row(), ...withLabel } as TagEvent, { group: 'Quality', text: 'slow' }).labels).toEqual([])
    expect(removeLabel(row(), { group: 'Quality', text: 'nope' })).toEqual({})
  })
})

describe('isHumanTouched', () => {
  it('spots every way a person leaves a mark', () => {
    expect(isHumanTouched(row())).toBe(false)
    expect(isHumanTouched(row({ editedFields: ['t0'] }))).toBe(true)
    expect(isHumanTouched(row({ verifiedAt: T(1) }))).toBe(true)
    expect(isHumanTouched(row({ rejected: true }))).toBe(true)
    expect(isHumanTouched(row({ labels: [{ group: 'Q', text: 'slow' }] }))).toBe(true)
    expect(isHumanTouched(row({ note: 'hi' }))).toBe(true)
    expect(isHumanTouched(row({ reelOrder: 0 }))).toBe(true)
  })
})

describe('the detector’s evidence travels with the tag', () => {
  it('carries metrics onto a new row, so the review queue can show them', () => {
    const plan = planSync([], [detection({
      metrics: { bspBefore: 9.1, bspAfter: 8.4, timeTo95: 22, turnAngle: 71, target: 70 },
    })], CTX)
    const m = (plan.insert[0].meta as any).metrics
    expect(m.turnAngle).toBe(71)
    expect(m.timeTo95).toBe(22)
  })

  it('refreshes metrics on re-derivation — they are derived, not authored', () => {
    const existing = row({ meta: { segmentKey: 'r1', metrics: { turnAngle: 40 } } })
    const plan = planSync([existing], [detection({ metrics: { turnAngle: 71 } })], CTX)
    expect((plan.update[0].patch.meta as any).metrics.turnAngle).toBe(71)
  })

  it('settles metrics and the orphaned flag in ONE meta write', () => {
    // Two separate writes to `meta` would lose whichever went first.
    const lost = row({
      verifiedAt: T(60),
      meta: { orphaned: true, metrics: { turnAngle: 40 }, segmentKey: 'r1' },
    })
    const plan = planSync([lost], [detection({ metrics: { turnAngle: 71 } })], CTX)
    const meta = plan.update[0].patch.meta as any
    expect(meta.orphaned).toBe(false)
    expect(meta.metrics.turnAngle).toBe(71)
    expect(meta.segmentKey).toBe('r1')      // untouched keys survive
  })

  it('does not churn when the metrics are unchanged', () => {
    const existing = row({ meta: { metrics: { turnAngle: 71 } } })
    const plan = planSync([existing], [detection({ metrics: { turnAngle: 71 } })], CTX)
    expect(planIsEmpty(plan)).toBe(true)
  })
})
