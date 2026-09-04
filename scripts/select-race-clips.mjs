#!/usr/bin/env -S node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON
// select-race-clips.mjs — pick the clips worth compressing FIRST.
//
// After a day's sailing you come back with a USB drive of drone/RIB footage and an
// Expedition event file. Most of that footage is transit, waiting and general
// milling about; the parts anyone actually reviews are the starts and the mark
// roundings. This matches clips against the event file and compresses only those,
// so the useful footage is ready to upload while the rest can wait.
//
// ── THE DAY, IN THREE PASSES ─────────────────────────────────────────────────
// 1. After sailing — proxies of the moments that matter, so the team can watch
//    tonight. Small and quick; upload these from SSA.
//       select-race-clips.mjs -e day.ev.xml "/Volumes/CARD/Day 2" --trim --tag day2 -o day2
//
// 2. Before the debrief — the SAME moments at full resolution on the laptop for
//    the big screen. Replays the manifest pass 1 wrote, so the cuts are identical,
//    and stream-copies them: lossless, and as fast as the card can be read.
//       select-race-clips.mjs --full-res day2/manifest.json -o day2-hd
//    (--from <folder> if the card has since remounted somewhere else.)
//
// 3. Later — everything that matched no event, compressed and uploaded.
//       select-race-clips.mjs -e day.ev.xml "/Volumes/CARD/Day 2" --rest -o day2-rest
//
//   select-race-clips.mjs -e day.ev.xml "/Volumes/CARD/Day 2" -n     # report only
//
// Output lands in ./selected (override with -o). It never writes to the source
// folder, so pointing this at a card or a USB drive is safe.
//
// Needs: exiftool + ffmpeg  (brew install exiftool ffmpeg)
//
// ── HOW CLIPS ARE PLACED IN TIME ─────────────────────────────────────────────
// Everything is matched in LOCAL WALL-CLOCK, because that is the one frame both
// sources already agree on: Expedition writes the event file in the boat's local
// time, and cameras name their files with the local clock. Working this way means
// no timezone has to be supplied and no offset can be applied twice.
//
// Per clip, in the order SSA itself uses (see check-video-timestamps.sh):
//   1. Keys:CreationDate — local time WITH offset; the local part is taken as-is.
//   2. A timestamp in the FILENAME (20260903 125443 / DJI_20260903125443 / …).
//   3. mvhd — UTC, and on many cameras it is the FINALISATION time, i.e. a whole
//      duration late. Used only as a last resort and flagged in the report.
// Use --shift to correct a camera whose clock was wrong.

import { readFileSync, writeFileSync, existsSync, statSync, readdirSync, mkdirSync } from 'fs'
import { join, basename, extname, resolve, dirname } from 'path'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import { parseXmlEvents } from '../src/lib/xmlEventParse.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v'])

// ── args ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const opt = {
  // Each kind of moment needs a different amount of run-in and run-out: a start
  // needs the approach, a rounding needs the exit, a tack needs neither for long.
  events: '', out: 'selected',
  startLead: 150, startLag: 90,     // 2:30 before the gun → 1:30 after
  topLead: 60, topLag: 90,          // 1:00 before the top mark → 1:30 after
  gateLead: 60, gateLag: 60,        // 1:00 either side of the gate / spin drop
  turnLead: 30, turnLag: 60,        // 0:30 before a tack or gybe → 1:00 after
  shift: 0, rest: false, archive: false, dry: false, validOnly: false, trim: false, gap: 20, minSeg: 15, noTurns: false,
  tag: '', keepNames: false, fullRes: '', from: '', sources: [],
}
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  const next = () => argv[++i]
  if (a === '--events' || a === '-e') opt.events = next()
  else if (a === '--out' || a === '-o') opt.out = next()
  else if (a === '--start-lead') opt.startLead = Number(next())
  else if (a === '--start-lag') opt.startLag = Number(next())
  else if (a === '--top-lead') opt.topLead = Number(next())
  else if (a === '--top-lag') opt.topLag = Number(next())
  else if (a === '--gate-lead') opt.gateLead = Number(next())
  else if (a === '--gate-lag') opt.gateLag = Number(next())
  else if (a === '--turn-lead') opt.turnLead = Number(next())
  else if (a === '--turn-lag') opt.turnLag = Number(next())
  else if (a === '--no-turns') opt.noTurns = true
  else if (a === '--shift') opt.shift = Number(next())
  else if (a === '--rest') opt.rest = true
  else if (a === '--valid-only') opt.validOnly = true
  else if (a === '--trim') opt.trim = true
  else if (a === '--gap') opt.gap = Number(next())
  else if (a === '--tag') opt.tag = next()
  else if (a === '--keep-names') opt.keepNames = true
  else if (a === '--full-res') opt.fullRes = next()
  else if (a === '--from') opt.from = next()
  else if (a === '--archive') opt.archive = true
  else if (a === '--dry-run' || a === '-n') opt.dry = true
  else if (a === '--help' || a === '-h') { usage(); process.exit(0) }
  else if (a.startsWith('-')) die(`unknown option ${a}`)
  else opt.sources.push(a)
}

