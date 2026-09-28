// Put a sailmaker's batten sheet into a mainsail's batten card.
//
//   npx vite-node scripts/batten-card-import.ts --sheet northstar76-im2-2026
//   …same, plus --write, to actually store it
//
// WHY A SCRIPT AND NOT TYPING. The card is 8 battens x 5 bands x 3 fields = 120
// cells, read off a photograph of a laminated sheet held at an angle on a dock.
// Typing that into a form is forty minutes and at least one transposition, and a
// transposed batten is a real trim error that nobody catches until the sail is
// up. Here the transcription is reviewable as a block, diffable when the
// sailmaker issues v6, and the sheet's own structure is visible in the source.
//
// The sheet is the SAILMAKER's document and its vocabulary is kept: the part
// reference per cell (M1-S, M2-H) is stored verbatim beside the colour-derived
// tension, because the model — M1 vs M2 — is an independent axis and a cell can
// be black "medium" while carrying an -H part.
//
// BATTEN 1 IS THE TOP ONE, on the sheet and in `BattenCard.rows`, so the columns
// map straight across. Confirmed with Wouter 28 Sep 2026; the El figures grow
// toward B1 (925 against B8's 395), which reads as though B1 were the longest
// and therefore lowest batten, so this is worth having asked rather than assumed.
//
// Dry run by default. Reads .env.local, and must run OUTSIDE Claude Code's Bash
// sandbox.

import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'
import {
  normaliseBattenCard, setBattenCount, WIND_BANDS,
  type BattenCard, type BattenSetting, type Tension,
} from '../src/lib/battens'

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const WRITE = process.argv.includes('--write')
const SHEET = arg('sheet') || 'northstar76-im2-2026'

const env = Object.fromEntries(
  readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    .split('\n').filter((l) => /^[A-Z0-9_]+=/.test(l))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')] }),
)
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })

// ─────────────────────────────────────────────────────────────────────────────
// The sheets, transcribed.
//
// One entry per band, B1..B8 left to right, exactly as the sheet prints them.
// `"M1-S 925 g"` is part reference, Batt. El, and the COLOUR the figure is
// printed in — g green / k black / r red, which is what carries soft / medium /
// hard. The colour and the part reference disagree often enough that both are
// needed: at 10-12 knots B5 and B6 are M1-S parts printed in black.
// ─────────────────────────────────────────────────────────────────────────────
const COLOUR_TENSION: Record<string, Tension> = { g: 'soft', k: 'medium', r: 'hard' }

interface Sheet {
  boat: string
  /** The sail as it is named in `sails`, not as the sheet refs it. */
  sail: string
  /** The sheet's own reference, kept for the diff when v6 arrives. */
  sheetRef: string
  battenCount: number
  /** bandKey → the eight cells, B1 (TOP) first. */
  bands: Record<string, string[]>
  /** bandKey → { battenIndex (0-based, top first) → note }. */
  notes?: Record<string, Record<number, string>>
}

const SHEETS: Record<string, Sheet> = {
  // NorthStar London, Mainsail Ref IM-2 2026, v5 - PG, Sept 26.
  // Head Dim. 1/2, Tack, Lashings, Boltrope, Turns and Comments are all blank on
  // this issue, so there is nothing to import from them. The greyed
  // "Prev. El (For Ref)" row (901/332/413/427/75 Plate/138/173/214) is last
  // issue's figures kept for comparison, not a setting — deliberately not here.
  'northstar76-im2-2026': {
    boat: 'Northstar 76',
    sail: 'MAIN_B 2026',
    sheetRef: 'IM-2 2026 · v5 - PG · Sept 26',
    battenCount: 8,
    bands: {
      '0-8':   ['M1-S 925 g', 'M1-S 494 g', 'M1-S 568 g', 'M1-S 648 g', 'M2-S 241 g', 'M2-S 263 g', 'M1-S 298 g', 'M1-S 395 g'],
      '8-10':  ['M1-S 925 g', 'M1-S 494 g', 'M1-H 736 k', 'M1-S 648 g', 'M2-S 241 g', 'M2-S 263 g', 'M1-S 298 g', 'M1-S 395 g'],
      '10-12': ['M1-S 925 g', 'M1-H 597 k', 'M1-H 736 k', 'M1-H 832 k', 'M1-S 267 k', 'M1-S 280 k', 'M1-H 395 k', 'M1-H 427 k'],
      // The sheet prints this band as 12-16 knots.
      '12-17': ['M1-H 1147 k', 'M2-H 669 r', 'M2-H 816 r', 'M2-H 925 r', 'M1-H 307 k', 'M1-H 367 k', 'M1-H 395 k', 'M1-H 427 k'],
      // The sheet prints this band as 18+ knots. 16-18 was undefined on the
      // printed sheet; Wouter's instruction is that the break is at 17.
      '17+':   ['M1-H 1147 k', 'M2-H 669 r', 'M2-H 816 r', 'M2-H 925 r', 'M2-H 378 r', 'M2-H 424 r', 'M2-H 420 r', 'M2-H 474 r'],
    },
    notes: {
      '0-8': { 0: 'Soften(900)', 1: 'Soften(450)' },
    },
  },
}

