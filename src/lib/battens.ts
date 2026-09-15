// src/lib/battens.ts
// ─────────────────────────────────────────────────────────────────────────────
// The batten card.
//
// A mainsail's battens are tensioned to a number of turns against a stiffness,
// and the right answer changes with the breeze: soft and eased in the light so
// the sail can take up shape, stiffer and wound on as it builds so the leech
// stops falling away. Every team keeps this on a laminated card in the boat, and
// it is exactly the sort of thing that never reaches the data — the log records
// what the boat did, never that somebody wound two turns onto the top batten at
// 11:40. Untagged, an afternoon of batten work reads as unexplained scatter.
//
// Two halves, and keeping them apart is the point:
//
//   the CARD     what the battens SHOULD be, per batten, per wind band. Boat
//                config: written once, changed rarely, the same for everyone.
//   the RECORD   what they actually were at a moment. A sail-change tag.
//
// A card belongs to a MAINSAIL, not to a boat. A new main and a three-season
// delivery main do not want the same turns, and the day that matters is a
// two-boat testing week — exactly the day nobody has time to notice the card is
// describing the other sail. See migration 0065.
//
// Battens are numbered FROM THE TOP, because that is how a crew counts them
// standing on deck looking up, and because the top batten is the one that gets
// touched.
//
// Pure — no React, no I/O.
// ─────────────────────────────────────────────────────────────────────────────

export type Tension = 'soft' | 'medium' | 'stiff'

export const TENSIONS: Tension[] = ['soft', 'medium', 'stiff']

/**
 * Short labels for the three buttons.
 *
 * NOT first letters: "soft" and "stiff" both start with S, so a first-letter
 * abbreviation renders the card as S / M / S and makes the two ends of the range
 * indistinguishable. This is reference data a trimmer reads in a hurry with the
 * boat moving; it has to be unambiguous at a glance.
 */
export const TENSION_SHORT: Record<Tension, string> = {
  soft: 'Soft',
  medium: 'Med',
  stiff: 'Stiff',
}

export interface WindBand {
  /** Stable key — stored, so it must not change when a label is reworded. */
  key: string
  label: string
  /** Inclusive. */
  minKn: number
  /** Exclusive; null means "and up". */
  maxKn: number | null
}

export const WIND_BANDS: WindBand[] = [
  { key: '0-5', label: '0–5', minKn: 0, maxKn: 5 },
  { key: '5-10', label: '5–10', minKn: 5, maxKn: 10 },
  { key: '10-15', label: '10–15', minKn: 10, maxKn: 15 },
  { key: '15-20', label: '15–20', minKn: 15, maxKn: 20 },
  { key: '20-25', label: '20–25', minKn: 20, maxKn: 25 },
  { key: '25+', label: '25+', minKn: 25, maxKn: null },
]

export interface BattenSetting {
  tension: Tension | null
  /** Turns on from the reference mark. Negative is off — it is a real setting,
   *  not a data-entry slip, so nothing here clamps it at zero. */
  turns: number
}

/** The card: one row per batten, one cell per wind band. */
export interface BattenCard {
  /** How many battens the main has. Numbered 1..count from the TOP. */
  count: number
  /** `rows[battenIndex][bandKey]`. Sparse — a blank cell is simply absent. */
  rows: Record<string, BattenSetting>[]
}

export const DEFAULT_BATTEN_COUNT = 3
export const MAX_BATTEN_COUNT = 12

const isTension = (v: unknown): v is Tension => TENSIONS.includes(v as Tension)
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** A blank card for a main with `count` battens. */
export function defaultBattenCard(count = DEFAULT_BATTEN_COUNT): BattenCard {
  const n = Math.max(1, Math.min(MAX_BATTEN_COUNT, Math.round(count) || DEFAULT_BATTEN_COUNT))
  return { count: n, rows: Array.from({ length: n }, () => ({})) }
}

/**
 * Coerce whatever came back from the database into a card.
 *
 * Deliberately forgiving: this is hand-entered data that has been through a
 * JSONB column, and a card that refuses to render because one cell has a string
 * where a number should be is worse than a card with one blank cell.
 */