function usage() {
  console.log(`usage: select-race-clips.mjs --events <file.ev.xml> <folder|files…> [options]

  -e, --events <f>    Expedition event file (.ev.xml)              [required]
  -o, --out <dir>     where compressed clips go        (default: ./selected)
      --start-lead N  seconds before a start gun                (default: 150)
      --start-lag N   seconds after a start gun                  (default: 90)
      --top-lead N    seconds before a top-mark rounding         (default: 60)
      --top-lag N     seconds after a top-mark rounding          (default: 90)
      --gate-lead N   seconds before a gate / spin drop          (default: 60)
      --gate-lag N    seconds after a gate / spin drop           (default: 60)
      --turn-lead N   seconds before a tack or gybe              (default: 30)
      --turn-lag N    seconds after a tack or gybe               (default: 60)
      --no-turns      leave tacks and gybes out (there are many)
      --shift N       shift every clip by N minutes (wrong camera clock)
      --rest          select the clips that match NOTHING (the later pass)
      --valid-only    skip events Expedition flagged invalid (kept by default)
      --trim          cut each clip down to just its event windows (see below)
      --gap N         merge segments closer than N seconds        (default: 20)
      --tag TEXT      extra tag put in every output filename (e.g. day2)
      --keep-names    keep original stems instead of tagged names
      --full-res M    re-cut the segments in manifest M at source resolution
      --from DIR      where the source clips live now, if the card moved
      --archive       slower, smaller compression
  -n, --dry-run       report the selection, compress nothing`)
}
function die(msg) { console.error(`✕ ${msg}`); process.exit(1) }
function have(bin) { return spawnSync('command', ['-v', bin], { shell: true }).status === 0 }

