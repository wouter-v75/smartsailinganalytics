#!/usr/bin/env node
// drone-clock-check.mjs — measure the DRONE's clock against the BOAT's GPS clock.
//
// The SRT sidecars fix a clip's time to the drone's own clock, and we showed that
// clock runs straight (0.001 s drift over five minutes). What that cannot tell us
// is whether it agrees with the boat's GPS clock — the frame every other SSA
// timestamp lives in. If the drone is 30 s out, every clip is filed 30 s wrong and
// nothing in the drone files would ever say so.
//
// METHOD. The drone follows the boat, so their tracks are the same shape offset by
// whatever the clocks disagree by. Slide the drone track against the boat track and
// find the offset that minimises the distance between them.
//
// Only samples where BOTH are moving are used: a drone hovering while the boat
// sails past carries no timing information, and including those flattens the
// minimum. The curve is printed so a flat one is visible as flat rather than
// reported as a precise answer.
//
//   ./scripts/drone-clock-check.mjs -l boat.csv "/path/Day 7"

import { readFileSync, readdirSync, statSync } from 'fs'
import { join, extname } from 'path'

const argv = process.argv.slice(2)
let boatCsv = '', span = 180, sources = []
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '-l' || a === '--log') boatCsv = argv[++i]
  else if (a === '--span') span = Number(argv[++i])
  else sources.push(a)
}
if (!boatCsv || !sources.length) {
  console.error('usage: drone-clock-check.mjs -l boat.csv <srt dir|files...> [--span 180]')
  process.exit(2)
}

const R = 6371000
const toRad = (d) => (d * Math.PI) / 180
function dist(a, b) {
  const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon)
  const la1 = toRad(a.lat), la2 = toRad(b.lat)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}
const median = (xs) => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

// ── boat: Datetime,Lat,Lon at 1 Hz, local wall clock ────────────────────────
const boat = new Map()   // epoch seconds -> {lat,lon}
{
  const lines = readFileSync(boatCsv, 'utf8').split('\n')
  const cols = lines[0].split(',').map((c) => c.trim().toLowerCase())
  const iT = cols.indexOf('datetime'), iLa = cols.indexOf('lat'), iLo = cols.indexOf('lon')
  if (iT < 0 || iLa < 0 || iLo < 0) { console.error('boat log needs Datetime, Lat, Lon'); process.exit(3) }
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(',')
    if (c.length < 3) continue
    const m = /(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(c[iT] || '')
    const la = parseFloat(c[iLa]), lo = parseFloat(c[iLo])
    if (!m || !Number.isFinite(la) || !Number.isFinite(lo)) continue
    boat.set(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) / 1000, { lat: la, lon: lo })
  }
}

// ── drone: one sample per second from every SRT ─────────────────────────────
const files = []
for (const s of sources) {
  if (statSync(s).isDirectory()) {
    for (const f of readdirSync(s)) if (/\.srt$/i.test(f)) files.push(join(s, f))
  } else if (/\.srt$/i.test(extname(s))) files.push(s)
}
const drone = new Map()
for (const f of files.sort()) {
  const txt = readFileSync(f, 'utf8')
  for (const block of txt.replace(/\r/g, '').split(/\n\s*\n/)) {
    const t = /(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(block)
    const la = /\[latitude\s*:\s*(-?\d+\.?\d*)\]/i.exec(block)
    // both spellings: 'longtitude' is DJI's own misspelling and ships on real firmware
    const lo = /\[(?:longitude|longtitude)\s*:\s*(-?\d+\.?\d*)\]/i.exec(block)
    if (!t || !la || !lo) continue
    const sec = Date.UTC(+t[1], +t[2] - 1, +t[3], +t[4], +t[5], +t[6]) / 1000
    if (!drone.has(sec)) drone.set(sec, { lat: +la[1], lon: +lo[1] })  // first cue of that second
  }
}
console.log(`boat: ${boat.size} positions · drone: ${drone.size} seconds across ${files.length} SRT files`)

// speed (m/s) from the neighbouring second, used only to drop stationary samples
const speedOf = (m, t) => {
  const a = m.get(t - 1), b = m.get(t + 1)
  return a && b ? dist(a, b) / 2 : null
}
const MOVING = 1.0   // m/s ~ 2 kn: below this neither track carries timing information
const samples = []
for (const [t, dp] of drone) {
  const ds = speedOf(drone, t), bs = speedOf(boat, t)
  if (ds == null || bs == null || ds < MOVING || bs < MOVING) continue
  samples.push([t, dp])
}
console.log(`usable samples (both moving > ${MOVING} m/s): ${samples.length}`)
if (samples.length < 60) { console.error('too few overlapping moving samples to say anything'); process.exit(1) }

// ── slide and score ─────────────────────────────────────────────────────────
const scores = []
for (let off = -span; off <= span; off++) {
  const ds = []
  for (const [t, dp] of samples) {
    const bp = boat.get(t + off)
    if (bp) ds.push(dist(dp, bp))
  }
  if (ds.length >= samples.length * 0.5) scores.push({ off, med: median(ds), n: ds.length })
}
scores.sort((a, b) => a.med - b.med)
const best = scores[0]
const at0 = scores.find((s) => s.off === 0)
const worst = scores[scores.length - 1]

console.log(`\nbest offset: ${best.off > 0 ? '+' : ''}${best.off} s   median separation ${best.med.toFixed(0)} m`)
console.log(`at zero offset:            median separation ${at0 ? at0.med.toFixed(0) : '—'} m`)
console.log(`worst offset in range:     median separation ${worst.med.toFixed(0)} m`)

const byOff = new Map(scores.map((s) => [s.off, s.med]))
console.log('\ncurve (median separation, m):')
for (let o = -60; o <= 60; o += 10) {
  const v = byOff.get(o)
  if (v == null) continue
  const bar = '#'.repeat(Math.max(1, Math.round((v - best.med) / Math.max(1, (worst.med - best.med)) * 40)))
  console.log(`  ${String(o).padStart(4)} s  ${v.toFixed(0).padStart(5)} m  ${bar}`)
}

// A minimum only means something if the curve actually rises away from it.
const depth = worst.med - best.med
console.log(`\ncurve depth: ${depth.toFixed(0)} m (worst - best)`)
if (depth < 20) {
  console.log('VERDICT: curve is flat — the tracks do not constrain the offset. No conclusion.')
} else if (Math.abs(best.off) <= 2) {
  console.log(`VERDICT: drone and boat clocks agree to within ${Math.abs(best.off)} s.`)
} else {
  console.log(`VERDICT: the drone clock appears ${best.off > 0 ? 'BEHIND' : 'AHEAD OF'} the boat clock by ${Math.abs(best.off)} s.`)
  console.log('         (drone timestamps would need that much added to match boat time)')
}
