'use client';
// src/lib/yacht-prefs.ts
// ─────────────────────────────────────────────────────────────────────────────
// Per-yacht preferences for SailScan v2 (and beyond).
//
// Keyed by the yacht / boat name read from `xmlData.meta.boat`. When no boat
// is loaded we fall back to the literal key `'default'` so the prefs exist
// somewhere even before a session is opened.
//
// LocalStorage shape (JSON):
//   {
//     "BoatName1": { stripeColour: "black", ... },
//     "BoatName2": { stripeColour: "red",   ... },
//     "default":   { stripeColour: "black"        }
//   }
// ─────────────────────────────────────────────────────────────────────────────

const KEY = 'ssa:sailscan:yacht-prefs';

export type StripeColour = 'black' | 'white' | 'red' | 'blue' | 'green' | 'yellow' | 'orange' | 'purple';

// HSV in OpenCV's encoding: hue 0..180 (degrees / 2), sat / val 0..255.
export interface StripeHsv { h: number; s: number; v: number; }

export interface YachtPrefs {
  /** Categorical user-facing label (for the colour picker). */
  stripeColour?: StripeColour;
  /** Numeric colour signature auto-learned from the user's first tap on a
   *  stripe. Reused as the HSV centre on subsequent auto-detects for this
   *  yacht. Cheaper and more accurate than the categorical hint. */
  stripeHsv?: StripeHsv;
}

type AllPrefs = Record<string, YachtPrefs>;

function readAll(): AllPrefs {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '{}') || {};
  } catch {
    return {};
  }
}

function writeAll(prefs: AllPrefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // Storage full / private mode — silently ignore. v2 falls back to defaults.
  }
}

const yachtKey = (boat?: string | null) => (boat && boat.trim()) || 'default';

export function getYachtPrefs(boat?: string | null): YachtPrefs {
  return readAll()[yachtKey(boat)] || {};
}

export function setYachtPref<K extends keyof YachtPrefs>(
  boat: string | null | undefined,
  key: K,
  value: YachtPrefs[K],
): void {
  const all = readAll();
  const k = yachtKey(boat);
  all[k] = { ...all[k], [key]: value };
  writeAll(all);
}
