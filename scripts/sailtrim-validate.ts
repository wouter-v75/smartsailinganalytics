// scripts/sailtrim-validate.ts
// ─────────────────────────────────────────────────────────────────────────────
// Run SailTrim's two detectors over real photographs and check them against the
// boat's own instruments.
//
//   npx vite-node scripts/sailtrim-validate.ts -- <files or a folder> [--heel 23.5,23.2,…] [--width 1600]
//
// For each frame it finds the sea horizon and traces the mast, then reports the
// angle between them — which IS the heel. Give it the logged heel per frame and
// it prints the disagreement, which is the only end-to-end check there is on
// the whole projection model: no rig dimensions, no clicks, nothing to tune.
//
// On the six 5 Sept frames (12:37:46 → 12:46:37) this agrees with the logged
// heel to between 0.1° and 1.6°, and the answers move by less than 0.2° between
// decoding at 900 px and 1600 px wide. A frame that disagrees by more than a
// couple of degrees is telling you something: a rotated compilation panel, the
// wrong log second, or a trace that wandered off the mast onto a shroud.
//
// Runs OUTSIDE the Bash sandbox (it shells out to ffmpeg/ffprobe).
// ─────────────────────────────────────────────────────────────────────────────

import { execFileSync } from 'child_process'
import { readdirSync, statSync } from 'fs'
import { join, extname, basename } from 'path'
import { detectHorizon, traceMastFromSeed, type Pixels } from '../src/lib/sailTrimCv'
import { imageHeelDeg } from '../src/lib/sailTrim'

const argv = process.argv.slice(2)
const flag = (name: string): string | null => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null
}
const width = Number(flag('--width') || 1600)
const heels = (flag('--heel') || '').split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n))
const inputs = argv.filter((a) => !a.startsWith('--') && !heels.includes(Number(a)) && a !== String(width) && a !== flag('--heel'))

const IMG = /\.(jpe?g|png|tiff?|webp)$/i
const files: string[] = []
for (const p of inputs) {
  const st = statSync(p)
  if (st.isDirectory()) {
    for (const e of readdirSync(p).sort()) if (IMG.test(extname(e))) files.push(join(p, e))
  } else if (IMG.test(extname(p))) files.push(p)
}
if (!files.length) {
  console.error('nothing to do — pass image files or a folder of them')
  process.exit(1)
}

function load(path: string, targetW: number): Pixels {
  const dim = execFileSync('ffprobe',
    ['-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', path],
    { encoding: 'utf8' }).trim().split(',')
  const W0 = +dim[0], H0 = +dim[1]
  const W = Math.min(targetW, W0), H = Math.round((H0 * W) / W0)
  const raw = execFileSync('ffmpeg',
    ['-v', 'error', '-i', path, '-vf', `scale=${W}:${H}`, '-pix_fmt', 'rgba', '-f', 'rawvideo', '-'],
    { maxBuffer: 1 << 30 })
  return { width: W, height: H, data: new Uint8ClampedArray(raw.buffer, raw.byteOffset, raw.length) }
}

/**
 * Without an operator to click on the mast, take the LONGEST near-vertical edge
 * in the frame — which on an astern shot is the mast, every time on the 5 Sept
 * set. Shrouds and sail edges are all shorter.
 */
function bestMast(p: Pixels) {
  let best: ReturnType<typeof traceMastFromSeed> = null
  for (const fy of [0.3, 0.45, 0.6]) {
    const y = Math.round(p.height * fy)
    for (let x = Math.round(p.width * 0.12); x < Math.round(p.width * 0.9); x += Math.max(1, Math.round(p.width / 90))) {
      const t = traceMastFromSeed(p, { x, y })
      if (t && (!best || t.spanPx > best.spanPx * 1.02)) best = t
    }
  }
  return best
}

console.log(`decoded at ${width} px wide\n`)
console.log('frame'.padEnd(26), 'horizon (rms, cols)'.padEnd(24), 'mast'.padEnd(20), 'heel: photo', heels.length ? ' vs log' : '')
let worst = 0, compared = 0
files.forEach((file, i) => {
  const p = load(file, width)
  const h = detectHorizon(p)
  const m = bestMast(p)
  const ih = m && h ? imageHeelDeg(m.axis, h) : null
  const logged = heels[i]
  if (ih != null && Number.isFinite(logged)) { worst = Math.max(worst, Math.abs(Math.abs(ih) - logged)); compared++ }
  console.log(
    basename(file).slice(0, 25).padEnd(26),
    (h ? `${h.tiltDeg.toFixed(2)}° (${h.rms.toFixed(1)}px, ${h.samples})` : 'not found').padEnd(24),
    (m ? `${m.axis.tiltDeg.toFixed(2)}° span ${((100 * m.spanPx) / p.height).toFixed(0)}%` : 'not found').padEnd(20),
    ih != null ? `${Math.abs(ih).toFixed(2)}°`.padStart(9) : '        —',
    Number.isFinite(logged) && ih != null ? `  ${logged.toFixed(1)}°  Δ ${(Math.abs(ih) - logged).toFixed(2)}°` : '',
  )
})
if (compared) console.log(`\nworst disagreement with the log: ${worst.toFixed(2)}° over ${compared} frames`)
