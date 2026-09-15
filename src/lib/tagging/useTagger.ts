'use client'
// src/lib/tagging/useTagger.ts
// ─────────────────────────────────────────────────────────────────────────────
// The tagger's data layer: one hook holding a day's vocabulary, tags and
// requests, and every action that changes them.
//
// Everything is OPTIMISTIC. The crew are tagging on a phone, on a boat, on
// whatever signal the marina has — a button that waits for a round trip before
// it looks pressed is a button people press twice. So the change lands in local
// state immediately and rolls back with a message if the server disagrees.
//
// The one thing deliberately NOT optimistic is `sync`: it can move dozens of
// tags, so it waits and then takes the server's word for the whole day.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Detection } from './detect'
import { withRequests } from './requests'
import { canEditTagEvent } from './gating'
import type {
  RequestKind, RequestMediaKind, RequestStatus,
  TagDef, TagEvent, TagLabel, TagRequest, TaggerIdentity, TagWithRequests,
} from './types'

export interface TaggerArgs {
  teamId?: string | null
  boatId?: string | null
  /** YYYY-MM-DD */
  date?: string | null
  sessionId?: string | null
  /** The signed-in user. Needed to decide what they may edit: the rule turns on
   *  authorship as well as role, and the server's does too. */
  userId?: string | null
}

export interface ApplyOptions {
  note?: string
  labels?: TagLabel[]
  t0?: number
  t1?: number
  targetKind?: string
  targetId?: string
  /** Structured payload the tag carries — a sail change's state, say. Stored in
   *  ssa_tag_events.meta; see src/lib/tagging/sailState.ts. */
  meta?: Record<string, unknown>
  /** Overrides the definition's label on this one application, so a sail change
   *  can read "Main + J2" in the list instead of "Sail change" nine times. */
  label?: string
}

/** Every edit the UI can make, named the way the API names them. */
export type TagOp =
  | { op: 'move'; delta_ms: number }
  | { op: 'window'; t0: number; t1: number }
  | { op: 'relabel'; slug: string; label?: string }
  | { op: 'verify' } | { op: 'unverify' }
  | { op: 'reject'; reason?: string } | { op: 'unreject' }
  | { op: 'reset' }
  | { op: 'reel'; order: number | null }
  | { op: 'note'; note: string | null }
  | { op: 'label-add'; group: string; text: string }
  | { op: 'label-remove'; group: string; text: string }
  /** A detail composer's whole answer — label, note, descriptors and meta —
   *  written together. See merge.recomposeTag. */
  | {
      op: 'recompose'
      label?: string
      note?: string | null
      labels?: TagLabel[]
      meta?: Record<string, unknown>
    }

const j = async (res: Response) => {
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body?.error || `${res.status}`)
  return body
}

