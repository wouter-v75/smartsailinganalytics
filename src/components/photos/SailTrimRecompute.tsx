'use client'
// src/components/photos/SailTrimRecompute.tsx
// ─────────────────────────────────────────────────────────────────────────────
// Redo a day's stored sail geometry after a rig datum improves.
//
// WHY IT DRIVES THE REAL TAB. When Northstar 76's wheel depth went from a
// -10 000 guess to the designer's -7392, every number measured against the
// wheels became about 2 % large — and the only honest way to correct one is to
// put the operator's clicks back through the pipeline that produced them. So
// this mounts SailTrimTab itself, offscreen, one frame at a time, and lets it
// restore, recompute and save exactly as it would if somebody had opened the
// frame and pressed the button. It computes NOTHING of its own: the last time
// this repo grew a second implementation of the depth correction, the two agreed
// until they silently didn't, and four stations collapsed onto a flat -5700 with
// residuals of 5-41 mm and nothing saying so.
//
// `restoreFrom` is what makes that safe: it puts the marks and the CHOICES back
// (scale reference, baseline, heel, tack) but deliberately not the rig model,
// which comes from the cloud. Same clicks, current datums.
//
// It offers itself only when there is something to do, so the panel is invisible
// on a day whose frames are already current.
// ─────────────────────────────────────────────────────────────────────────────

import React from 'react'
import dynamic from 'next/dynamic'
import { photoOriginalUrl } from '../../lib/photoStore'
import { fetchRigModel, type RigModel } from '../../lib/rigModel'
import { isAnnotation, type SailTrimAnnotation } from '../../lib/sailTrimOverlay'
import {
  resolveStoredScale, scaleDrift, baselineDrift, driftNote,
  type MarksBundle, type ResultCalibration, type StoredScale,
} from '../../lib/sailTrimAudit'
import type { SailTrimSave } from '../sailtrim/SailTrimTab'

// Loaded only when a redo is actually run: the tab is the largest component in
// the app and every Photos tab would otherwise pay for it.
const SailTrimTab = dynamic(() => import('../sailtrim/SailTrimTab'), { ssr: false })

/** A frame does not settle for ever. Past this it is reported, not silently left. */
const FRAME_TIMEOUT_MS = 45_000

interface StoredPayload {
  annotation?: SailTrimAnnotation
  result?: { boat?: string; marks?: MarksBundle; calibration?: ResultCalibration }
}

export interface StalePhoto {
  photo: Record<string, unknown>
  id: string
  name: string
  url: string
  /** PER FRAME, never per day. One 26 Sep afternoon holds three Northstar
   *  frames and three of Capricorno, and measuring one as the other is how a
   *  boat got scaled by another boat's P. */
  boat: string
  stored: StoredPayload
  reasons: string[]
  /** Headline numbers before the redo, so the change is visible afterwards. */
  before: { key: string; mm: number }[]
}

/** Tolerant of the string form, and of a payload with no annotation at all. */
export function parseStored(photo: Record<string, unknown>): StoredPayload | null {
  const raw = photo?.sailtrim_data
  if (!raw) return null
  let parsed: unknown
  try { parsed = typeof raw === 'string' ? JSON.parse(raw) : raw } catch { return null }
  const p = parsed as StoredPayload | null
  if (!p || !isAnnotation(p.annotation)) return null
  return p
}

/** The boat a frame was MEASURED as — which is the question, and not always the
 *  boat the photo is filed under. */
export function boatOf(photo: Record<string, unknown>, stored: StoredPayload): string {
  return (stored.annotation?.scale as StoredScale | undefined)?.boat
    || stored.result?.boat
    || (stored.result?.marks?.rig as { boat?: string } | undefined)?.boat
    || String(photo.boat || '')
}

