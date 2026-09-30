// scripts/log-merge.ts — one day's log out of a folder of Expedition parts.
//
//   npm run log:merge -- "/Volumes/SSK SSD/121279586-2026-09-30T114426898_a"
//   npm run log:merge -- <folder> --write
//
// Expedition rolls its export to a new file during a session, so a day comes off
// the card as a folder of parts. SSA imports ONE file per day — importing the
// parts one after another REPLACES the day's log each time rather than extending
// it, which is the same `reduce` path CLAUDE.md warns about for re-imports.
//
// Dry-run by default, like every other script here. It reports what it found,
// where the parts join, and where the log stopped and started again; --write
// puts the merged file in ~/Downloads, next to the day's event file.
//
// BYTES, not text. The file is read and written as latin1, which maps bytes 1:1
// to code points, so whatever the export's encoding is it comes out unchanged.
// That matters here: this layout writes the degree sign as a single high byte
// (it renders as ∞ if you read it as Mac Roman), and decoding it as UTF-8 would
// replace every one of them with U+FFFD and rename half the columns.

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { basename, join, resolve } from 'path'
import { homedir } from 'os'
import { planMerge, mergedText, type LogPart } from '../src/lib/logPartsMerge'

const USAGE = `Join a folder of Expedition log parts into one file SSA can import.

Usage:
  npm run log:merge -- <folder> [--write] [options]

  --write        write the merged file (without this: report and stop)
  --out PATH     where it goes          (default: ~/Downloads/<date>_log.csv)
  --gap N        report a break longer than N seconds   (default: 60)
  --ext .csv     only these extensions, comma-separated (default: .csv,.txt,.log)
  --help         this text
`

const args = process.argv.slice(2)
const has = (f: string) => args.includes(f)
const val = (f: string, d?: string) => {
  const i = args.indexOf(f)
  return i >= 0 && args[i + 1] ? args[i + 1] : d
}
if (has('--help') || !args.length) { console.log(USAGE); process.exit(0) }

// Annotated on the VARIABLE, not just the arrow: TypeScript only narrows past a
// never-returning call when the declaration carries the type, so without this
// `plan` stays a union after `if (!plan.ok) fail(...)`.
const fail: (m: string) => never = (m) => { console.error(`\n✕ ${m}\n`); process.exit(1) }

const folder = resolve(args.find((a) => !a.startsWith('-')) || '')
if (!existsSync(folder) || !statSync(folder).isDirectory()) {
  fail(`not a folder: ${folder}\n  (quote the path — the volume name has a space)`)
}

const exts = String(val('--ext', '.csv,.txt,.log')).split(',').map((e) => e.trim().toLowerCase())
const files = readdirSync(folder)
  .filter((f) => !f.startsWith('.') && exts.some((e) => f.toLowerCase().endsWith(e)))
  .sort()

if (!files.length) fail(`no ${exts.join(' / ')} files in ${folder}`)

const hhmmss = (ms: number | null) => (ms == null ? '—' : new Date(ms).toISOString().slice(11, 19))
const dayOf = (ms: number | null) => (ms == null ? null : new Date(ms).toISOString().slice(0, 10))
const mb = (n: number) => `${(n / 1048576).toFixed(1)}M`

console.log(`\n${basename(folder)}`)
console.log(`  ${files.length} part file${files.length === 1 ? '' : 's'}\n`)

const parts: LogPart[] = files.map((f) => ({
  name: f,
  text: readFileSync(join(folder, f), 'latin1'),
}))

const plan = planMerge(parts, { gapSec: Number(val('--gap', '60')) })
if (!plan.ok) fail(plan.error)

const W = Math.max(...plan.parts.map((p) => p.name.length), 4)
console.log(`  ${'PART'.padEnd(W)}   ROWS    KEPT   FROM      TO`)
console.log(`  ${'─'.repeat(W + 34)}`)
for (const p of plan.parts) {
  console.log(
    `  ${p.name.padEnd(W)}  ${String(p.rows).padStart(6)}  ${String(p.kept).padStart(6)}   ` +
    `${hhmmss(p.firstUtc)}  ${hhmmss(p.lastUtc)}`
  )
}

console.log(`\n  ${plan.rows} rows · ${hhmmss(plan.firstUtc)} → ${hhmmss(plan.lastUtc)}` +
  ` (${dayOf(plan.firstUtc) || '?'}, as the stamps are written)`)
if (plan.overlapDropped) {
  console.log(`  ${plan.overlapDropped} duplicate row(s) trimmed where the parts overlap`)
}
if (plan.unstamped) {
  console.log(`  ⚠ ${plan.unstamped} row(s) with a timestamp this could not read — kept, but check the layout`)
}
if (plan.gaps.length) {
  console.log(`\n  The log stopped and restarted ${plan.gaps.length} time(s):`)
  for (const g of plan.gaps) {
    console.log(`    ${hhmmss(g.afterUtc)} → ${hhmmss(g.beforeUtc)}   ${g.seconds}s`)
  }
  console.log(`  (a gap is not an error — it is the logger being off. Nothing was lost here.)`)
}

const out = resolve(
  val('--out') || join(homedir(), 'Downloads', `${dayOf(plan.firstUtc) || 'log'}_log.csv`)
)

if (!has('--write')) {
  console.log(`\nThat was a dry run. Same command with --write to produce:\n  ${out}\n`)
  process.exit(0)
}

const text = mergedText(plan)
writeFileSync(out, Buffer.from(text, 'latin1'))
console.log(`\n✓ ${out}  (${mb(Buffer.byteLength(text, 'latin1'))})`)
console.log(`\nNext: Upload tab → import it as the day's log.\n`)
