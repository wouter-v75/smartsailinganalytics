// src/lib/racingTags.ts
// ─────────────────────────────────────────────────────────────────────────────
// The ONE place that decides which auto-tags are worth showing on a media card.
//
// computeAutoTags emits everything it can infer: boat, venue, day type, sail
// names, wind band, point of sail, manoeuvres. Most of that is noise on a
// thumbnail — you want to scan a column of clips and spot the racing moments.
//
// So this is a WHITELIST, not a blacklist: a tag has to be a known racing
// manoeuvre to appear. Anything new the tagger learns to emit is excluded by
// default and can never leak onto the cards.
//
// `isMainsailTag` exists as a belt-and-braces guard for the places that still
// render sail names (they're useful on photos/scans): the mainsail is up in
// essentially every frame, so tagging it carries no information — it just eats
// the row. Event files spell it every which way (Main_2026, MAIN, mainsail,
// MN-1, mn2, m-sail), hence matching the family rather than a literal.
// ─────────────────────────────────────────────────────────────────────────────

export const RACE_RED = '#EF4444'

export const RACING_TAGS: Record<string, string> = {
  'race-start': 'Race start',
  'spin-hoist': 'Spin hoist',
  'spin-drop': 'Spin drop',
  topmark: 'Top mark',
  gate: 'Gate',
}

// Strip leading punctuation, then match the mainsail family: mn*, main*, msail,
// m-sail, mainsail — in any case, with any separator/suffix (Main_2026, MN-1).
const MAINSAIL_RE = /^(mn|main|m[-_ ]?sail|mainsail)/i
export const isMainsailTag = (t: unknown): boolean =>
  MAINSAIL_RE.test(String(t ?? '').trim().replace(/^[^a-z0-9]+/i, ''))

// Racing tags present in `tags`, as display labels, de-duplicated and ordered by
// the RACING_TAGS declaration order. "2x-gybe"-style repeat tags share the base.
export function racingTagsOf(tags: readonly string[] | null | undefined): string[] {
  const found = new Set<string>()
  for (const t of tags || []) {
    const base = String(t).replace(/^\d+x-/, '').trim().toLowerCase()
    if (RACING_TAGS[base]) found.add(base)
  }
  return Object.keys(RACING_TAGS).filter((k) => found.has(k)).map((k) => RACING_TAGS[k])
}
