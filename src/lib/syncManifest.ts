// Per-session sync manifest — a tiny JSON object in Bunny Storage that records
// the content hashes of what's already in the cloud for a session. Before an
// upload we read this (a few hundred bytes) and SKIP the transfer when the local
// content hash already matches the cloud's. This is the cloud-authoritative
// replacement for local "synced" flags. See
// docs/sync-caching-architecture-research.md (Phases 1–2).

import { fetchSessionFile, uploadSessionFile } from './bunny'
import { SESSION_LEAVES, type StorageScope } from './storageKeys'

export interface SyncManifest {
  version: number
  updatedAt: number
  log?: { hash: string; rows?: number; uploadedAt: number } | null
  xml?: { hash: string; uploadedAt: number } | null
  // Reserved for future per-asset reconciliation (videos/photos already carry
  // their own cloud rows; kept here so a single fetch can answer "what's up?").
  videos?: Record<string, { streamId?: string | null }>
  photos?: { count?: number } | null
}

// The manifest is per (team, boat, date) now — it used to be per date alone, so two
// boats sailing the same day shared one manifest and each read the other's hashes.
// See src/lib/storageKeys.ts.

// Read the manifest for a session. Returns null if none exists yet (first sync)
// or on any network error — callers must treat "no manifest" as "upload".
export async function readSyncManifest(
  date: string,
  scope?: StorageScope | null
): Promise<SyncManifest | null> {
  const m = (await fetchSessionFile(scope, date, SESSION_LEAVES.syncManifest)) as SyncManifest | null
  if (!m || typeof m !== 'object') return null
  return m
}

// Write the manifest, stamping updatedAt. Best-effort; returns success bool.
export async function writeSyncManifest(
  date: string,
  manifest: SyncManifest,
  scope?: StorageScope | null
): Promise<boolean> {
  return uploadSessionFile(scope, date, SESSION_LEAVES.syncManifest, {
    ...manifest, version: 1, updatedAt: Date.now(),
  })
}

// Read-modify-write merge. `base` (if provided) is used for optimistic
// concurrency: we only overwrite when the cloud manifest hasn't advanced past
// what we last saw. On a lost race we re-read and merge onto the newer copy so
// two devices don't clobber each other's hashes.
export async function updateSyncManifest(
  date: string,
  patch: Partial<SyncManifest>,
  base?: SyncManifest | null,
  scope?: StorageScope | null
): Promise<SyncManifest> {
  const current = (await readSyncManifest(date, scope)) || { version: 1, updatedAt: 0 }
  // If someone else advanced the manifest since we based our decision on it,
  // merge onto the current cloud copy (our patch still applies — we only add
  // hashes we just uploaded).
  const merged: SyncManifest = {
    ...current,
    ...patch,
    version: 1,
    updatedAt: Date.now(),
  }
  if (base && current.updatedAt > base.updatedAt) {
    // Preserve any log/xml the other writer added that we aren't touching.
    if (!patch.log && current.log) merged.log = current.log
    if (!patch.xml && current.xml) merged.xml = current.xml
  }
  await writeSyncManifest(date, merged, scope)
  return merged
}