/** Which of a day's frames were measured against a datum that has since moved. */
export function staleFrames(
  photos: Record<string, unknown>[],
  rigs: Map<string, RigModel>,
  activeDate: string | null,
): StalePhoto[] {
  const out: StalePhoto[] = []
  for (const photo of photos || []) {
    const stored = parseStored(photo)
    if (!stored?.annotation) continue
    const boat = boatOf(photo, stored)
    const rig = rigs.get(boat.toLowerCase())
    // No boat, or no model for it, is "cannot tell" — and a redo that guessed
    // the boat would be worse than leaving it alone. The audit script names
    // these; this panel simply does not offer to touch them.
    if (!boat || !rig) continue
    const bundle = stored.result?.marks
    // No clicks, no redo — that one needs re-marking by hand, and saying so is
    // better than appearing to fix it.
    if (!bundle?.marks || !Object.keys(bundle.marks as object).length) continue

    const resolved = resolveStoredScale(
      stored.annotation.scale as StoredScale | undefined,
      bundle, stored.result?.calibration, boat,
    )
    if (!resolved) continue
    const ref = rig.scaleRefs.find((r) => r.key === resolved.scale.key)
    if (!ref) continue

    const drift = scaleDrift(resolved.scale, { mm: ref.mm, depthMm: ref.depthMm ?? 0 })
    const base = baselineDrift(bundle, rig.baselines)
    if (!drift.stale && !base.stale) continue

    const reasons: string[] = []
    if (drift.stale) reasons.push(`scale ${resolved.scale.key}: ${driftNote(drift.ratio)}`)
    if (base.stale) reasons.push(`baseline ${base.key}: ${base.storedMm} → ${base.currentMm} mm, so ψ moves too`)

    out.push({
      photo,
      boat,
      id: String(photo.id ?? ''),
      name: String(photo.name ?? 'photo.jpg'),
      url: String((photo.fullUrl as string) || photoOriginalUrl(photo, activeDate) || ''),
      stored,
      reasons,
      before: (stored.annotation.targets || []).map((t) => ({ key: t.key, mm: t.mm })),
    })
  }
  return out
}

type Outcome = { id: string; name: string; note: string; ok: boolean }

