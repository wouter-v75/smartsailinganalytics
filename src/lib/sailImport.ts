// src/lib/sailImport.ts
// ─────────────────────────────────────────────────────────────────────────────
// Matching an event file's <saillist> against the inventory it belongs to.
//
// The decisions, separated from the route that executes them, because getting
// them wrong is expensive in both directions: match too loosely and a file
// silently rewrites the wrong sail's weight, match too strictly and every
// upload mints duplicates and retires the sails it just confirmed.
//
// Two things a file's spelling of a sail is not obliged to get right:
//
//   CASE AND SPACE   "J2 " and "J2" are one sail. Matching the raw string made
//                    the second upload of a file with a stray space create a
//                    sail nobody asked for.
//   PUNCTUATION      "J4_A 2026" is J4_A_2026 with a space where an underscore
//                    should be — but only a person can say that, so the tagger
//                    asks and stores the answer as an ALIAS on the sail. This
//                    is where that answer is honoured, so the next upload of
//                    the same file does not undo it.
//
// Reconciliation works on IDS, never on names: a sail matched through an alias
// is spelled differently in the two places, and comparing the spellings would
// retire the sail the file had just confirmed.
//
// Pure — no I/O.
// ─────────────────────────────────────────────────────────────────────────────

/** Trimmed and lower-cased. The one comparison. */
export const importKey = (n: unknown): string => String(n ?? '').trim().toLowerCase()

export interface ExistingSail {
  id: string
  name: string
  retired?: boolean | null
  specs?: { source?: unknown; aliases?: unknown } | null
}

/** Every name the inventory answers to → the sail it means. */
export function inventoryIndex(existing: readonly ExistingSail[]): Map<string, ExistingSail> {
  const out = new Map<string, ExistingSail>()
  for (const s of existing || []) {
    const k = importKey(s?.name)
    if (k && !out.has(k)) out.set(k, s)
  }
  // Aliases second, so a sail's own name always beats another sail's alias for
  // it — otherwise a stale link quietly captures a sail that has since been
  // added properly.
  for (const s of existing || []) {
    const aliases = Array.isArray(s?.specs?.aliases) ? (s.specs!.aliases as unknown[]) : []
    for (const a of aliases) {
      const k = importKey(a)
      if (k && !out.has(k)) out.set(k, s)
    }
  }
  return out
}

export interface ImportPlan<T> {
  /** Existing sails the file accounted for, with the row that matched them. */
  update: { sail: ExistingSail; incoming: T }[]
  /** Names the inventory has never heard of, de-duplicated. */
  insert: { name: string; incoming: T }[]
  /** Event-file sails the list no longer mentions. Never manual ones: an
   *  inventory file must not retire what somebody typed in by hand. */
  retire: ExistingSail[]
}

export function planSailImport<T extends { name?: unknown }>(
  existing: readonly ExistingSail[],
  incoming: readonly T[],
  opts: { reconcile?: boolean } = {}
): ImportPlan<T> {
  const index = inventoryIndex(existing)
  const update: ImportPlan<T>['update'] = []
  const insert: ImportPlan<T>['insert'] = []
  const seen = new Set<string>()
  const pending = new Set<string>()

  for (const row of incoming || []) {
    const name = String(row?.name ?? '').trim()
    if (!name) continue
    const found = index.get(importKey(name))
    if (found) {
      // A file that names the same sail twice — once by name, once by an alias
      // — is one update, not two.
      if (seen.has(found.id)) continue
      seen.add(found.id)
      update.push({ sail: found, incoming: row })
    } else if (!pending.has(importKey(name))) {
      // And a file that lists "J2" and "j2 " means one sail, not two.
      pending.add(importKey(name))
      insert.push({ name, incoming: row })
    }
  }

  const retire = opts.reconcile === false
    ? []
    : (existing || []).filter(
        (s) => !seen.has(s.id) && !s.retired && s?.specs?.source === 'event-file'
      )

  return { update, insert, retire }
}
