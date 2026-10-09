// scripts/sailtrim-tilt-calibration.ts
// ─────────────────────────────────────────────────────────────────────────────
// Does the mast's apparent tilt tell you how far off the centreline the camera
// was? If it does, a folder of photographs can be sorted into useful and
// useless without anybody marking anything.
//
//   npx vite-node scripts/sailtrim-tilt-calibration.ts
//   npx vite-node scripts/sailtrim-tilt-calibration.ts --out ~/Downloads/tilt.tsv
//
// READ-ONLY. Reads .env.local; run OUTSIDE Claude Code's Bash sandbox.
//
// THE CLAIM UNDER TEST. Viewed from dead astern the mast's rake lies along the
// camera axis and is invisible, so the tilt you measure against the horizon is
// the heel and nothing else. Move off the centreline and the rake projects into
// the image and ADDS to it. If that is right, the residual
//
//     imageHeelDeg − loggedHeelDeg
//
// should grow with |ψ| — and ψ is already solved on every measured frame, from
// marks and a certificate, with nothing to do with any of this. So the frames
// already in the database are a calibration set that cost nothing to collect.
//
// It is worth being clear about what would FALSIFY it: a residual that does not
// grow with |ψ|, or grows so slowly that it cannot separate 5° from 40°. Toni
// Otero's 930 "stern shots" read a median tilt of 39.3°, 31.9°, 21.8° and 36.7°
// across four days against a real heel range of 6–26°, and the whole argument
// for filtering them this way rests on this residual being real.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, writeFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'

const args = process.argv.slice(2)
const flag = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : null)
const OUT = flag('--out') || `${process.env.HOME}/Downloads/sailtrim-tilt-calibration.tsv`

const env = Object.fromEntries(
  readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    .split('\n').filter((l) => /^[A-Z0-9_]+=/.test(l))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')] }),
)
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })

/** Our own boat, whose instruments the logged heel belongs to. */
const OUR_BOAT = (flag('--our-boat') || 'Northstar 76').toLowerCase()

interface Cal {
  psiDeg?: number; psiSigmaDeg?: number; psiMeasured?: boolean
  heelDeg?: number | null; imageHeelDeg?: number | null
  mastTiltDeg?: number; cameraRollDeg?: number | null
  horizonTiltDeg?: number | null; horizonRmsPx?: number | null
  horizontalFrom?: string
}

const f2 = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? '' : v.toFixed(2))

async function main() {
  const { data: photos, error } = await sb
    .from('photos').select('id, taken_utc, analysis_data')
  if (error) { console.error(`photos: ${error.message}`); process.exit(1) }

  const cols = [
    'file', 'taken_utc', 'boat', 'ourBoat', 'psiDeg', 'psiSigmaDeg', 'psiMeasured',
    'typedHeelDeg', 'instHeelDeg', 'loggedHeelDeg', 'imageHeelDeg', 'residualDeg',
    'mastTiltDeg', 'cameraRollDeg', 'horizonTiltDeg', 'horizonRmsPx', 'horizontalFrom',
  ]
  const rows: string[][] = []

  for (const p of photos ?? []) {
    const a = p.analysis_data as {
      inst?: { heel?: number | null }
      sailTrim?: { annotation?: { scale?: { boat?: string } }; result?: { photo?: string; boat?: string; calibration?: Cal } }
    } | null
    const st = a?.sailTrim
    const cal = st?.result?.calibration
    if (!cal) continue
    // The heel the OPERATOR typed is empty on every measured frame — they let
    // the sea horizon be the vertical instead, which is what horizontalFrom
    // says. The logged heel is on the photo itself, put there by the import
    // enrichment, and that is the one this test needs.
    const logged = cal.heelDeg ?? a?.inst?.heel ?? null
    const img = cal.imageHeelDeg ?? null
    // The residual the claim is about. Magnitudes: the sign of the image heel
    // says which way the masthead leans, which is the tack, not the viewpoint.
    const residual = logged != null && img != null ? Math.abs(img) - Math.abs(logged) : null
    const boat = st?.annotation?.scale?.boat ?? st?.result?.boat ?? ''
    // inst.heel is OUR boat's. On a frame measured as somebody else it is a
    // different boat's number and the residual would be meaningless — the three
    // Capricorno frames would otherwise regress her rig against our instruments.
    const ours = !!boat && boat.toLowerCase() === OUR_BOAT
    rows.push([
      st?.result?.photo ?? '', String(p.taken_utc ?? ''), boat, ours ? 'yes' : 'no',
      f2(cal.psiDeg), f2(cal.psiSigmaDeg), cal.psiMeasured ? 'yes' : 'no',
      f2(cal.heelDeg), f2(a?.inst?.heel), f2(logged), f2(img), f2(residual),
      f2(cal.mastTiltDeg), f2(cal.cameraRollDeg), f2(cal.horizonTiltDeg),
      f2(cal.horizonRmsPx), cal.horizontalFrom ?? '',
    ])
  }

  rows.sort((a, b) => a[1].localeCompare(b[1]))
  writeFileSync(OUT, [cols.join('\t'), ...rows.map((r) => r.join('\t'))].join('\n') + '\n')
  console.log(`${rows.length} measured frame(s) → ${OUT}\n`)

  // A first look, so a run that produced nothing useful says so here rather
  // than looking like data.
  const usable = rows.filter((r) => r[4] && r[11] && r[6] === 'yes' && r[3] === 'yes')
  const notOurs = rows.filter((r) => r[3] !== 'yes').length
  if (notOurs) console.log(`${notOurs} excluded: measured as another boat, whose heel our log does not know`)
  console.log(`${usable.length} with BOTH a measured psi and a heel residual`)
  if (usable.length < 3) {
    console.log('Too few to say anything. psi has to have been MEASURED (a marked')
    console.log('centreplane baseline), and the frame needs a logged heel beside the')
    console.log('one read off the picture.')
    return
  }
  console.log('\n  psi      logged   image    residual')
  for (const r of usable.sort((a, b) => Math.abs(+a[4]) - Math.abs(+b[4]))) {
    console.log(`  ${(+r[4]).toFixed(2).padStart(7)}  ${r[9].padStart(7)}  ${r[10].padStart(7)}  ${(+r[11]).toFixed(2).padStart(8)}`)
  }
  const xs = usable.map((r) => Math.abs(+r[4])), ys = usable.map((r) => +r[11])
  const n = xs.length
  const mx = xs.reduce((s, v) => s + v, 0) / n, my = ys.reduce((s, v) => s + v, 0) / n
  const sxy = xs.reduce((s, v, i) => s + (v - mx) * (ys[i] - my), 0)
  const sxx = xs.reduce((s, v) => s + (v - mx) ** 2, 0)
  const syy = ys.reduce((s, v) => s + (v - my) ** 2, 0)
  if (sxx > 0 && syy > 0) {
    const slope = sxy / sxx
    const r = sxy / Math.sqrt(sxx * syy)
    console.log(`\n  residual ≈ ${slope.toFixed(3)} × |psi| ${my - slope * mx >= 0 ? '+' : '−'} ${Math.abs(my - slope * mx).toFixed(2)}°   (r = ${r.toFixed(3)}, n = ${n})`)
    console.log(`  over the 6–40° of tilt seen on the stick that is ${(Math.abs(slope) * 35).toFixed(1)}° of separation.`)
  }
}
main()