export default function SailTrimRecompute({
  photos = [],
  activeDate = null,
  onSave,
}: {
  photos?: Record<string, unknown>[]
  activeDate?: string | null
  /** PhotosTab's own handleSaveSailTrim — the one persistence path there is. */
  onSave: (photo: Record<string, unknown>, save: SailTrimSave) => Promise<{ warning?: string } | void>
}) {
  const [rigs, setRigs] = React.useState<Map<string, RigModel>>(new Map())
  const [queue, setQueue] = React.useState<StalePhoto[] | null>(null)
  const [at, setAt] = React.useState(0)
  const [done, setDone] = React.useState<Outcome[]>([])

  // Every boat the day's frames were measured AS, each with its own model.
  const boats = React.useMemo(() => {
    const names = new Set<string>()
    for (const p of photos || []) {
      const stored = parseStored(p)
      if (stored) { const b = boatOf(p, stored); if (b) names.add(b) }
    }
    return Array.from(names).sort()
  }, [photos])

  const boatsKey = boats.join('|')
  React.useEffect(() => {
    let dead = false
    void Promise.all(boats.map(async (b) => [b, (await fetchRigModel(b, null))?.rigModel ?? null] as const))
      .then((pairs) => {
        if (dead) return
        const m = new Map<string, RigModel>()
        for (const [name, model] of pairs) if (model) m.set(name.toLowerCase(), model)
        setRigs(m)
      })
    return () => { dead = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boatsKey])

  const stale = React.useMemo(
    () => staleFrames(photos, rigs, activeDate),
    [photos, rigs, activeDate],
  )

  const current = queue && at < queue.length ? queue[at] : null

  // A frame that never settles must not stall the whole run.
  React.useEffect(() => {
    if (!current) return
    const t = setTimeout(() => {
      setDone((d) => [...d, { id: current.id, name: current.name, note: 'timed out — reopen it by hand', ok: false }])
      setAt((n) => n + 1)
    }, FRAME_TIMEOUT_MS)
    return () => clearTimeout(t)
  }, [current])

  const finish = async (save: SailTrimSave) => {
    if (!current) return
    let note = ''
    let ok = true
    try {
      const r = await onSave(current.photo, save)
      if (r && typeof r === 'object' && r.warning) { note = r.warning; ok = false }
    } catch (e) {
      note = (e as Error)?.message || 'save failed'
      ok = false
    }
    if (ok) {
      // The largest move, which is what says whether anything actually happened.
      const after = save.annotation?.targets || []
      let worst = 0, worstKey = ''
      for (const t of after) {
        const was = current.before.find((b) => b.key === t.key)
        if (!was || !was.mm) continue
        const d = Math.abs(t.mm - was.mm)
        if (d > worst) { worst = d; worstKey = t.key }
      }
      note = worstKey
        ? `largest change ${worstKey} ${Math.round(worst)} mm`
        : 'saved — nothing measurable moved'
    }
    setDone((d) => [...d, { id: current.id, name: current.name, note, ok }])
    setAt((n) => n + 1)
  }

  if (!stale.length && !queue) return null

  const running = !!current
  const finished = !!queue && at >= queue.length

  return (
    <div style={{
      background: '#0B2136', border: '1px solid #1E3A5A', borderRadius: 8,
      padding: 12, marginBottom: 10, fontSize: 12.5, color: '#E2E8F0',
    }}>
      <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: 0.6, color: '#F97316', textTransform: 'uppercase', marginBottom: 8 }}>
        Sail geometry — measured on older datums
      </div>

      {!queue && (
        <>
          <div style={{ marginBottom: 8, lineHeight: 1.45 }}>
            {stale.length} frame{stale.length === 1 ? '' : 's'} on this day {stale.length === 1 ? 'was' : 'were'} measured
            against a rig dimension that has since been corrected. Redoing replays the same clicks
            against the current datums — nothing is re-marked, and the numbers are computed by the
            geometry tool itself, not by this panel.
          </div>
          <ul style={{ margin: '0 0 10px 16px', padding: 0, color: '#94A3B8' }}>
            {stale.map((s) => (
              <li key={s.id} style={{ marginBottom: 3 }}>
                <span style={{ fontFamily: 'monospace' }}>{s.name}</span>
                {' '}<span style={{ color: '#64748B' }}>({s.boat})</span> — {s.reasons.join('; ')}
              </li>
            ))}
          </ul>
          <button
            onClick={() => { setDone([]); setAt(0); setQueue(stale) }}
            style={{
              background: '#0A1929', border: '1px solid #F9731660', borderRadius: 7,
              padding: '7px 13px', color: '#F97316', fontWeight: 600, cursor: 'pointer',
            }}>
            Redo {stale.length} frame{stale.length === 1 ? '' : 's'}
          </button>
        </>
      )}

      {running && (
        <div style={{ marginBottom: 6 }}>
          Redoing {at + 1} of {queue!.length} — <span style={{ fontFamily: 'monospace' }}>{current!.name}</span>…
        </div>
      )}

      {!!done.length && (
        <ul style={{ margin: '6px 0 0 16px', padding: 0 }}>
          {done.map((d, i) => (
            <li key={`${d.id}-${i}`} style={{ marginBottom: 3, color: d.ok ? '#4ADE80' : '#FB923C' }}>
              <span style={{ fontFamily: 'monospace' }}>{d.name}</span> — {d.note}
            </li>
          ))}
        </ul>
      )}

      {finished && (
        <div style={{ marginTop: 8, color: '#94A3B8' }}>
          Done. Twist and camber are not linear in the scale, so they move by their own amounts —
          worth a look at one frame's card before trusting the rest.
        </div>
      )}

      {/* Laid out, but off the side of the page: the tab draws onto canvases that
          size themselves from their bounding box, and a display:none host gives
          them a zero-sized one. Nothing here is for looking at. */}
      {current && (
        <div aria-hidden style={{ position: 'fixed', left: -20000, top: 0, width: 1200, height: 900, overflow: 'hidden', pointerEvents: 'none' }}>
          <SailTrimTab
            key={current.id}
            boatName={current.boat}
            boatId={null}
            initialFileUrl={current.url}
            initialFileName={current.name}
            photoLabel={current.name}
            initialResult={current.stored.result as never}
            autoSaveWhenReady
            onSaveToPhoto={((save: SailTrimSave) => finish(save)) as never} />
        </div>
      )}
    </div>
  )
}
