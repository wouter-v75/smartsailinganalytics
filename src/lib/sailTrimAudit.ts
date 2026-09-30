// src/lib/sailTrimAudit.ts
// ─────────────────────────────────────────────────────────────────────────────
// Which stored sail-geometry frames were measured against a datum that has since
// MOVED, and roughly how far their millimetres are out because of it.
//
// It exists because a rig model improves — Northstar 76's wheel depth went from
// a −10 000 mm guess to the designer's −7392, which is 26 % — and nothing on a
// stored frame says it was measured before that. The numbers simply sit there,
// quietly 3 % large, and the frame-to-frame spread cannot show it: a uniform
// scale error is invisible in a residual. So it has to be asked for explicitly.
//
// WHAT THIS DELIBERATELY DOES NOT DO: recompute the answers. Chord angles are
// asin(offset ÷ width) and camber is a fit, so neither is a rescale, and the one
// time this codebase grew a second implementation of the depth correction the
// two agreed until they didn't — four stations collapsed onto a flat −5700 with
// residuals of 5–41 mm and nothing saying so. The app's own pipeline is the
// single implementation, and reopening a frame and saving it runs exactly that.
// This only says WHICH frames to reopen, and what size of change to expect, so
// an unchanged number after a redo is recognisable as the bug it would be.
// ─────────────────────────────────────────────────────────────────────────────

/** The `scale` block an annotation carries, as it was when the frame was saved. */
export interface StoredScale {
  key: string
  mm: number
  depthMm: number
  mmPerPxAtMast: number
  /** Camera→MAST range, mm. Null when there was no focal length, in which case
   *  no depth correction was applied at all. */
  rangeMm: number | null
  boat?: string
}

/** The same reference as the boat's rig model has it TODAY. */
export interface CurrentRef {
  mm: number
  depthMm: number
}

export interface ScaleDrift {
  stale: boolean
  /** Plain-language reasons, for printing next to the frame. */
  reasons: string[]
  /**
   * First-order factor between the stored millimetres and what the same clicks
   * would give now — 0.969 meaning "stored numbers are 3.1 % large".
   *
   * FIRST-ORDER, and the word is load-bearing: it is the change in the scale at
   * the mast plane. Each target is then corrected again for its OWN depth
   * against a range that has also moved, and twist and camber are not linear in
   * any of it. Treat it as the size to expect, never as the answer.
   */
  ratio: number | null
}

/** Range to the REFERENCE, recovered from what the annotation stored.
 *  `rangeMm` is the range to the MAST, and the reference sits `depthMm` forward
 *  of it (negative = abaft), so the reference's own range is the sum. */
export function rangeToRefMm(stored: StoredScale): number | null {
  if (stored.rangeMm == null) return null
  const r = stored.rangeMm + stored.depthMm
  return r > 0 ? r : null
}

export function scaleDrift(stored: StoredScale, current: CurrentRef | null): ScaleDrift {
  if (!current) {
    return { stale: false, reasons: [`no "${stored.key}" in the rig model today — cannot tell`], ratio: null }
  }
  const reasons: string[] = []

  // The reference's TRUE LENGTH. Scale is proportional to it, so this one is
  // exact rather than first-order.
  const lengthRatio = stored.mm > 0 ? current.mm / stored.mm : 1
  if (Math.abs(current.mm - stored.mm) > 0.5) {
    reasons.push(`length ${stored.mm} → ${current.mm} mm`)
  }

  // The reference's DEPTH. It only ever reached the numbers through the depth
  // correction, so with no range there was no correction and a changed depth
  // changes nothing about what is stored — though it will change the redo.
  let depthRatio = 1
  if (Math.abs(current.depthMm - stored.depthMm) > 0.5) {
    const toRef = rangeToRefMm(stored)
    if (toRef == null) {
      reasons.push(`depth ${stored.depthMm} → ${current.depthMm} mm, but this frame had no focal length, so no depth correction was applied either way`)
    } else {
      const rangeToMastNow = toRef - current.depthMm
      if (rangeToMastNow > 0 && stored.rangeMm! > 0) {
        depthRatio = rangeToMastNow / stored.rangeMm!
        reasons.push(`depth ${stored.depthMm} → ${current.depthMm} mm`)
      } else {
        reasons.push(`depth ${stored.depthMm} → ${current.depthMm} mm (range does not resolve)`)
      }
    }
  }

  const ratio = lengthRatio * depthRatio
  return { stale: reasons.length > 0, reasons, ratio: reasons.length ? ratio : 1 }
}

