#!/usr/bin/env -S node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON
// clip-progress.mjs — how far along is a select-race-clips encode?
//
//   ./scripts/clip-progress.mjs ~/Downloads/ssa-compress/day4-drone
//   ./scripts/clip-progress.mjs <dir> --watch      # refresh every 10 s
//
// Progress is measured in SECONDS OF FOOTAGE, not in segments: a run is typically
// one 380 s cut next to a 20 s one, so "3 of 7 done" can mean anything between a
// tenth and half the work. The in-flight segment is estimated from the size of its
// .part file against the bitrate the finished ones actually achieved.

import { readFileSync, existsSync, statSync, readdirSync } from 'fs'
import { join, basename } from 'path'

const args = process.argv.slice(2)
const watch = args.includes('--watch')
const dir = args.find((a) => !a.startsWith('-'))
if (!dir) { console.error('usage: clip-progress.mjs <output-dir> [--watch]'); process.exit(1) }
const manifestPath = join(dir, 'manifest.json')
if (!existsSync(manifestPath)) { console.error(`no manifest.json in ${dir}`); process.exit(1) }

const sizeOf = (p) => { try { return statSync(p).size } catch { return 0 } }
const fmtMB = (b) => (b >= 1073741824 ? `${(b / 1073741824).toFixed(1)}G` : `${Math.round(b / 1048576)}M`)
const mmss = (s) => `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, '0')}s`

function render() {
  const man = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const items = man.items || []
  const started = statSync(manifestPath).mtimeMs

  let doneSec = 0, doneBytes = 0, totalSec = 0
  const rows = items.map((it) => {
    const out = join(dir, `${it.name}.mp4`)
    const part = join(dir, `.${it.name}.part.mp4`)
    const dur = it.durSec || 0
    totalSec += dur
    if (existsSync(out)) { doneSec += dur; doneBytes += sizeOf(out); return { it, state: 'done', bytes: sizeOf(out) } }
    if (existsSync(part)) return { it, state: 'busy', bytes: sizeOf(part) }
    return { it, state: 'todo', bytes: 0 }
  })

  // Bitrate the finished segments actually achieved — the only honest basis for
  // guessing how far into the current one we are.
  const bps = doneSec > 0 ? doneBytes / doneSec : 0
  let busySec = 0
  for (const r of rows) {
    if (r.state !== 'busy' || !bps) continue
    busySec = Math.min(r.it.durSec || 0, r.bytes / bps)
    r.pct = r.it.durSec ? Math.min(99, Math.round((busySec / r.it.durSec) * 100)) : null
  }

  const encoded = doneSec + busySec
  const pct = totalSec ? encoded / totalSec : 0
  const W = 34
  const bar = '█'.repeat(Math.round(pct * W)) + '░'.repeat(W - Math.round(pct * W))

  const out = []
  out.push(`\n${basename(dir)} — ${items.length} segments · ${mmss(totalSec)} of footage`)
  if (man.events) out.push(`  ${basename(man.events)}${man.tag ? ` · tag ${man.tag}` : ''}`)
  out.push('')
  for (const r of rows) {
    const mark = r.state === 'done' ? '✓' : r.state === 'busy' ? '⟳' : '·'
    const size = r.bytes ? fmtMB(r.bytes).padStart(6) : '      '
    const note = r.state === 'busy' ? `  ~${r.pct ?? '??'}%` : ''
    out.push(`  ${mark} ${r.it.name.slice(0, 46).padEnd(46)} ${String(Math.round(r.it.durSec || 0)).padStart(4)}s ${size}${note}`)
  }
  const nDone = rows.filter((r) => r.state === 'done').length
  // Rate from wall-clock since the manifest was written. It is only a guide: the
  // manifest predates any resume, so a resumed run reads optimistic at first.
  const elapsed = (Date.now() - started) / 1000
  const rate = encoded > 0 ? elapsed / encoded : 0
  const left = rate > 0 ? (totalSec - encoded) * rate : 0
  out.push('')
  out.push(`  [${bar}] ${String(Math.round(pct * 100)).padStart(3)}%   ${nDone}/${items.length} segments` +
    (left > 0 && nDone < items.length ? `  ·  ~${mmss(left)} left` : nDone === items.length ? '  ·  complete' : ''))
  return out.join('\n')
}

if (!watch) { console.log(render()); process.exit(0) }
const tick = () => { process.stdout.write('\x1Bc'); console.log(render()) }
tick(); setInterval(tick, 10000)
