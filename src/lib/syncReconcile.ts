// Cloud-state reconciliation (Phase 2).
//
// On session load / boat switch we compare the LOCAL content hash of the log/xml
// against the cloud SYNC MANIFEST. If the cloud already holds this exact content
// (another device pushed it, or a previous session whose local "synced" flag was
// lost), we mark it synced locally — so the unsynced badge is truthful and we
// never re-upload something already there. Cloud state is authoritative; local
// flags are only a cache. See docs/sync-caching-architecture-research.md.

import { getLogData, getXmlData, updateSessionSync } from './localStore'
import { hashLogPayload } from './contentHash'
import { readSyncManifest } from './syncManifest'

// Reconcile one session's log/xml sync state against the cloud manifest.
// Cheap: one small manifest GET + local reads. Best-effort (network optional).
export async function reconcileSessionSyncState(date: string): Promise<void> {
  if (!date) return
  let manifest = null
  try { manifest = await readSyncManifest(date) } catch { /* offline — skip */ }

  const patch: Record<string, string> = {}

  try {
    const log = (await getLogData(date)) as { rows?: unknown[]; contentHash?: string } | null
    if (log?.rows?.length) {
      // Log rows/start/end live at the row top level, so recomputing matches the
      // save-time hash; fall back to the stored contentHash for legacy rows.
      const h = log.contentHash || hashLogPayload(log as never)
      if (h) {
        patch.logHash = h
        if (manifest?.log?.hash === h) patch.logSyncedHash = h
      }
    }
  } catch { /* ignore */ }

  try {
    // XML row shape differs from the parsed object we hashed at save time, so we
    // trust the stored contentHash rather than recomputing from the row.
    const xml = (await getXmlData(date)) as { contentHash?: string } | null
    const h = xml?.contentHash
    if (h) {
      patch.xmlHash = h
      if (manifest?.xml?.hash === h) patch.xmlSyncedHash = h
    }
  } catch { /* ignore */ }

  if (Object.keys(patch).length) updateSessionSync(date, patch)
}
