// src/lib/favourites.ts
// ─────────────────────────────────────────────────────────────────────────────
// The signed-in user's favourite photos and videos, held ONCE for the whole app.
//
// A heart appears on a thumbnail and again in the viewer that thumbnail opens,
// often in different components and tabs. Each asking the server on its own
// would put the two out of step for a round trip — press the heart in the
// viewer, close it, and the card still says no. So there is one set, loaded on
// first use, changed optimistically, and every heart subscribes to it.
//
// `available` is false until migration 0098 exists: the hearts and the filter
// buttons then stay out of sight rather than failing on every press.
// ─────────────────────────────────────────────────────────────────────────────

import { useMemo, useSyncExternalStore } from 'react'

export type FavKind = 'photo' | 'video'

interface State { loaded: boolean; available: boolean; keys: ReadonlySet<string> }

let state: State = { loaded: false, available: false, keys: new Set() }
let loading: Promise<void> | null = null
const listeners = new Set<() => void>()

const keyOf = (kind: FavKind, id: string) => `${kind}:${id}`
const emit = () => { for (const l of Array.from(listeners)) l() }
const set = (next: Partial<State>) => { state = { ...state, ...next }; emit() }

function load(): Promise<void> {
  if (loading) return loading
  loading = fetch('/api/favourites')
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => {
      if (!j) { set({ loaded: true }); return }
      const keys = new Set<string>()
      for (const id of j.photo || []) keys.add(keyOf('photo', id))
      for (const id of j.video || []) keys.add(keyOf('video', id))
      set({ loaded: true, available: j.available !== false, keys })
    })
    .catch(() => { loading = null; set({ loaded: true }) })
  return loading
}

function subscribe(l: () => void) {
  listeners.add(l)
  if (!state.loaded) load()
  return () => { listeners.delete(l) }
}
const snapshot = () => state
const serverSnapshot = () => state

export function isFavourite(kind: FavKind, id: string | null | undefined): boolean {
  return !!id && state.keys.has(keyOf(kind, id))
}

/** Flip one heart. Optimistic; put back, and the error returned, if the server says no. */
export async function setFavourite(kind: FavKind, id: string, favourite: boolean): Promise<string | null> {
  const k = keyOf(kind, id)
  const before = state.keys
  const next = new Set(before)
  if (favourite) next.add(k); else next.delete(k)
  set({ keys: next })
  try {
    const r = await fetch('/api/favourites', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, id, favourite }),
    })
    if (r.ok) return null
    const j = await r.json().catch(() => null)
    throw new Error(j?.error || `HTTP ${r.status}`)
  } catch (e) {
    // Undo only this key: another heart may have moved meanwhile.
    const undo = new Set(state.keys)
    if (before.has(k)) undo.add(k); else undo.delete(k)
    set({ keys: undo })
    return e instanceof Error ? e.message : String(e)
  }
}

/** The whole set, re-rendering the caller whenever any heart changes. */
export function useFavourites() {
  const s = useSyncExternalStore(subscribe, snapshot, serverSnapshot)
  // Stable while the set is: callers put this in memo deps (the timeline's lanes).
  return useMemo(() => ({
    available: s.available,
    loaded: s.loaded,
    has: (kind: FavKind, id: string | null | undefined) => !!id && s.keys.has(keyOf(kind, id)),
    count: s.keys.size,
  }), [s])
}

// ── identities ───────────────────────────────────────────────────────────────
// A favourite is keyed on the CLOUD row, because that is the one thing every
// device and every tab agrees on. Local-only media has none, so no heart.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A library video's cloud id: stamped on a local clip as cloudId, or its own id when it came from the cloud. */
export function videoFavId(v: { id?: unknown; cloudId?: unknown } | null | undefined): string | null {
  if (!v) return null
  if (typeof v.cloudId === 'string' && UUID.test(v.cloudId)) return v.cloudId
  return typeof v.id === 'string' && UUID.test(v.id) ? v.id : null
}

/** A Photos-tab photo's cloud id (PhotosTab stamps cloudId on local and cloud-only photos alike). */
export function photoFavId(p: { cloudId?: unknown } | null | undefined): string | null {
  return p && typeof p.cloudId === 'string' && UUID.test(p.cloudId) ? p.cloudId : null
}

/** For tests: forget everything. */
export function _resetFavourites() {
  state = { loaded: false, available: false, keys: new Set() }
  loading = null
}