// ── recovering the scale on a frame saved before provenance was stored ───────
//
// `annotation.scale` is recent. Older frames have none — but SailTrim has always
// bundled the whole rig model into `result.marks` so a measurement can be
// reopened, and that snapshot IS the provenance: the reference it used, its
// length and depth AT THE TIME, and the baseline ψ was solved across. So a frame
// with no scale block is not unknowable, only awkward, and the range and scale
// come off `result.calibration`.

export interface MarksBundle {
  scaleKey?: string
  baselineKey?: string
  rig?: { scaleRefs?: { key: string; mm: number; depthMm?: number }[]; baselines?: { key: string; mm: number }[] }
}

export interface ResultCalibration { mmPerPxAtMast?: number; rangeMm?: number | null }

/** The scale a frame used, from its own scale block or, failing that, from the
 *  rig snapshot it was measured with. Null when neither says. */
export function resolveStoredScale(
  scale: StoredScale | null | undefined,
  marks: MarksBundle | null | undefined,
  cal: ResultCalibration | null | undefined,
  boat?: string,
): { scale: StoredScale; from: 'scale-block' | 'rig-snapshot' } | null {
  if (scale) return { scale, from: 'scale-block' }
  const key = marks?.scaleKey
  const ref = key ? marks?.rig?.scaleRefs?.find((r) => r.key === key) : null
  if (!key || !ref) return null
  return {
    from: 'rig-snapshot',
    scale: {
      key,
      mm: ref.mm,
      depthMm: ref.depthMm ?? 0,
      mmPerPxAtMast: cal?.mmPerPxAtMast ?? 0,
      rangeMm: cal?.rangeMm ?? null,
      boat,
    },
  }
}

export interface BaselineDrift {
  stale: boolean
  key: string | null
  storedMm: number | null
  currentMm: number | null
  /** How much longer the baseline is now, as a fraction. ψ is solved ACROSS it,
   *  so a baseline that was wrong by this much put ψ out — and ψ is worth 17 mm
   *  per metre a target sits abaft the mast, so it moves the aft targets most.
   *  The new ψ needs the pixel geometry, which only the app has. */
  fraction: number | null
}

export function baselineDrift(
  marks: MarksBundle | null | undefined,
  current: { key: string; mm: number }[] | null | undefined,
): BaselineDrift {
  const key = marks?.baselineKey ?? null
  const stored = key ? marks?.rig?.baselines?.find((b) => b.key === key) ?? null : null
  const now = key ? current?.find((b) => b.key === key) ?? null : null
  if (!key || !stored || !now || !(stored.mm > 0)) {
    return { stale: false, key, storedMm: stored?.mm ?? null, currentMm: now?.mm ?? null, fraction: null }
  }
  const fraction = (now.mm - stored.mm) / stored.mm
  return { stale: Math.abs(now.mm - stored.mm) > 0.5, key, storedMm: stored.mm, currentMm: now.mm, fraction }
}

/** "3.1 % large" / "0.4 % small" — the way round an operator wants to read it. */
export function driftNote(ratio: number | null): string {
  if (ratio == null || !Number.isFinite(ratio)) return 'unknown'
  const pct = (ratio - 1) * 100
  if (Math.abs(pct) < 0.05) return 'no material change'
  return `stored numbers are ${Math.abs(pct).toFixed(1)} % ${pct < 0 ? 'large' : 'small'}`
}
