// src/lib/lensPrefs.ts
// ─────────────────────────────────────────────────────────────────────────────
// The lenses this browser has actually seen, so a photo with its EXIF stripped
// can be given a focal length by picking rather than by remembering.
//
// It builds itself. Every frame that DOES carry a focal length contributes one
// entry, labelled with the camera and lens out of the same EXIF — so by the time
// a stripped export turns up, the list already holds the kit it was shot on.
// Nothing has to be configured, and a list nobody maintains is the only kind
// that stays true.
//
// IT LIVES IN `ssa-prefs`, NOT `ssa-db`. CLAUDE.md is explicit and it cost an
// evening: bumping ssa-db's version for anything that is not a day's data
// blocks every versionless opener that never listens for `versionchange`, and
// openDb() then hangs for ever with no error. A remembered lens is a UI
// preference, so it gets the other database.
// ─────────────────────────────────────────────────────────────────────────────

import { getPref, setPref } from './prefsStore'

export const LENS_PREF = 'sailtrimLenses'

/** How many to keep. Long enough for a season's kit, short enough to pick from. */
export const MAX_LENSES = 12

export interface Lens {
  /** "iPhone 15 Pro · 6.9 mm", or whatever the camera called itself. */
  label: string
  focalMm: number
  /** Epoch ms, for ordering: the lens used last is the one most likely next. */
  lastUsed: number
}

/** A label from whatever EXIF offered, falling back to the bare length. */
export function lensLabel(
  model?: string | null,
  lensModel?: string | null,
  focalMm?: number | null,
): string {
  const bits = [model?.trim(), lensModel?.trim()].filter(Boolean) as string[]
  // A lens whose name already contains the camera's reads as a stutter:
  // "iPhone 15 Pro · iPhone 15 Pro back camera". Keep the longer one.
  const name = bits.length === 2 && bits[1].toLowerCase().includes(bits[0].toLowerCase())
    ? bits[1]
    : bits.join(' · ')
  const mm = focalMm != null && Number.isFinite(focalMm) ? `${Math.round(focalMm)} mm` : ''
  return [name, mm].filter(Boolean).join(' · ') || 'unnamed lens'
}

/**
 * Fold one sighting into the list: newest first, no duplicates, capped.
 *
 * Identity is the LABEL AND the focal length together. One body carries several
 * lenses and one lens goes on several bodies, and a zoom is a different entry at
 * every length it is used at — which is the point, since what is being picked is
 * a focal length, not a piece of glass.
 */
export function rememberIn(list: Lens[], lens: Lens): Lens[] {
  if (!Number.isFinite(lens.focalMm) || lens.focalMm <= 0) return list
  const key = (l: Lens) => `${l.label.trim().toLowerCase()}|${Math.round(l.focalMm)}`
  const k = key(lens)
  return [lens, ...list.filter((l) => key(l) !== k)]
    .sort((a, b) => b.lastUsed - a.lastUsed)
    .slice(0, MAX_LENSES)
}

/** Tolerant of anything the store hands back: this is a convenience, never a
 *  reason for the tool to fail to open. */
export function coerceLenses(raw: unknown): Lens[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((x) => x as Partial<Lens>)
    .filter((x) => typeof x?.label === 'string' && typeof x?.focalMm === 'number' && x.focalMm > 0)
    .map((x) => ({ label: x.label!, focalMm: x.focalMm!, lastUsed: Number(x.lastUsed) || 0 }))
    .sort((a, b) => b.lastUsed - a.lastUsed)
    .slice(0, MAX_LENSES)
}

/** Drop one, by the same identity `rememberIn` uses. A lens typed in error
 *  would otherwise sit in the list for ever, and a wrong focal length that is
 *  easy to pick is worse than none. */
export function forgetIn(list: Lens[], label: string, focalMm: number): Lens[] {
  const k = `${label.trim().toLowerCase()}|${Math.round(focalMm)}`
  return list.filter((l) => `${l.label.trim().toLowerCase()}|${Math.round(l.focalMm)}` !== k)
}

export async function loadLenses(): Promise<Lens[]> {
  try { return coerceLenses(await getPref(LENS_PREF)) } catch { return [] }
}

/** Records a lens and hands back the new list. Failure is silent on purpose —
 *  not remembering a lens must never stop a measurement being taken. */
export async function rememberLens(lens: Lens): Promise<Lens[]> {
  try {
    const next = rememberIn(await loadLenses(), lens)
    await setPref(LENS_PREF, next)
    return next
  } catch {
    return []
  }
}

export async function forgetLens(label: string, focalMm: number): Promise<Lens[]> {
  try {
    const next = forgetIn(await loadLenses(), label, focalMm)
    await setPref(LENS_PREF, next)
    return next
  } catch {
    return []
  }
}

/**
 * Does this lens name describe a ZOOM?
 *
 * A remembered zoom length is a SETTING that was used once, not a property of
 * the glass — so offering "RF100-500mm · 254 mm" to a stripped frame is offering
 * one of five hundred possibilities. A prime's remembered length is the lens
 * itself and can be picked without further thought.
 */
export function isZoomLabel(label: string): boolean {
  // "100-500mm", "24-70 mm", "70‑200mm" (non-breaking hyphen) — but not a name
  // like "RF35mm F1.8" and not the "· 254 mm" this module appends itself.
  return /\d{1,4}\s*[-\u2010-\u2015]\s*\d{1,4}\s*mm/i.test(label)
}
