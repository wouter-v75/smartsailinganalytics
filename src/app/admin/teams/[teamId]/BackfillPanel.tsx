'use client'

// One-click backfill: reads local IDB videos and localStorage photo
// metadata in the user's browser, POSTs each to the (team, boat) videos /
// photos endpoints. Idempotent — re-running is safe (dedupe by Bunny IDs).
//
// Used to tag pre-multi-tenant test data with the right team + boat so
// later L3.D / L3.E features have something to chew on.

import { useState } from 'react'

interface Boat {
  id: string
  name: string
}

type Status = 'idle' | 'running' | 'done' | 'error'

interface Counts {
  videos_imported: number
  videos_failed: number
  photos_imported: number
  photos_failed: number
}

const initial: Counts = {
  videos_imported: 0,
  videos_failed: 0,
  photos_imported: 0,
  photos_failed: 0,
}

// Tiny inline IDB reader so we don't need to import localStore (it's
// bundled into the heavy SSA UI). The store name + key path mirror what
// localStore.openDb() sets up.
async function readIdbVideos(): Promise<Record<string, unknown>[]> {
  if (typeof indexedDB === 'undefined') return []
  return new Promise((resolve) => {
    const open = indexedDB.open('ssa-db')
    open.onerror = () => resolve([])
    open.onsuccess = () => {
      const db = open.result
      if (!db.objectStoreNames.contains('videos')) {
        resolve([])
        return
      }
      const tx = db.transaction('videos', 'readonly')
      const req = tx.objectStore('videos').getAll()
      req.onsuccess = () => resolve((req.result as Record<string, unknown>[]) || [])
      req.onerror = () => resolve([])
    }
  })
}

function readPhotosFromLS(): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (!k || !k.startsWith('ssa:photos-meta:')) continue
      const date = k.slice('ssa:photos-meta:'.length)
      try {
        const list = JSON.parse(localStorage.getItem(k) || '[]')
        if (Array.isArray(list)) {
          for (const p of list) {
            out.push({ ...(p as object), _date: date })
          }
        }
      } catch {
        /* skip malformed */
      }
    }
  } catch {
    /* localStorage unavailable */
  }
  return out
}

