'use client'

// One-click wipe of legacy local storage. After L3.B/C/D/E migrations all
// authoritative data lives in Supabase. The legacy IDB + localStorage
// caches are useful as offline buffers but can drift. This panel lets the
// user wipe them manually once they've confirmed cloud has what they need.
//
// Wipes:
//   - IndexedDB `ssa-db` (videos + photos blobs)
//   - localStorage keys with prefix `ssa:` EXCEPT `ssa:active-membership:*`
//     (we don't want to log the user out / lose their team scope).
//   - Sync offsets, tag-list cache, etc.
//
// Does NOT wipe Supabase data. Does NOT wipe Bunny blobs.

import { useState } from 'react'

type Status = 'idle' | 'running' | 'done' | 'error'

interface WipeReport {
  idb_deleted: boolean
  localStorage_keys_removed: number
}

async function wipeIndexedDB(): Promise<boolean> {
  if (typeof indexedDB === 'undefined') return false
  return new Promise<boolean>((resolve) => {
    try {
      const req = indexedDB.deleteDatabase('ssa-db')
      req.onsuccess = () => resolve(true)
      req.onerror = () => resolve(false)
      req.onblocked = () => resolve(false)
    } catch {
      resolve(false)
    }
  })
}

function wipeLocalStorageKeys(): number {
  if (typeof localStorage === 'undefined') return 0
  const toRemove: string[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)
    if (!k) continue
    // Keep active-membership choices so the user stays scoped after wipe.
    if (k.startsWith('ssa:active-membership:')) continue
    if (k.startsWith('ssa:')) toRemove.push(k)
  }
  for (const k of toRemove) {
    try {
      localStorage.removeItem(k)
    } catch {
      /* ignore */
    }
  }
  return toRemove.length
}

export default function WipeLocalCachePanel() {
  const [status, setStatus] = useState<Status>('idle')
  const [report, setReport] = useState<WipeReport | null>(null)
  const [err, setErr] = useState<string | null>(null)

  async function run() {
    if (
      !confirm(
        "Wipe this browser's local SSA cache?\n\n" +
          'This deletes the legacy IndexedDB blobs + localStorage entries on this device only. ' +
          'Cloud data in Supabase + Bunny is NOT touched. Other devices/users are unaffected.\n\n' +
          'Useful after L3+ migrations to free disk space and avoid stale state.'
      )
    ) {
      return
    }
    setStatus('running')
    setErr(null)
    try {
      const idb = await wipeIndexedDB()
      const ls = wipeLocalStorageKeys()
      setReport({ idb_deleted: idb, localStorage_keys_removed: ls })
      setStatus('done')
    } catch (e) {
      setErr((e as Error).message)
      setStatus('error')
    }
  }

  return (
    <section className="mb-8">
      <h2 className="text-sm font-semibold text-slate-700 uppercase tracking-wide mb-2">
        Wipe local cache
      </h2>
      <div className="bg-white rounded-xl shadow border border-slate-200 p-4">
        <p className="text-xs text-slate-500 mb-3">
          Removes this browser&apos;s legacy IndexedDB + localStorage caches.
          Cloud data is untouched. Use after the L3 migrations to free disk
          space and stop the app dual-sourcing.
        </p>
        <button
          onClick={run}
          disabled={status === 'running'}
          className="rounded-lg bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white px-4 py-2 text-sm font-medium"
        >
          {status === 'running' ? 'Wiping…' : 'Wipe local cache'}
        </button>
        {err && <p className="mt-2 text-sm text-red-600">{err}</p>}
        {status === 'done' && report && (
          <p className="mt-3 text-xs text-slate-600">
            ✓ IndexedDB deleted: <strong>{String(report.idb_deleted)}</strong>{' '}
            · localStorage keys removed:{' '}
            <strong>{report.localStorage_keys_removed}</strong>. Reload the
            tab to start fresh from cloud.
          </p>
        )}
      </div>
    </section>
  )
}
