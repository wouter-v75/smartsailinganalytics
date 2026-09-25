// scripts/irc-rigmodel.ts
// ─────────────────────────────────────────────────────────────────────────────
// Turn IRC certificates into SailTrim rig models, and compare a fleet.
//
//   npx vite-node scripts/irc-rigmodel.ts -- "<folder or PDFs>" [--out <dir>] [--spreader 20]
//
// An endorsed IRC certificate carries everything SailTrim cannot get from the
// photograph: P (the scale, because the mast lies in the image plane seen from
// astern), J (the ψ baseline, and where the jib's corners are), E (the boom).
// It is issued for competitors too, so this is also how a rival boat becomes
// measurable — the thing stage 4 of the plan had no answer for.
//
// `--out` writes one <boat>.rigmodel.json per certificate, which SailTrim
// imports directly (Rig model → edit → Import…).
//
// Runs OUTSIDE the Bash sandbox: it reads PDFs through pdf-parse.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, readdirSync, writeFileSync, statSync, mkdirSync } from 'fs'
import { join, extname, basename } from 'path'
import { extractPdfText } from '../src/lib/pdfText'
import { parseIrcCertificate, rigModelFromIrc, jibGeometry } from '../src/lib/ircCertificate'
import { exportRigModel } from '../src/lib/rigModel'

const argv = process.argv.slice(2)
const flag = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null }
const outDir = flag('--out')
const spreaderHeightM = Number(flag('--spreader') || 20)
const inputs = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--out' && argv[i - 1] !== '--spreader')

const files: string[] = []
for (const p of inputs) {
  const st = statSync(p)
  if (st.isDirectory()) {
    for (const e of readdirSync(p).sort()) if (extname(e).toLowerCase() === '.pdf') files.push(join(p, e))
  } else if (extname(p).toLowerCase() === '.pdf') files.push(p)
}
if (!files.length) { console.error('pass IRC certificate PDFs, or a folder of them'); process.exit(1) }

const rows: string[][] = []
const head = ['boat', 'sail no', 'LH', 'wt kg', 'P', 'E', 'J', 'HLU', 'HLP', 'rake°', 'clew', 'leech', 'boom']

async function main() {
for (const f of files) {
  const cert = parseIrcCertificate(await extractPdfText(readFileSync(f)))
  if (!cert) { console.error(`not an IRC certificate: ${basename(f)}`); continue }
  const g = jibGeometry(cert.rig, { spreaderHeightM })
  const model = rigModelFromIrc(cert, { spreaderHeightM })
  rows.push([
    cert.name, cert.sailNumber,
    cert.hull.lh?.toFixed(2) ?? '—',
    cert.hull.weightKg?.toString() ?? '—',
    cert.rig.p?.toFixed(2) ?? '—',
    cert.rig.e?.toFixed(2) ?? '—',
    cert.rig.j?.toFixed(2) ?? '—',
    cert.rig.hlu?.toFixed(2) ?? '—',
    cert.rig.hlp?.toFixed(2) ?? '—',
    g ? g.forestayRakeDeg.toFixed(1) : '—',
    g ? `${(g.clewDepthMm / 1000).toFixed(2)}±${(g.clewDepthSigmaMm / 1000).toFixed(2)}` : '—',
    g ? `${(g.leechDepthMm / 1000).toFixed(2)}` : '—',
    cert.rig.e ? (-cert.rig.e).toFixed(2) : '—',
  ])
  if (outDir) {
    mkdirSync(outDir, { recursive: true })
    const name = `${(cert.name || basename(f)).replace(/\W+/g, '-').toLowerCase()}.rigmodel.json`
    writeFileSync(join(outDir, name), exportRigModel(model))
    console.error(`wrote ${join(outDir, name)}`)
  }
}

}

function report() {
const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] || '').length)))
const fmt = (r: string[]) => r.map((c, i) => (i <= 1 ? c.padEnd(w[i]) : c.padStart(w[i]))).join('  ')
console.log()
console.log(fmt(head))
console.log(w.map((n) => '─'.repeat(n)).join('  '))
for (const r of rows) console.log(fmt(r))
console.log(`
metres, forward of the mast positive. clew/leech/boom are the fore-and-aft
offsets SailTrim needs; clew and leech are DERIVED from J/HLU/HLP with the clew
at ${(0.15 * 100).toFixed(0)}% of the luff (±6%), spreader 2 at ${spreaderHeightM} m.`)
}

main().then(report).catch((e) => { console.error(e); process.exit(1) })