// ── full-res pass ────────────────────────────────────────────────────────────
// Stage 2 of the day: the proxies are already up and the team is watching them,
// and now the same moments are wanted at full resolution on the laptop for the
// debrief. Re-cut from the manifest the proxy run wrote, so the segments are
// identical — same boundaries, same names — and stream-copy them, which is
// lossless and about as fast as reading the card allows.
if (opt.fullRes) {
  if (!have('ffmpeg')) die('ffmpeg not found — brew install ffmpeg')
  if (!existsSync(opt.fullRes)) die(`manifest not found: ${opt.fullRes}`)
  const man = JSON.parse(readFileSync(opt.fullRes, 'utf8'))
  const items = man.items || []
  if (!items.length) die('that manifest lists no segments')

  // The card rarely remounts at the same path; --from re-finds each source by name.
  let index = null
  if (opt.from) {
    index = new Map()
    const idx = (dir) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name.startsWith('.')) continue
        const full = join(dir, e.name)
        if (e.isDirectory()) idx(full)
        else if (!index.has(e.name)) index.set(e.name, full)
      }
    }
    if (!existsSync(opt.from)) die(`--from not found: ${opt.from}`)
    idx(opt.from)
  }

  mkdirSync(opt.out, { recursive: true })
  console.log(`\n● Full resolution from ${basename(opt.fullRes)} → ${opt.out}/`)
  console.log(`  ${items.length} segment(s) · stream copy, no re-encode\n`)
  let n = 0, bad = 0, missing = 0
  for (const it of items) {
    n++
    let src = it.src
    if (!existsSync(src) && index) src = index.get(basename(it.src)) || src
    if (!existsSync(src)) {
      console.log(`[${n}/${items.length}]   → ${it.name} … SOURCE MISSING (${basename(it.src)})`)
      missing++; continue
    }
    process.stdout.write(`[${n}/${items.length}] `)
    const args = ['--copy', '--out', opt.out, '--name', it.name, src]
    if (it.ssSec > 0) args.splice(1, 0, '--ss', String(it.ssSec))
    if (it.durSec > 0) args.splice(1, 0, '--t', String(it.durSec))
    const r = spawnSync(join(HERE, 'compress-videos.sh'), args, { stdio: 'inherit' })
    if (r.status !== 0) bad++
  }
  console.log(`\n✓ ${n - bad - missing}/${items.length} segments → ${opt.out}`)
  if (missing) console.log(`⚠ ${missing} source clip(s) not found — pass --from <folder> if the card is mounted elsewhere.`)
  process.exit(bad || missing ? 1 : 0)
}

if (!opt.events) { usage(); die('--events is required') }
if (!existsSync(opt.events)) die(`event file not found: ${opt.events}`)
if (!opt.sources.length) { usage(); die('give a folder of clips (or the files)') }
if (!have('exiftool')) die('exiftool not found — brew install exiftool')
if (!have('ffmpeg')) die('ffmpeg not found — brew install ffmpeg')

// ── collect clips ────────────────────────────────────────────────────────────
// Card layouts nest: <Day 2>/{Camera,DJI_001}/… — so walk the tree rather than
// making the user name every subfolder.
// Never descend into our own output. Pointing this at a folder that already holds
// a compressed/ or selected/ run would otherwise re-select those outputs as if they
// were fresh footage — and they carry the same timestamps, so they match the same
// events and quietly double everything.
const OUTDIR = resolve(opt.out)
const skipped = []
function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name.startsWith('.')) continue
    const full = join(dir, e.name)
    if (e.isDirectory()) {
      // Skip our own output, and any folder that looks like a PREVIOUS run's:
      // one holding a manifest.json, or compress-videos.sh's default "compressed".
      // Those hold re-encodes of clips already in this tree, carrying the same
      // timestamps — so they match the same events and quietly double everything.
      if (resolve(full) === OUTDIR) continue
      if (e.name === 'compressed' || existsSync(join(full, 'manifest.json'))) {
        skipped.push(full); continue
      }
      walk(full, out)
    }
    else if (VIDEO_EXT.has(extname(e.name).toLowerCase()) && resolve(dir) !== OUTDIR) out.push(full)
  }
  return out
}
const files = []
for (const s of opt.sources) {
  if (!existsSync(s)) die(`not found: ${s}`)
  // Files beginning "._" are AppleDouble metadata stubs macOS leaves on exFAT
  // cards — same name, same extension, ~256 KB, zero video. Treating them as
  // clips doubles the file count and litters the report with 0s entries.
  if (statSync(s).isDirectory()) walk(s, files)
  else if (!basename(s).startsWith('._')) files.push(s)
}
if (!files.length) die('no .mp4/.mov/.m4v files found')
for (const d of skipped) console.log(`  (skipping ${d} — looks like a previous run's output)`)

