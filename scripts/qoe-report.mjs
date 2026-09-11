#!/usr/bin/env node
// Playback quality report — from public.playback_events (written by /api/qoe).
//
//   node scripts/qoe-report.mjs            last 7 days
//   node scripts/qoe-report.mjs --days 1   since yesterday
//
// Per platform: plays, failure rate, exits before the first frame, time to
// first frame (median / 90th percentile) and rebuffering (% of watch time).
// Then the most common failure reasons. Reads .env.local for the Supabase URL
// and service key (the table has no client access).

import { readFileSync } from 'fs'

const env = Object.fromEntries(
  readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => /^[A-Z0-9_]+=/.test(l))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')] }),
)
const URL_ = env.NEXT_PUBLIC_SUPABASE_URL
const KEY = env.SUPABASE_SERVICE_ROLE_KEY
if (!URL_ || !KEY) { console.error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing in .env.local'); process.exit(1) }

const i = process.argv.indexOf('--days')
const days = i > 0 ? Number(process.argv[i + 1]) || 7 : 7
const since = new Date(Date.now() - days * 86_400_000).toISOString()

const res = await fetch(`${URL_}/rest/v1/playback_events?created_at=gte.${since}&select=*&order=created_at.desc&limit=20000`, {
  headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
})
if (!res.ok) {
  const t = await res.text()
  console.error(`HTTP ${res.status}: ${t.slice(0, 300)}`)
  if (/playback_events/.test(t)) console.error('→ the table does not exist yet: run `npm run db:push` (migration 0057).')
  process.exit(1)
}
const rows = await res.json()
console.log(`Playback quality — last ${days} day(s): ${rows.length} clip views\n`)
if (!rows.length) process.exit(0)

const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : '—')
const quant = (xs, q) => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]
}
const sec = (ms) => (ms == null ? '—' : `${(ms / 1000).toFixed(1)} s`)

const groups = new Map()
for (const r of rows) {
  const k = r.platform || 'unknown'
  if (!groups.has(k)) groups.set(k, [])
  groups.get(k).push(r)
}
const line = (cols) => console.log(cols.map((c, j) => String(c).padEnd([10, 7, 9, 9, 10, 10, 11][j] || 10)).join(' '))
line(['platform', 'views', 'failed', 'left<1st', 'TTFF p50', 'TTFF p90', 'rebuffer'])
for (const [k, g] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
  const played = g.filter((r) => r.outcome === 'played')
  const ttff = played.map((r) => r.ttff_ms).filter((x) => x != null)
  const watch = g.reduce((s, r) => s + (r.watch_ms || 0), 0)
  const rebuf = g.reduce((s, r) => s + (r.rebuffer_ms || 0), 0)
  line([k, g.length, pct(g.filter((r) => r.outcome === 'failed').length, g.length),
    pct(g.filter((r) => r.outcome === 'exited_before_start').length, g.length),
    sec(quant(ttff, 0.5)), sec(quant(ttff, 0.9)), pct(rebuf, watch + rebuf)])
}

const reasons = new Map()
for (const r of rows.filter((r) => r.outcome === 'failed')) {
  const k = `${r.platform || '?'} · ${r.engine || '?'} · ${r.error || '?'}`
  reasons.set(k, (reasons.get(k) || 0) + 1)
}
if (reasons.size) {
  console.log('\nFailures (platform · engine · reason):')
  for (const [k, n] of [...reasons].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`  ${String(n).padStart(4)}  ${k}`)
}