export function useTagger({ teamId, boatId, date, sessionId, userId }: TaggerArgs) {
  const [defs, setDefs] = useState<TagDef[] | null>(null)
  const [events, setEvents] = useState<TagEvent[] | null>(null)
  const [requests, setRequests] = useState<TagRequest[]>([])
  const [me, setMe] = useState<Pick<TaggerIdentity, 'role' | 'sections'> | null>(null)
  const [can, setCan] = useState({ approveVideo: false, curateReel: false })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const ready = !!(teamId && boatId && date)
  const base = `/api/teams/${teamId}/tags`
  // Guards every async setState: the crew flick between days faster than a
  // marina wifi round trip completes.
  const gen = useRef(0)

  const load = useCallback(async () => {
    if (!ready) { setDefs([]); setEvents([]); return }
    const mine = ++gen.current
    setError(null)
    try {
      const [d, e, r] = await Promise.all([
        fetch(`${base}/defs?boat_id=${boatId}`).then(j),
        fetch(`${base}/events?boat_id=${boatId}&date=${date}`).then(j),
        fetch(`${base}/requests?boat_id=${boatId}&date=${date}`).then(j),
      ])
      if (gen.current !== mine) return
      setDefs(d.defs || [])
      setMe(d.me || null)
      setEvents(e.events || [])
      setRequests(r.requests || [])
      setCan(r.can || { approveVideo: false, curateReel: false })
    } catch (err) {
      if (gen.current !== mine) return
      setError(String((err as Error)?.message || err))
      setDefs([]); setEvents([])
    }
  }, [ready, base, boatId, date])

  useEffect(() => { load() }, [load])

  // ── Actions ───────────────────────────────────────────────────────────────

  /** One press. The server works out the window from the definition's lead/lag,
   *  so every client agrees and nobody posts a tag with no lead at all. */
  const apply = useCallback(async (slug: string, at: number, opts: ApplyOptions = {}) => {
    if (!ready) return null
    const def = (defs || []).find((d) => d.slug === slug)
    // Optimistic stand-in. Its id is replaced by the real row on the way back;
    // until then it is enough for the tag to appear under the thumb.
    const tempId = `pending:${Math.random().toString(36).slice(2)}`
    const lead = (def?.leadSec ?? 10) * 1000
    const lag = (def?.lagSec ?? 10) * 1000
    const optimistic: TagEvent = {
      id: tempId, teamId: teamId!, boatId: boatId!, sessionId: sessionId ?? null,
      sessionDate: date!, tagDefId: def?.id ?? null,
      slug, label: opts.label || def?.label || slug, color: def?.color || '#06B6D4',
      scope: def?.privateByDefault ? 'personal' : (def?.scope || 'general'),
      section: def?.privateByDefault ? null : (def?.section ?? null),
      ownerUserId: null,
      t0: opts.t0 ?? at - lead, t1: opts.t1 ?? at + lag,
      targetKind: (opts.targetKind as TagEvent['targetKind']) || 'track',
      targetId: opts.targetId ?? null,
      note: opts.note ?? null, labels: opts.labels || [],
      source: 'human', producer: 'user',
      detectionKey: null, autoT0: null, autoT1: null, confidence: null,
      editedFields: [], verifiedByUserId: null, verifiedAt: null,
      rejected: false, rejectedReason: null, reelOrder: null,
      createdByUserId: null, meta: opts.meta ?? null,
    }
    setEvents((prev) => [...(prev || []), optimistic].sort((a, b) => a.t0 - b.t0))

    try {
      const body = await j(await fetch(`${base}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          boat_id: boatId, session_date: date, session_id: sessionId ?? null,
          slug, at, note: opts.note, labels: opts.labels,
          t0: opts.t0, t1: opts.t1, meta: opts.meta, label: opts.label,
          target_kind: opts.targetKind, target_id: opts.targetId,
        }),
      }))
      setEvents((prev) => (prev || []).map((t) => (t.id === tempId ? body.event : t)))
      return body.event as TagEvent
    } catch (err) {
      setEvents((prev) => (prev || []).filter((t) => t.id !== tempId))
      setError(String((err as Error)?.message || err))
      return null
    }
  }, [ready, base, defs, teamId, boatId, date, sessionId])

  /** Apply an edit, showing it at once and putting it back if the server says no. */
  const patch = useCallback(async (id: string, op: TagOp) => {
    const before = (events || []).find((t) => t.id === id)
    if (!before) return null

    // Mirror the server's own rules closely enough that the optimistic state is
    // not a lie. Anything subtler than this waits for the response.
    const guess: Partial<TagEvent> =
      op.op === 'verify' ? { verifiedAt: Date.now() }
      : op.op === 'unverify' ? { verifiedAt: null, verifiedByUserId: null }
      : op.op === 'reject' ? { rejected: true, rejectedReason: op.reason ?? null, reelOrder: null }
      : op.op === 'unreject' ? { rejected: false, rejectedReason: null }
      : op.op === 'reel' ? { reelOrder: op.order }
      : op.op === 'note' ? { note: op.note }
      : op.op === 'move' ? { t0: before.t0 + op.delta_ms, t1: before.t1 + op.delta_ms }
      : op.op === 'window' ? { t0: Math.min(op.t0, op.t1), t1: Math.max(op.t0, op.t1) }
      : op.op === 'relabel' ? { slug: op.slug, label: op.label ?? before.label }
      : op.op === 'recompose' ? {
          ...(op.label ? { label: op.label } : {}),
          ...(op.note !== undefined ? { note: op.note } : {}),
          ...(op.labels ? { labels: op.labels } : {}),
          ...(op.meta ? { meta: { ...(before.meta || {}), ...op.meta } } : {}),
        }
      : op.op === 'label-add' ? { labels: [...(before.labels || []), { group: op.group, text: op.text }] }
      : op.op === 'label-remove'
        ? { labels: (before.labels || []).filter((l) => !(l.group === op.group && l.text === op.text)) }
        : {}

    setEvents((prev) => (prev || []).map((t) => (t.id === id ? { ...t, ...guess } : t)))
    try {
      const body = await j(await fetch(`${base}/events/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(op),
      }))
      setEvents((prev) => (prev || []).map((t) => (t.id === id ? body.event : t)))
      return body.event as TagEvent
    } catch (err) {
      setEvents((prev) => (prev || []).map((t) => (t.id === id ? before : t)))
      setError(String((err as Error)?.message || err))
      return null
    }
  }, [base, events])

  /** Remove. A detected tag becomes a tombstone server-side; the UI hides both. */
  const remove = useCallback(async (id: string) => {
    const before = events || []
    setEvents(before.filter((t) => t.id !== id))
    try {
      await j(await fetch(`${base}/events/${id}`, { method: 'DELETE' }))
      return true
    } catch (err) {
      setEvents(before)
      setError(String((err as Error)?.message || err))
      return false
    }
  }, [base, events])

  /** Ask for something: footage, or a place in tonight's debrief. */
  const request = useCallback(async (
    tagEventId: string,
    kind: RequestKind,
    opts: { mediaKind?: RequestMediaKind; note?: string } = {}
  ) => {
    try {
      const body = await j(await fetch(`${base}/requests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tag_event_id: tagEventId, kind,
          media_kind: kind === 'video' ? (opts.mediaKind || 'video') : undefined,
          note: opts.note,
        }),
      }))
      setRequests((prev) => {
        const next = prev.filter((r) => r.id !== body.request.id)
        return [...next, body.request]
      })
      return body.request as TagRequest
    } catch (err) {
      setError(String((err as Error)?.message || err))
      return null
    }
  }, [base])

  const decide = useCallback(async (
    id: string, status: RequestStatus, decisionNote?: string
  ) => {
    const before = requests
    setRequests((prev) => prev.map((r) => (r.id === id ? { ...r, status } : r)))
    try {
      const body = await j(await fetch(`${base}/requests`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, status, decision_note: decisionNote }),
      }))
      setRequests((prev) => prev.map((r) => (r.id === id ? body.request : r)))
      return body.request as TagRequest
    } catch (err) {
      setRequests(before)
      setError(String((err as Error)?.message || err))
      return null
    }
  }, [base, requests])

  const withdraw = useCallback(async (id: string) => {
    const before = requests
    setRequests((prev) => prev.filter((r) => r.id !== id))
    try {
      await j(await fetch(`${base}/requests?id=${id}`, { method: 'DELETE' }))
      return true
    } catch (err) {
      setRequests(before)
      setError(String((err as Error)?.message || err))
      return false
    }
  }, [base, requests])

  /**
   * Reconcile the day with what the detector found. NOT optimistic — it can move
   * dozens of tags at once, so it waits and takes the server's word for the day.
   */
  const sync = useCallback(async (detections: Detection[], dryRun = false) => {
    if (!ready) return null
    setBusy(true)
    setError(null)
    try {
      const body = await j(await fetch(`${base}/events/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          boat_id: boatId, session_date: date, session_id: sessionId ?? null,
          detections, dry_run: dryRun,
        }),
      }))
      if (!dryRun && body.events) setEvents(body.events)
      return body
    } catch (err) {
      setError(String((err as Error)?.message || err))
      return null
    } finally {
      setBusy(false)
    }
  }, [ready, base, boatId, date, sessionId])

  /** Seed the base vocabulary. Safe to call on an empty list; idempotent. */
  const seedVocabulary = useCallback(async () => {
    try {
      await j(await fetch(`${base}/defs/seed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ boat_id: null }),
      }))
      await load()
      return true
    } catch (err) {
      setError(String((err as Error)?.message || err))
      return false
    }
  }, [base, load])

  // ── Derived ───────────────────────────────────────────────────────────────

  const visible = useMemo(() => (events || []).filter((t) => !t.rejected), [events])

  const items: TagWithRequests[] = useMemo(
    () => withRequests(visible, requests), [visible, requests]
  )

  /**
   * May this user move, retime or delete this tag?
   *
   * The SAME rule the database enforces (canEditTagEvent mirrors 0062's
   * ssa_tag_events_update policy), asked on the client so the UI can offer the
   * handle rather than letting somebody drag a tag for three seconds and then
   * be told no. A UI that offers less than the server allows is a UI people
   * work around; one that offers more is one that lies.
   */
  const canEdit = useCallback((ev: TagEvent): boolean => {
    if (!me) return false
    return canEditTagEvent(ev, {
      userId: userId || '',
      teamId: teamId || '',
      boatId: boatId ?? null,
      role: me.role,
      sections: me.sections || [],
    })
  }, [me, userId, teamId, boatId])

  const buttonBar = useMemo(
    () => (defs || []).filter((d) => d.onButtonBar && (d as any).canApply !== false),
    [defs]
  )

  return {
    // data
    defs: defs || [], buttonBar, events: visible, allEvents: events || [],
    requests, items, me, can,
    loading: defs === null || events === null,
    busy, error,
    // actions
    canEdit,
    apply, patch, remove, request, decide, withdraw, sync, seedVocabulary,
    reload: load, clearError: () => setError(null),
  }
}