export default function BackfillPanel({
  teamId,
  boats,
}: {
  teamId: string
  boats: Boat[]
}) {
  const [boatId, setBoatId] = useState<string>(boats[0]?.id || '')
  const [status, setStatus] = useState<Status>('idle')
  const [counts, setCounts] = useState<Counts>(initial)
  const [err, setErr] = useState<string | null>(null)
  const [log, setLog] = useState<string[]>([])

  function append(line: string) {
    setLog((p) => [...p, line])
  }

  async function run() {
    if (!boatId) {
      setErr('Pick a boat first.')
      return
    }
    setErr(null)
    setStatus('running')
    setCounts(initial)
    setLog([])

    const localVideos = await readIdbVideos()
    const localPhotos = readPhotosFromLS()
    append(
      `Found ${localVideos.length} local videos and ${localPhotos.length} local photos.`
    )

    let videos_imported = 0
    let videos_failed = 0
    let photos_imported = 0
    let photos_failed = 0

    // ── videos ────────────────────────────────────────────────────────────
    for (const v of localVideos) {
      const vid = v as Record<string, unknown>
      const sessionDate = vid.sessionDate as string | undefined
      if (!sessionDate) {
        videos_failed++
        continue
      }
      const body = {
        session_date: sessionDate,
        title: (vid.title as string) || (vid.name as string) || null,
        start_utc: vid.startUtc
          ? new Date(vid.startUtc as number).toISOString()
          : null,
        duration_ms: vid.duration ? Math.round((vid.duration as number) * 1000) : null,
        tags: Array.isArray(vid.tags) ? (vid.tags as string[]) : [],
        bytes: (vid.size as number) ?? null,
        bunny_stream_id: (vid.streamId as string) || null,
        bunny_storage_path: (vid.r2Key as string) || null,
        external_id: vid.id as string,
      }
      try {
        const res = await fetch(
          `/api/teams/${teamId}/boats/${boatId}/videos`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          }
        )
        if (res.ok) videos_imported++
        else {
          videos_failed++
          const j = await res.json().catch(() => ({}))
          append(`✗ video ${body.title || body.external_id}: ${j.error || res.status}`)
        }
      } catch (e) {
        videos_failed++
        append(`✗ video ${body.title || body.external_id}: ${(e as Error).message}`)
      }
      setCounts({ videos_imported, videos_failed, photos_imported, photos_failed })
    }
    append(`✓ videos done — imported ${videos_imported}, failed ${videos_failed}`)

    // ── photos ────────────────────────────────────────────────────────────
    for (const p of localPhotos) {
      const ph = p as Record<string, unknown>
      const sessionDate = ph._date as string | undefined
      if (!sessionDate) {
        photos_failed++
        continue
      }
      const body = {
        session_date: sessionDate,
        taken_utc: ph.utc
          ? new Date(ph.utc as number).toISOString()
          : null,
        exif_data: ph.exif || null,
        thumbnail_url: (ph.thumbnailUrl as string) || (ph.url as string) || null,
        bunny_storage_path:
          (ph.bunnyPath as string) ||
          (ph.r2Key as string) ||
          (ph.url as string) ||
          null,
        bytes: (ph.size as number) ?? null,
        analysis_data: ph.analysis || null,
      }
      try {
        const res = await fetch(
          `/api/teams/${teamId}/boats/${boatId}/photos`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          }
        )
        if (res.ok) photos_imported++
        else {
          photos_failed++
          const j = await res.json().catch(() => ({}))
          append(`✗ photo ${body.bunny_storage_path}: ${j.error || res.status}`)
        }
      } catch (e) {
        photos_failed++
        append(`✗ photo: ${(e as Error).message}`)
      }
      setCounts({ videos_imported, videos_failed, photos_imported, photos_failed })
    }
    append(`✓ photos done — imported ${photos_imported}, failed ${photos_failed}`)

    setStatus('done')
  }

  return (
    <section className="mb-8">
      <h2 className="text-sm font-semibold text-slate-700 uppercase tracking-wide mb-2">
        Backfill local data
      </h2>
      <div className="bg-white rounded-xl shadow border border-slate-200 p-4">
        <p className="text-xs text-slate-500 mb-3">
          Imports videos + photos already on this device into this team / boat.
          Bunny blobs aren&apos;t touched. Re-running is safe (dedupes by Bunny ID).
          Use to tag existing test data.
        </p>
        <div className="flex flex-wrap gap-2 items-end">
          <label className="text-xs text-slate-600">
            Target boat
            <select
              value={boatId}
              onChange={(e) => setBoatId(e.target.value)}
              className="block mt-1 rounded-lg border border-slate-300 bg-white text-slate-900 px-2 py-1.5 text-sm"
              disabled={status === 'running'}
            >
              {boats.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
          <button
            onClick={run}
            disabled={status === 'running' || !boatId}
            className="rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white px-4 py-2 text-sm font-medium"
          >
            {status === 'running' ? 'Importing…' : 'Run backfill'}
          </button>
        </div>

        {err && <p className="mt-2 text-sm text-red-600">{err}</p>}

        {(status === 'running' || status === 'done') && (
          <div className="mt-3 text-xs text-slate-600 space-y-1">
            <div>
              Videos: {counts.videos_imported} imported, {counts.videos_failed} failed
            </div>
            <div>
              Photos: {counts.photos_imported} imported, {counts.photos_failed} failed
            </div>
            {log.length > 0 && (
              <pre className="mt-2 max-h-40 overflow-y-auto bg-slate-50 border border-slate-200 rounded p-2 text-[11px] whitespace-pre-wrap">
                {log.join('\n')}
              </pre>
            )}
          </div>
        )}
      </div>
    </section>
  )
}
