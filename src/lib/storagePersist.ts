// Storage durability (Phase 4).
//
// Browsers evict an origin's IndexedDB/Cache all-at-once under storage pressure,
// and iOS Safari purges after ~7 days of no interaction. To protect not-yet-
// synced captures we (a) request persistent storage, and (b) pre-flight large
// writes against the quota, LRU-evicting our own already-uploaded originals
// (lossless — they're in the cloud) to make room. Server stays authoritative so
// a full wipe is always recoverable. See docs/sync-caching-architecture-research.md.

import { evictSyncedOriginals } from './photoStore'

// Ask the browser to keep our storage across eviction sweeps. On Chromium/Safari
// this is granted silently via heuristics (site engagement / installed as a PWA);
// Firefox prompts. Safe to call repeatedly. Returns the resulting persisted flag.
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (typeof navigator === 'undefined' || !navigator.storage?.persist) return false
    if (navigator.storage.persisted && (await navigator.storage.persisted())) return true
    return await navigator.storage.persist()
  } catch {
    return false
  }
}

export interface StorageEstimate {
  usage: number
  quota: number
  pct: number
}

export async function estimateStorage(): Promise<StorageEstimate | null> {
  try {
    if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return null
    const { usage = 0, quota = 0 } = await navigator.storage.estimate()
    return { usage, quota, pct: quota ? usage / quota : 0 }
  } catch {
    return null
  }
}

// Ensure there's headroom before a big write. If we're within `thresholdPct` of
// the quota (or short of `neededBytes`), LRU-evict already-synced originals.
// Best-effort; never throws. Returns the number of blobs evicted.
export async function ensureStorageHeadroom({
  neededBytes = 0,
  thresholdPct = 0.9,
  keep = 40,
}: { neededBytes?: number; thresholdPct?: number; keep?: number } = {}): Promise<number> {
  try {
    const est = await estimateStorage()
    if (!est) return 0
    const tight = est.pct >= thresholdPct || (est.quota > 0 && est.quota - est.usage < neededBytes)
    if (!tight) return 0
    return await evictSyncedOriginals({ keep })
  } catch {
    return 0
  }
}