export function normaliseBattenCard(raw: unknown): BattenCard {
  const o = (raw || {}) as Partial<BattenCard>
  const rawRows = Array.isArray(o.rows) ? o.rows : []
  // The row count is the truth when they disagree — a card with four rows of
  // settings and a stale count of 3 must not silently drop the fourth batten.
  const count = Math.max(
    1,
    Math.min(MAX_BATTEN_COUNT, Math.max(isNum(o.count) ? Math.round(o.count) : 0, rawRows.length) || DEFAULT_BATTEN_COUNT)
  )

  const rows: Record<string, BattenSetting>[] = []
  for (let i = 0; i < count; i++) {
    const src = (rawRows[i] || {}) as Record<string, unknown>
    const row: Record<string, BattenSetting> = {}
    for (const band of WIND_BANDS) {
      const cell = src[band.key] as Partial<BattenSetting> | undefined
      if (!cell || typeof cell !== 'object') continue
      const tension = isTension(cell.tension) ? cell.tension : null
      const turns = isNum(cell.turns) ? cell.turns : 0
      // A cell with neither a stiffness nor a number is a blank cell.
      if (tension == null && turns === 0) continue
      row[band.key] = { tension, turns }
    }
    rows.push(row)
  }
  return { count, rows }
}

/** Grow or shrink a card, keeping the settings that survive. */
export function setBattenCount(card: BattenCard, count: number): BattenCard {
  const n = Math.max(1, Math.min(MAX_BATTEN_COUNT, Math.round(count) || 1))
  const rows = Array.from({ length: n }, (_, i) => card.rows[i] || {})
  return { count: n, rows }
}

/** Which band a true wind speed falls in. null when there is no wind reading. */
export function bandForTws(tws: number | null | undefined): WindBand | null {
  if (!isNum(tws) || tws < 0) return null
  return (
    WIND_BANDS.find((b) => tws >= b.minKn && (b.maxKn == null || tws < b.maxKn)) ||
    WIND_BANDS[WIND_BANDS.length - 1]
  )
}

/** What the card says for one batten in this breeze. null when the cell is blank. */
export function cardSetting(
  card: BattenCard,
  battenNo: number,
  tws: number | null | undefined
): BattenSetting | null {
  const band = bandForTws(tws)
  if (!band) return null
  return card.rows[battenNo - 1]?.[band.key] || null
}

/** "soft +5" · "stiff −2" · "medium" · "+3" — how a crew says it. */
export function formatSetting(s: BattenSetting | null | undefined): string {
  if (!s) return '—'
  const turns = isNum(s.turns) ? s.turns : 0
  // U+2212 MINUS, not a hyphen: this sits beside "+3" and they should be the
  // same width and weight.
  const t = turns === 0 ? '' : turns > 0 ? `+${turns}` : `−${Math.abs(turns)}`
  if (!s.tension) return t || '—'
  return t ? `${s.tension} ${t}` : s.tension
}

/** One mainsail's card, as the API returns it. */
export interface SailBattenCard {
  /** null = entered before cards were per-sail, not yet assigned (0065). */
  sailId: string | null
  card: BattenCard
  updatedAt: string | null
}

/** The card for one mainsail, or null when it has none of its own. */
export function cardForSail(
  cards: readonly SailBattenCard[] | null | undefined,
  sailId: string | null | undefined
): BattenCard | null {
  if (!sailId) return null
  return (cards || []).find((c) => c.sailId === sailId)?.card ?? null
}

/**
 * The card left over from before cards were per-sail.
 *
 * Offered to a main that has none of its own so hand-entered work is not thrown
 * away by the schema change — but never silently adopted, because nobody has
 * said which main it describes.
 */
export const unassignedCard = (
  cards: readonly SailBattenCard[] | null | undefined
): BattenCard | null => (cards || []).find((c) => c.sailId == null)?.card ?? null

/** True when a cell holds nothing worth storing. */
export const isBlankSetting = (s: BattenSetting | null | undefined): boolean =>
  !s || (s.tension == null && (!isNum(s.turns) || s.turns === 0))

/** Does this card say anything at all? An empty one should prompt, not display. */
export const cardIsEmpty = (card: BattenCard): boolean =>
  card.rows.every((r) => Object.values(r).every(isBlankSetting))
