// src/lib/sailListParse.ts
// ─────────────────────────────────────────────────────────────────────────────
// Parse the <saillist> block (and the boat name) out of an Expedition
// "daysail" event file (*.ev.xml). The list is the boat's sail inventory:
//
//   <boat val="Northstar 76" />
//   <saillist>
//     <item name="A1.5_2026" sailtype="Masthead Spinnaker" sailgroup="S" weight="49.2" />
//     <item name="J1_2026"   sailtype="Jib"                sailgroup="H" weight="62.5" />
//     <item name="MAIN_2026" sailtype="Mainsail"           sailgroup="M" weight="116.6" />
//     …
//   </saillist>
//
// sailgroup: M = main, H = headsail, S = spinnaker/downwind.
//
// Pure + regex-based (no DOMParser) to match parseXmlEvents' approach and stay
// usable both client- and server-side.
// ─────────────────────────────────────────────────────────────────────────────

export type SailKind = 'mainsail' | 'jib' | 'genoa' | 'staysail' | 'spinnaker' | 'gennaker' | 'code' | 'other'

export interface SailListItem {
  name: string
  sailType: string | null // verbatim, e.g. "Masthead Spinnaker"
  sailGroup: string | null // M | H | S
  weightKg: number | null
  kind: SailKind // mapped to the sails.kind enum
}

export interface ParsedSailList {
  boatName: string | null
  date: string | null
  items: SailListItem[]
}

const attr = (tag: string, name: string): string => {
  const m = tag.match(new RegExp(`\\b${name}="([^"]*)"`, 'i'))
  return m ? m[1] : ''
}

// Map Expedition sail-type text → our sails.kind enum. Order matters:
// "Spinnaker Staysail"/"Genoa Staysail" are staysails, so test Staysail first.
export function sailKindFromType(sailType: string | null, sailGroup?: string | null): SailKind {
  const s = (sailType || '').toLowerCase()
  if (/main/.test(s)) return 'mainsail'
  if (/staysail/.test(s)) return 'staysail'
  if (/gennaker/.test(s)) return 'gennaker'
  if (/spinnaker/.test(s)) return 'spinnaker'
  if (/genoa/.test(s)) return 'genoa'
  if (/\bjib\b/.test(s)) return 'jib'
  if (/code/.test(s)) return 'code'
  // fall back to the group letter when the type text is unknown
  const g = (sailGroup || '').toUpperCase()
  if (g === 'M') return 'mainsail'
  if (g === 'S') return 'spinnaker'
  if (g === 'H') return 'jib'
  return 'other'
}

export function parseSailList(xmlText: string): ParsedSailList {
  const text = (xmlText && xmlText.charCodeAt(0) === 0xfeff ? xmlText.slice(1) : xmlText) || ''

  const boatM = text.match(/<boat\b[^>]*?\bval="([^"]*)"/i)
  const dateM = text.match(/<date\b[^>]*?\bval="([^"]*)"/i)

  // Limit to the <saillist>…</saillist> block so we don't pick up other <item>s.
  const block = text.match(/<saillist\b[^>]*>([\s\S]*?)<\/saillist>/i)
  const items: SailListItem[] = []
  if (block) {
    const itemTags = block[1].match(/<item\b[^>]*?\/?>/gi) || []
    for (const tag of itemTags) {
      const name = attr(tag, 'name').trim()
      if (!name) continue
      const sailType = attr(tag, 'sailtype').trim() || null
      const sailGroup = attr(tag, 'sailgroup').trim() || null
      const wRaw = attr(tag, 'weight').trim()
      const weightKg = wRaw && !Number.isNaN(parseFloat(wRaw)) ? parseFloat(wRaw) : null
      items.push({ name, sailType, sailGroup, weightKg, kind: sailKindFromType(sailType, sailGroup) })
    }
  }

  return { boatName: boatM ? boatM[1].trim() || null : null, date: dateM ? dateM[1].trim() || null : null, items }
}