/** `"M1-S 925 g"` → a cell. */
function parseCell(spec: string): BattenSetting {
  const m = /^(\S+)\s+(\d+)\s+([gkr])$/.exec(spec.trim())
  if (!m) throw new Error(`cannot read cell "${spec}" — expected "<ref> <el> <g|k|r>"`)
  return { tension: COLOUR_TENSION[m[3]], turns: 0, ref: m[1], elMm: Number(m[2]) }
}

function cardFromSheet(sheet: Sheet): BattenCard {
  for (const key of Object.keys(sheet.bands)) {
    if (!WIND_BANDS.some((b) => b.key === key)) throw new Error(`band "${key}" is not one of the card's bands`)
    const n = sheet.bands[key].length
    if (n !== sheet.battenCount) throw new Error(`band "${key}" has ${n} cells, expected ${sheet.battenCount}`)
  }
  const rows: Record<string, BattenSetting>[] = []
  for (let i = 0; i < sheet.battenCount; i++) {
    const row: Record<string, BattenSetting> = {}
    for (const [key, cells] of Object.entries(sheet.bands)) {
      const cell = parseCell(cells[i])
      const note = sheet.notes?.[key]?.[i]
      row[key] = note ? { ...cell, note } : cell
    }
    rows.push(row)
  }
  return normaliseBattenCard({ count: sheet.battenCount, rows })
}

async function main() {
  const sheet = SHEETS[SHEET]
  if (!sheet) {
    console.error(`no sheet called "${SHEET}". Known: ${Object.keys(SHEETS).join(', ')}`)
    process.exit(1)
  }

  const { data: boats } = await sb.from('boats').select('id, team_id, name')
  const boat = (boats || []).find((b) => b.name.toLowerCase() === sheet.boat.toLowerCase())
  if (!boat) { console.error(`no boat called "${sheet.boat}"`); process.exit(1) }

  const { data: sails } = await sb.from('sails').select('id, boat_id, name, kind')
  const sail = (sails || []).find((s) => s.boat_id === boat.id && s.name === sheet.sail)
  if (!sail) {
    console.error(`no sail "${sheet.sail}" on ${boat.name}. It has: `
      + (sails || []).filter((s) => s.boat_id === boat.id && s.kind === 'mainsail').map((s) => `"${s.name}"`).join(', '))
    process.exit(1)
  }

  const card = cardFromSheet(sheet)
  console.log(`${boat.name} · ${sail.name} · ${sheet.sheetRef}${WRITE ? ' · WRITING' : ' · dry run'}\n`)

  const w = 14
  console.log('  batten   ' + WIND_BANDS.map((b) => b.label.padEnd(w)).join(''))
  for (let i = 0; i < card.count; i++) {
    const cells = WIND_BANDS.map((b) => {
      const c = card.rows[i][b.key]
      return (c ? `${c.ref} ${c.elMm}` : '—').padEnd(w)
    })
    console.log(`  B${i + 1}${i === 0 ? ' (top)' : '      '} ` + cells.join(''))
  }
  console.log('\n  tension   ' + WIND_BANDS.map((b) => b.label.padEnd(w)).join(''))
  for (let i = 0; i < card.count; i++) {
    console.log(`  B${i + 1}        `
      + WIND_BANDS.map((b) => (card.rows[i][b.key]?.tension ?? '—').padEnd(w)).join(''))
  }
  for (const [key, per] of Object.entries(sheet.notes || {})) {
    for (const [idx, note] of Object.entries(per)) console.log(`\n  note · B${Number(idx) + 1} @ ${key}: ${note}`)
  }

  // The card in the DB may have been created with a different batten count.
  const { data: existing } = await sb.from('boat_battens')
    .select('card').eq('boat_id', boat.id).eq('sail_id', sail.id).maybeSingle()
  if (existing) {
    const cur = normaliseBattenCard(existing.card)
    console.log(`\n  existing card: ${cur.count} batten(s), `
      + `${cur.rows.reduce((n, r) => n + Object.keys(r).length, 0)} filled cell(s) — will be replaced`)
    if (cur.count !== card.count) console.log(`  batten count ${cur.count} → ${card.count}`)
  } else {
    console.log('\n  no card on this sail yet')
  }

  if (!WRITE) { console.log('\n  (dry run — pass --write)'); return }
  const { error } = await sb.from('boat_battens').upsert({
    team_id: boat.team_id, boat_id: boat.id, sail_id: sail.id,
    card: setBattenCount(card, card.count),
    updated_at: new Date().toISOString(),
  }, { onConflict: 'team_id,boat_id,sail_id' })
  console.log(error ? `\n  FAILED ${error.message}` : '\n  stored')
}

void main()
