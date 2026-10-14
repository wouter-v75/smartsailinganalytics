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
  resolveStoredScale, scaleDrift, baselineDrift, driftNote, depthDrift,
  type MarksBundle, type ResultCalibration, type StoredScale,
} from '../../lib/sailTrimAudit'
import type { SailTrimSave } from '../sailtrim/SailTrimTab'
import { SAILTRIM_VERSION } from '../../lib/sailTrim'

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

/** A frame the panel cannot judge, and the reason — never silently dropped. */
export interface UnassessedPhoto { id: string; name: string; reason: string }

/**
 * Which of a day's frames need redoing, and which CANNOT BE JUDGED.
 *
 * The second list exists because the first was a lie by omission. This walked
 * four `continue`s — no boat, no rig model, no marks, no resolvable scale — and
 * a frame tripping any of them vanished. Northstar's three 27 Sep frames are
 * exactly that case: they predate the annotation.scale block, so
 * resolveStoredScale finds nothing to fall back on, and they were dropped
 * without a word. The panel showed nothing, Wouter redid them, and the stored
 * data came back byte-identical because there had never been anything to click.
 *
 * It is the same mistake the audit script made earlier in its life, where
 * "cannot tell" was counted as "ok" — and the fix is the same. A frame the tool
 * cannot assess is a finding, not an absence.
 */
export function assessFrames(
  photos: Record<string, unknown>[],
  rigs: Map<string, RigModel>,
  activeDate: string | null,
): { stale: StalePhoto[]; unassessed: UnassessedPhoto[] } {
  const out: StalePhoto[] = []
  const unassessed: UnassessedPhoto[] = []
  const cannot = (photo: Record<string, unknown>, reason: string) => {
    unassessed.push({ id: String(photo.id ?? ''), name: String(photo.name ?? 'photo.jpg'), reason })
  }
  for (const photo of photos || []) {
    const stored = parseStored(photo)
    if (!stored?.annotation) continue   // not a measured frame at all
    const boat = boatOf(photo, stored)
    const rig = rigs.get(boat.toLowerCase())
    // No boat, or no model for it, is "cannot tell" — and a redo that guessed
    // the boat would be worse than leaving it alone.
    if (!boat) { cannot(photo, 'no boat recorded on the frame, so there is no rig model to check it against'); continue }
    if (!rig) { cannot(photo, `measured as "${boat}", which has no rig model loaded`); continue }
    const bundle = stored.result?.marks
    // No clicks, no redo — that one needs re-marking by hand.
    if (!bundle?.marks || !Object.keys(bundle.marks as object).length) {
      cannot(photo, 'the clicks were not saved with it — it has to be marked again by hand'); continue
    }

    const resolved = resolveStoredScale(
      stored.annotation.scale as StoredScale | undefined,
      bundle, stored.result?.calibration, boat,
    )
    if (!resolved) {
      cannot(photo, 'no scale block and no rig snapshot — nothing records what it was measured against'); continue
    }
    const ref = rig.scaleRefs.find((r) => r.key === resolved.scale.key)
    if (!ref) { cannot(photo, `measured against "${resolved.scale.key}", which this boat no longer has`); continue }

    const drift = scaleDrift(resolved.scale, { mm: ref.mm, depthMm: ref.depthMm ?? 0 })
    const base = baselineDrift(bundle, rig.baselines)
    // A DATUM can move, and so can the MATHS. Only the first was being looked
    // for, so when solvePsi was corrected the panel went on reporting that every
    // frame was current — and the redo was eleven manual visits to a button that
    // is hidden on a frame which already has geometry.
    const storedVersion = String(stored.annotation.version || '')
    const oldMaths = !!storedVersion && storedVersion !== SAILTRIM_VERSION
    // A per-target DEPTH can move too, and `sailtrim-triangulate --write` moves
    // several at once by design. Depth multiplies ψ, so a station that shifts a
    // metre shifts every measurement at it by 17 mm per degree.
    const dep = depthDrift(stored.annotation.targets, rig)
    if (!drift.stale && !base.stale && !oldMaths && !dep.stale) continue

    const reasons: string[] = []
    if (drift.stale) reasons.push(`scale ${resolved.scale.key}: ${driftNote(drift.ratio)}`)
    if (base.stale) reasons.push(`baseline ${base.key}: ${base.storedMm} → ${base.currentMm} mm, so ψ moves too`)
    if (oldMaths) reasons.push(`measured by ${storedVersion}; the geometry is now ${SAILTRIM_VERSION}`)
    if (dep.stale) reasons.push(`${dep.key} depth: ${Math.round(dep.storedMm!)} → ${Math.round(dep.currentMm!)} mm`)

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
  return { stale: out, unassessed }
}

/** The frames needing a redo. See assessFrames for the ones it cannot judge. */
export function staleFrames(
  photos: Record<string, unknown>[],
  rigs: Map<string, RigModel>,
  activeDate: string | null,
): StalePhoto[] {
  return assessFrames(photos, rigs, activeDate).stale
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

  const assessed = React.useMemo(
    () => assessFrames(photos, rigs, activeDate),
    [photos, rigs, activeDate],
  )
  const stale = assessed.stale
  const unassessed = assessed.unassessed

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

  if (!stale.length && !unassessed.length && !queue) return null

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

      {!queue && unassessed.length > 0 && (
        <div style={{ marginBottom: 10, padding: '8px 10px', background: '#2A1F05',
          border: '1px solid #FCD34D40', borderRadius: 8, color: '#FCD34D', lineHeight: 1.45 }}>
          <b>{unassessed.length} frame{unassessed.length === 1 ? '' : 's'} cannot be judged</b>
          {' '}— and so cannot be offered for a redo. This is not the same as being up to date.
          <ul style={{ margin: '6px 0 0 16px', padding: 0 }}>
            {unassessed.map((u) => (
              <li key={u.id} style={{ marginBottom: 3 }}>
                <span style={{ fontFamily: 'monospace' }}>{u.name}</span> — {u.reason}
              </li>
            ))}
          </ul>
          <div style={{ marginTop: 6, color: '#CBD5E1', fontSize: 10 }}>
            Open each one, press <b>Edit points…</b> and save: the clicks come back, and the save
            writes the scale, range, tack and depths that were never recorded.
          </div>
        </div>
      )}

      {!queue && stale.length > 0 && (
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
          {/* `recordedExif` is load-bearing on THIS path above all others. These
              frames are being reopened precisely because something about their
              maths was wrong, and the file fetched for them is a cloud re-export
              with no EXIF in it — so without the row's recorded lens the redo
              comes up with an empty focal box, skips the depth correction
              exactly as the original measurement did, and saves a "corrected"
              frame that is corrected for nothing. */}
          <SailTrimTab
            key={current.id}
            boatName={current.boat}
            boatId={null}
            initialFileUrl={current.url}
            initialFileName={current.name}
            photoLabel={current.name}
            initialResult={current.stored.result as never}
            recordedExif={(current.photo.exif as { camera?: string | null; lensModel?: string | null;
                                                   focalMm?: number | null; focal35Mm?: number | null } | null) || null}
            autoSaveWhenReady
            onSaveToPhoto={((save: SailTrimSave) => finish(save)) as never} />
        </div>
      )}
    </div>
  )
}
