// Write the sectioned AI headlines (Upwind / Downwind / Reaching / Sail shape) for a range of
// days, exactly as "✦ Write headlines" in Analytics does (lib/headlineFacts + headlineGenerate):
// Mistral on Scaleway (EU), every number checked against the day's facts.
//
//   npm run headlines:backfill -- --from 2026-09-02 --to 2026-09-12            dry run: which sections per day
//   npm run headlines:backfill -- --from 2026-09-02 --to 2026-09-12 --write    write and store them
//   … --boat <boat id>          when more than one boat's name matches "Northstar 76"
//   … --out <file.md>           also save everything written to a Markdown file
//
// Days without stored phase stats, or without a section with enough phases, are skipped.
// Replaces the headlines stored for a day. Uses .env.local (Supabase service key, Scaleway AI).

import { readFileSync, writeFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'
import { expandPhases, type StoredPhase } from '../src/lib/seasonCurves'
import { buildHeadlineFacts, SECTION_ORDER, SECTION_TITLES } from '../src/lib/headlineFacts'
import { generateHeadlines, DEFAULT_HEADLINES_MODEL } from '../src/lib/headlineGenerate'
import type { Manoeuvre } from '../src/lib/manoeuvres'

const USAGE = `Write AI headlines (Upwind / Downwind / Reaching / Sail shape) for a range of days.

Usage:
  npm run headlines:backfill -- --from YYYY-MM-DD --to YYYY-MM-DD [--write] [--boat BOAT_ID] [--out FILE.md]

  --write   generate and store (without it: dry run, no AI calls, nothing written)
  --boat    boat id, when more than one boat's name matches "Northstar 76"
  --out     also save the written headlines to a Markdown file

Needs .env.local (Supabase URL + service key, SCALEWAY_AI_*). In Claude Code's sandbox, run it outside the sandbox.`

const args = process.argv.slice(2)
const arg = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : null)
if (args.includes('--help') || args.includes('-h')) { console.log(USAGE); process.exit(0) }
const from = arg('--from'), to = arg('--to')
if (!from || !to || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) { console.error(USAGE); process.exit(1) }
const write = args.includes('--write')
const out = arg('--out')

const env = Object.fromEntries(
  readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    .split('\n')
    .filter(l => /^[A-Z0-9_]+=/.test(l))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')] }),
)
const fail = (msg: string) => { console.error(msg); process.exit(1) }
if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) fail('Supabase URL / service key missing in .env.local')
if (write && (!env.SCALEWAY_AI_API_KEY || !env.SCALEWAY_AI_BASE_URL)) fail('SCALEWAY_AI_API_KEY / SCALEWAY_AI_BASE_URL missing in .env.local')
const model = env.SCALEWAY_AI_MODEL || DEFAULT_HEADLINES_MODEL
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

async function main() {
  const boatArg = arg('--boat')
  const { data: boats, error: boatErr } = await sb.from('boats').select('id, name')
  if (boatErr) fail(`boats: ${boatErr.message}`)
  const matches = boatArg ? boats!.filter(b => b.id === boatArg) : boats!.filter(b => /northstar\s*76|\bns\s*76\b|\b76\b/i.test(b.name || ''))
  if (matches.length !== 1) fail(`${matches.length ? 'More than one' : 'No'} boat matches — pass --boat <id>:\n  ${boats!.map(b => `${b.id}  ${b.name}`).join('\n  ')}`)
  const boat = matches[0]

  const { data: rows, error } = await sb.from('session_phase_stats')
    .select('id, date, phases, manoeuvres, polar_name, resolution_s')
    .eq('boat_id', boat.id).gte('date', from).lte('date', to).order('date')
  if (error) fail(`stats: ${error.message}`)
  const { data: sessions } = await sb.from('sessions')
    .select('date, tz_offset_minutes, meta:xml_data->meta, sailsUpEvents:xml_data->sailsUpEvents')
    .eq('boat_id', boat.id).gte('date', from).lte('date', to)

  console.log(`Boat ${boat.name} · ${from} → ${to} · ${write ? `WRITING with ${model}` : 'dry run — no AI calls, nothing written'}\n`)
  const md: string[] = [`# Headlines — ${boat.name}, ${from} → ${to}`, '', `Mistral on Scaleway (EU) · ${model} · written ${new Date().toISOString().slice(0, 16)}Z`, '']
  let stored = 0
  for (const row of rows || []) {
    const s = ((sessions || []).find(x => x.date === row.date) || {}) as any
    const facts = buildHeadlineFacts({
      date: row.date,
      stats: expandPhases((row.phases || []) as StoredPhase[]),
      manoeuvres: (row.manoeuvres || []) as Manoeuvre[],
      tzOffsetMin: s.tz_offset_minutes ?? 0,
      polarName: row.polar_name ?? null,
      resolutionSeconds: row.resolution_s ?? null,
      boat: s.meta?.boat ?? null,
      venue: s.meta?.location ?? null,
      xml: { sailsUpEvents: s.sailsUpEvents || [] },
    })
    const present = SECTION_ORDER.filter(k => facts.sections[k])
    const dayType = s.meta?.dayType ? ` (${s.meta.dayType})` : ''
    const summary = present.map(k => `${SECTION_TITLES[k]} ${k === 'sailShape' ? `${facts.sections.sailShape!.lidarPhases} lidar phases` : `${(facts.sections as any)[k].phases} phases`}`).join(' · ')
    console.log(`${row.date}${dayType}: ${(row.phases || []).length} phases → ${summary || 'nothing to write about — skipped'}`)
    if (!present.length || !write) continue

    const r = await generateHeadlines(facts, { key: env.SCALEWAY_AI_API_KEY, base: env.SCALEWAY_AI_BASE_URL, model, timeoutMs: 120_000 })
    if (!r.ok) { console.log(`  ✕ ${r.error}${r.dropped?.length ? ` (${r.dropped.length} dropped)` : ''}\n`); continue }
    const at = new Date().toISOString()
    const { error: saveErr } = await sb.from('session_phase_stats').update({ headlines: r.headlines, headlines_model: r.model, headlines_at: at }).eq('id', row.id)
    if (saveErr) { console.log(`  ✕ save: ${saveErr.message}\n`); continue }
    stored++
    md.push(`## ${row.date}${dayType}`, '')
    for (const key of SECTION_ORDER) {
      const sec = r.headlines.sections[key]
      if (!sec) continue
      console.log(`  ${SECTION_TITLES[key]}`)
      md.push(`### ${SECTION_TITLES[key]}`, '')
      for (const h of sec.headlines) { console.log(`    • ${h}`); md.push(`- ${h}`) }
      if (sec.bottomLine.length) { console.log('    Bottom line'); md.push('', '**Bottom line**', '') }
      for (const b of sec.bottomLine) { console.log(`    → ${b}`); md.push(`- ${b}`) }
      md.push('')
    }
    if (r.headlines.dropped.length) {
      console.log(`  (${r.headlines.dropped.length} sentence(s) dropped by the number check)`)
      md.push(`_${r.headlines.dropped.length} sentence(s) dropped by the number check:_`, '', ...r.headlines.dropped.map(d => `- ~~${d}~~`), '')
    }
    console.log(`  ✓ stored · ${Math.round(r.ms / 1000)} s\n`)
  }
  if (write) console.log(`${stored} day(s) stored.`)
  if (write && out) { writeFileSync(out, md.join('\n')); console.log(`Saved to ${out}`) }
}

main().catch(e => fail(String(e?.stack || e)))
