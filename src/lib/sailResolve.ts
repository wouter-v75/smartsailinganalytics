// sailResolve.ts — reconcile event-file sail names against the SSA sail inventory.
//
// Expedition event files carry their own sail names (in <saillist> and the
// SailsUp timeline). Those don't always match the boat's SSA inventory. When a
// user links an event-file name to an inventory sail, we store the event name as
// an ALIAS on that sail (sail.specs.aliases). This module builds a resolver from
// the inventory that maps any raw event-file sail string to its canonical
// inventory NAME — so the app displays one consistent name everywhere.

export interface InvSail {
  id: string
  name: string
  category?: string | null
  design_code?: string | null
  retired?: boolean
  specs?: { aliases?: string[] } & Record<string, unknown> | null
}

const norm = (s: unknown) => String(s ?? '').trim().toLowerCase()

// Every string that should resolve to this sail: its name, category code,
// design code, and any manually-linked aliases.
export function sailTokens(s: InvSail): string[] {
  const al = Array.isArray(s?.specs?.aliases) ? (s.specs!.aliases as string[]) : []
  return [s.name, s.category, s.design_code, ...al].filter(Boolean).map(norm)
}

export function buildSailResolver(inventory: InvSail[] = []) {
  const byToken = new Map<string, InvSail>()
  for (const s of inventory || []) for (const t of sailTokens(s)) if (!byToken.has(t)) byToken.set(t, s)
  const resolveSail = (raw: string): InvSail | null => byToken.get(norm(raw)) || null
  return {
    resolveSail,
    // canonical inventory name (or the raw string unchanged if unmatched)
    resolve: (raw: string): string => resolveSail(raw)?.name || raw,
    has: (raw: string): boolean => byToken.has(norm(raw)),
  }
}

// Names referenced by an event file that are NOT in the inventory (nor an alias).
// `rawNames` = union of meta.sailsUsed + SailsUp event sail names.
export function unmatchedSails(rawNames: string[], inventory: InvSail[] = []): string[] {
  const r = buildSailResolver(inventory)
  const seen = new Set<string>()
  const out: string[] = []
  for (const n of rawNames || []) {
    const key = norm(n)
    if (!key || seen.has(key)) continue
    seen.add(key)
    if (!r.has(n)) out.push(String(n).trim())
  }
  return out
}