// ── read every clip's metadata in ONE exiftool pass ──────────────────────────
// (13 clips as 13 processes is slow enough to notice on a USB drive.)
const ex = spawnSync('exiftool', [
  '-j', '-api', 'QuickTimeUTC=0',
  '-Duration#', '-Keys:CreationDate', '-QuickTime:CreateDate', '-SourceFile', ...files,
], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
if (ex.status !== 0 && !ex.stdout) die(`exiftool failed: ${ex.stderr || ex.status}`)
const meta = new Map()
for (const m of JSON.parse(ex.stdout || '[]')) meta.set(resolve(m.SourceFile), m)

// Wall-clock ms for a "YYYY:MM:DD HH:MM:SS" style stamp, ignoring any zone suffix.
function wallMs(s) {
  if (!s) return null
  const m = String(s).match(/(\d{4})[:\-](\d{2})[:\-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/)
  if (!m) return null
  const [, y, mo, d, h, mi, se] = m.map(Number)
  // A zeroed or 1904 mvhd is "no time", not a time in 1904. Without this the clip
  // is placed at the epoch and quietly matches nothing.
  if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return null
  if (h > 23 || mi > 59 || se > 59) return null
  return Date.UTC(y, mo - 1, d, h, mi, se)
}
// Same conventions the app accepts (SmartSailingAnalytics_UI.extractTimestampFromFilename).
function nameMs(name) {
  const m = name.match(/(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/)
             || name.match(/(\d{4})(\d{2})(\d{2})[_\-T ]?(\d{2})(\d{2})(\d{2})/)
  if (!m) return null
  const [, y, mo, d, h, mi, se] = m.map(Number)
  if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return null
  if (h > 23 || mi > 59 || se > 59) return null
  return Date.UTC(y, mo - 1, d, h, mi, se)
}

const clips = []
for (const f of files) {
  const m = meta.get(resolve(f)) || {}
  const dur = Number(m.Duration) || 0
  let start = null, src = ''
  const keys = wallMs(m.CreationDate)
  const nm = nameMs(basename(f))
  const mvhd = wallMs(m.CreateDate)
  if (keys != null) { start = keys; src = 'metadata' }
  else if (nm != null) { start = nm; src = 'filename' }
  else if (mvhd != null) { start = mvhd; src = 'mvhd?' }
  if (start != null) start += opt.shift * 60000
  clips.push({ file: f, name: basename(f), start, dur, src, covers: [], kinds: [], hits: [], srcDir: basename(dirname(f)) })
}

// ── event windows ────────────────────────────────────────────────────────────
// offset 0 keeps parseXmlEvents in the file's own wall clock, matching the clips.
const ev = parseXmlEvents(readFileSync(opt.events, 'utf8'), 0)
// kind -> [lead, lag] seconds, and the tag SSA itself computes for that moment
// (computeAutoTags in localStore.js). Keeping the same vocabulary means the
// filename and the tag the app derives from the same event file agree.
const KINDS = {
  start:   { lead: () => opt.startLead, lag: () => opt.startLag, tag: 'race-start', name: 'start' },
  topmark: { lead: () => opt.topLead,   lag: () => opt.topLag,   tag: 'topmark',    name: 'top mark' },
  gate:    { lead: () => opt.gateLead,  lag: () => opt.gateLag,  tag: 'gate',       name: 'gate / drop' },
  tack:    { lead: () => opt.turnLead,  lag: () => opt.turnLag,  tag: 'tack',       name: 'tack' },
  gybe:    { lead: () => opt.turnLead,  lag: () => opt.turnLag,  tag: 'gybe',       name: 'gybe' },
}
const windows = []
const addWindow = (utc, kind, label, valid = true) => {
  if (!Number.isFinite(utc)) return
  // isvalid="false" means Expedition rejected the moment for PERFORMANCE stats
  // ("No sails up before", "BSP_trg below 60%"). It still happened, and it is still
  // footage worth having — so keep it by default and just mark it with a "?".
  if (!valid && opt.validOnly) return
  const k = KINDS[kind]
  windows.push({ from: utc - k.lead() * 1000, to: utc + k.lag() * 1000, kind, label: valid ? label : `${label}?` })
}
for (const g of ev.raceGuns) addWindow(g.utc, 'start', `R${g.raceNum || '?'} start`)
for (const r of ev.markRoundings) addWindow(r.utc, r.isTop ? 'topmark' : 'gate', r.isTop ? 'Top mark' : 'Leeward gate', r.isValid !== false)
if (!opt.noTurns) {
  for (const t of ev.tackJibes) addWindow(t.utc, t.isTack ? 'tack' : 'gybe', t.isTack ? 'Tack' : 'Gybe', t.isValid !== false)
}
if (!windows.length) die('the event file has no starts, roundings, tacks or gybes')

for (const c of clips) {
  if (c.start == null) continue
  const end = c.start + c.dur * 1000
  for (const w of windows) if (c.start <= w.to && end >= w.from) {
    c.covers.push(w.label); c.hits.push(w)
    if (!c.kinds.includes(w.kind)) c.kinds.push(w.kind)
  }
}

// The parts of a clip actually worth keeping: each matching window clipped to the
// clip's own span, then merged where they touch. A 652 s drone pass over two mark
// roundings becomes two short segments instead of eleven minutes of transit.
function segmentsFor(c) {
  const end = c.start + c.dur * 1000
  const spans = c.hits
    .map((w) => ({ from: Math.max(c.start, w.from), to: Math.min(end, w.to), label: w.label, kind: w.kind }))
    // >= not >: a clip whose span only TOUCHES a window (it starts exactly as the
    // window closes) still counts as a match above, so dropping the zero-length
    // span here would select the clip and then trim it to nothing. The minimum-
    // segment floor below expands it to something watchable.
    .filter((x) => x.to >= x.from)
    .sort((a, b) => a.from - b.from)
  const merged = []
  for (const sp of spans) {
    const last = merged[merged.length - 1]
    if (last && sp.from - last.to <= opt.gap * 1000) {
      last.to = Math.max(last.to, sp.to)
      if (!last.labels.includes(sp.label)) last.labels.push(sp.label)
      if (!last.kinds.includes(sp.kind)) last.kinds.push(sp.kind)
    } else merged.push({ from: sp.from, to: sp.to, labels: [sp.label], kinds: [sp.kind] })
  }
  // A two-second sliver is not worth a file; give it a floor, inside the clip.
  for (const m of merged) {
    const want = opt.minSeg * 1000
    if (m.to - m.from >= want) continue
    // Centre the floor on the match, then slide (not shrink) it back inside the
    // clip — a segment butting against the clip's start would otherwise keep only
    // the half that fits and come out at half the length asked for.
    let from = m.from - (want - (m.to - m.from)) / 2
    let to = from + want
    if (from < c.start) { from = c.start; to = Math.min(end, from + want) }
    if (to > end) { to = end; from = Math.max(c.start, to - want) }
    m.from = from; m.to = to
  }
  return merged
}

// ── report ───────────────────────────────────────────────────────────────────
const hhmm = (ms) => (ms == null ? '  —  ' : new Date(ms).toISOString().slice(11, 19))
const mb = (f) => (statSync(f).size / 1048576)
const untimed = clips.filter((c) => c.start == null)
const picked = opt.rest
  ? clips.filter((c) => c.covers.length === 0 && c.start != null)
  : clips.filter((c) => c.covers.length > 0)

console.log(`\n● ${basename(opt.events)} — ${ev.meta.boat || '?'} · ${ev.meta.location || '?'} · ${ev.meta.date || '?'}`)
const nOf = (k) => windows.filter((w) => w.kind === k).length
console.log('  ' + Object.keys(KINDS).map((k) => `${nOf(k)} ${KINDS[k].name}${nOf(k) === 1 ? '' : 's'}`).join(' · ') +
  (opt.noTurns ? '   (turns excluded)' : ''))
console.log(`  windows: start −${opt.startLead}/+${opt.startLag}s · top −${opt.topLead}/+${opt.topLag}s` +
  ` · gate ±${opt.gateLead}/${opt.gateLag}s · turn −${opt.turnLead}/+${opt.turnLag}s`)
if (ev.dayStartUtc) console.log(`  sailing ${hhmm(ev.dayStartUtc)} → ${hhmm(ev.dayStopUtc)} (local)`)
console.log()

for (const c of clips) c.segs = (!opt.rest && c.covers.length) ? segmentsFor(c) : []

const W = Math.min(40, Math.max(18, ...clips.map((c) => c.name.length)))
const S = Math.max(6, ...clips.map((c) => c.srcDir.length))
console.log(`  ${'CLIP'.padEnd(W)}  ${'FROM'.padEnd(S)}  ${'START'.padEnd(8)} ${'DUR'.padStart(5)} ${'SIZE'.padStart(7)}  COVERS`)
console.log('─'.repeat(W + S + 60))
for (const c of clips.slice().sort((a, b) => (a.start ?? 0) - (b.start ?? 0))) {
  const chosen = picked.includes(c)
  const covers = c.covers.length ? [...new Set(c.covers)].join(', ') : (c.start == null ? 'no usable timestamp' : '—')
  const size = mb(c.file)
  const keep = opt.trim && c.segs.length
    ? `  ⟶ ${c.segs.length} seg ${Math.round(c.segs.reduce((t, m) => t + (m.to - m.from), 0) / 1000)}s`
    : ''
  console.log(
    `${chosen ? '▶ ' : '  '}${c.name.padEnd(W)}  ${c.srcDir.padEnd(S)}  ${hhmm(c.start).padEnd(8)} ${String(Math.round(c.dur)).padStart(4)}s ` +
    `${(size < 10 ? size.toFixed(1) : size.toFixed(0)).padStart(6)}M  ${covers}${keep}`
  )
}
console.log()
if (untimed.length) console.log(`⚠ ${untimed.length} clip(s) have no usable timestamp and cannot be matched — compress them with compress-videos.sh directly.`)
if (clips.some((c) => c.src === 'mvhd?')) console.log('⚠ some clips fall back to mvhd, which is often the END of the recording. Check those rows, and use --shift if they are consistently off.')

const totalIn = picked.reduce((s, c) => s + mb(c.file), 0)
const secIn = picked.reduce((s, c) => s + c.dur, 0)
const secKeep = picked.reduce((s, c) => s + c.segs.reduce((t, m) => t + (m.to - m.from) / 1000, 0), 0)
console.log(`\n${opt.rest ? 'Leftovers' : 'Selected'}: ${picked.length} of ${clips.length} clips · ${(totalIn / 1024).toFixed(1)} GB · ${Math.round(secIn / 60)} min`)
if (!opt.rest) {
  const segs = picked.reduce((n, c) => n + c.segs.length, 0)
  if (opt.trim) console.log(`Trimmed to ${segs} segment(s) · ${Math.round(secKeep / 60)} min — ${Math.round(100 - (secKeep / secIn) * 100)}% less footage to encode.`)
  else if (secIn > 0) console.log(`With --trim: ${segs} segment(s) · ${Math.round(secKeep / 60)} min (${Math.round(100 - (secKeep / secIn) * 100)}% less to encode).`)
}
if (!picked.length) { console.log('Nothing to do.'); process.exit(0) }
if (opt.dry) { console.log(`\n(dry run — nothing compressed. Drop -n to compress into ${opt.out}/)`); process.exit(0) }

// ── name every output ────────────────────────────────────────────────────────
// Outputs are named <stamp>_<tags>_<source>, where the stamp is that FILE's own
// start. For a segment that is not the parent clip's start, and the stamp is what
// SSA reads to place it (extractTimestampFromFilename) — keeping the parent's name
// would file every segment at the parent's start.
//
// The tags use SSA's OWN vocabulary (computeAutoTags in localStore.js): race-start,
// topmark, gate. The app derives those tags itself from the event file once the log
// and events are uploaded, so matching them here means the filename and the tag SSA
// computes say the same thing instead of inventing a second naming scheme.
const SSA_TAG = (kind) => KINDS[kind]?.tag || slugify(kind)
const slugify = (s) => String(s).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '')
const stamp = (ms) => {
  const d = new Date(ms), q = (n) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}${q(d.getUTCMonth() + 1)}${q(d.getUTCDate())}${q(d.getUTCHours())}${q(d.getUTCMinutes())}${q(d.getUTCSeconds())}`
}
// <stamp>_<tags>_<yourtag>_<source>. The stamp is that FILE's own start — it is
// what SSA reads to place the clip — and the tags are SSA's own vocabulary, so a
// segment says what it is both on disk and once uploaded.
const nameFor = (c, startMs, kinds) => {
  if (opt.keepNames) return basename(c.name, extname(c.name))
  const tags = [...new Set(kinds.map(SSA_TAG))]
  return [stamp(startMs), tags.join('-') || 'other', opt.tag ? slugify(opt.tag) : '', slugify(c.srcDir)]
    .filter(Boolean).join('_')
}

// One job per output file, whether it is a whole clip or a trimmed segment. The
// manifest of these jobs is what the later full-res pass replays.
const jobs = []
for (const c of picked) {
  if (opt.trim && c.segs.length) {
    for (const m of c.segs) {
      jobs.push({
        name: nameFor(c, m.from, m.kinds), src: c.file, srcDir: c.srcDir,
        ssSec: Number(((m.from - c.start) / 1000).toFixed(2)),
        durSec: Number(((m.to - m.from) / 1000).toFixed(2)),
        tags: [...new Set(m.kinds.map(SSA_TAG))], labels: m.labels, kinds: m.kinds,
        startWall: new Date(m.from).toISOString().replace('Z', ''),
      })
    }
  } else {
    jobs.push({
      name: nameFor(c, c.start, c.kinds), src: c.file, srcDir: c.srcDir,
      ssSec: 0, durSec: 0,
      tags: [...new Set(c.kinds.map(SSA_TAG))], labels: c.covers, kinds: c.kinds,
      startWall: c.start == null ? null : new Date(c.start).toISOString().replace('Z', ''),
    })
  }
}

// ── compress, via the one script that owns the encoder settings ──────────────
mkdirSync(opt.out, { recursive: true })
const enc = join(HERE, 'compress-videos.sh')
const arch = opt.archive ? ['--archive'] : []

// Written BEFORE encoding, so an interrupted run still leaves a replayable record.
const manifest = join(opt.out, 'manifest.json')
writeFileSync(manifest, JSON.stringify({
  generated: new Date().toISOString(),
  events: resolve(opt.events),
  mode: opt.rest ? 'rest' : 'selected',
  trimmed: !!opt.trim,
  tag: opt.tag || null,
  windows: { startLead: opt.startLead, startLag: opt.startLag, markLead: opt.markLead, markLag: opt.markLag, gap: opt.gap, minSeg: opt.minSeg },
  items: jobs,
}, null, 2))

console.log(`\n● Compressing ${jobs.length} file(s) from ${picked.length} clip(s) → ${opt.out}/\n`)
let i = 0, bad = 0
for (const j of jobs) {
  i++
  const args = [...arch, '--out', opt.out, '--name', j.name]
  if (j.ssSec > 0) args.push('--ss', String(j.ssSec))
  if (j.durSec > 0) args.push('--t', String(j.durSec))
  args.push(j.src)
  process.stdout.write(`[${i}/${jobs.length}] `)
  const r = spawnSync(enc, args, { stdio: 'inherit' })
  if (r.status !== 0) bad++
}
console.log(`\n✓ ${jobs.length - bad}/${jobs.length} → ${opt.out}`)
console.log(`  manifest: ${manifest}`)
console.log('\nNext:')
console.log('  • upload these from SSA → Videos (each carries its own start time in the filename)')
if (!opt.rest) console.log(`  • before the debrief:  --full-res "${manifest}" -o <folder>   (full resolution, no re-encode)`)
process.exit(bad ? 1 : 0)
