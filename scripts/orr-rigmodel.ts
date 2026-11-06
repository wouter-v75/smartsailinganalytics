// scripts/orr-rigmodel.ts
// ─────────────────────────────────────────────────────────────────────────────
// A rig model from an ORR certificate — the American rule, beside
// `irc-rigmodel.ts`.
//
//   npx vite-node scripts/orr-rigmodel.ts -- ~/Downloads/cert.pdf --out ~/rigmodels
//   …then rig-model-seed.ts --boat "Ryujin" --from ~/rigmodels/ryujin.rigmodel.json --create --team <team> --write
//
// Runs OUTSIDE the Bash sandbox: it reads PDFs through pdf-parse.
//
// IT NEEDS A CERTIFICATE WITH TEXT IN IT, which is not a given. Ryujin's
// `RYUJIN Base (J0) ORR cert.pdf` has every glyph drawn as vector outlines —
// 0 text-show operators against 47,884 path operators, and no font objects at
// all — so `extractPdfText` returns 15 characters and there is nothing to
// parse. That is how that particular file was exported, not how ORR issues
// certificates; the copy downloaded from the ORA carries real text. The script
// says so rather than reporting "not an ORR certificate", because the two
// failures want completely different things done about them.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, readdirSync, writeFileSync, statSync, mkdirSync } from 'fs'
import { join, extname, basename } from 'path'
import { extractPdfText } from '../src/lib/pdfText'
import { parseOrrCertificate, rigModelFromOrr } from '../src/lib/orrCertificate'
import { jibGeometry } from '../src/lib/ircCertificate'
import { exportRigModel } from '../src/lib/rigModel'

const argv = process.argv.slice(2)
const flag = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null }
const outDir = flag('--out')
const inputs = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--out')

const files: string[] = []
for (const p of inputs) {
  const st = statSync(p)
  if (st.isDirectory()) {
    for (const e of readdirSync(p).sort()) if (extname(e).toLowerCase() === '.pdf') files.push(join(p, e))
  } else if (extname(p).toLowerCase() === '.pdf') files.push(p)
}
if (!files.length) { console.error('pass ORR certificate PDFs, or a folder of them'); process.exit(1) }

const rows: string[][] = []
const head = ['boat', 'sail no', 'class', 'P', 'E', 'J', 'HLU', 'HLP', 'MQW', 'HQW', 'fstay°', 'clew', 'boom']

async function main() {
  for (const f of files) {
    const text = await extractPdfText(readFileSync(f))
    const cert = parseOrrCertificate(text)
    if (!cert) {
      // Name WHICH failure it is. A flattened certificate is a different
      // problem from the wrong document, and conflating them sends the next
      // person looking for a parser bug that is not there.
      if (text.trim().length < 200) {
        console.error(`${basename(f)}: no text in this PDF (${text.trim().length} characters).`)
        console.error('  Its text was flattened to vector outlines, so no parser can read it.')
        console.error('  Download the certificate again from the ORA — that copy carries real text.')
      } else {
        console.error(`not an ORR certificate: ${basename(f)}`)
      }
      continue
    }
    const g = jibGeometry({ j: cert.rig.j, hlu: cert.jib.luff, hlp: cert.jib.foot, p: cert.rig.p })
    const model = rigModelFromOrr(cert)
    const f2 = (v: number | null) => (v == null ? '—' : v.toFixed(2))
    rows.push([
      cert.name || basename(f), cert.sailNumber, cert.className,
      f2(cert.rig.p), f2(cert.rig.e), f2(cert.rig.j),
      f2(cert.jib.luff), f2(cert.jib.foot),
      f2(cert.main.qw), f2(cert.jib.qw),
      g ? g.forestayAngleDeg.toFixed(1) : '—',
      g ? `${(g.clewDepthMm / 1000).toFixed(2)}±${(g.clewDepthSigmaMm / 1000).toFixed(2)}` : '—',
      cert.rig.e ? (-cert.rig.e).toFixed(2) : '—',
    ])
    if (cert.convertedFromFeet) console.error(`${basename(f)}: issued in FEET, converted`)
    if (outDir) {
      mkdirSync(outDir, { recursive: true })
      const name = `${(cert.name || basename(f)).replace(/\W+/g, '-').toLowerCase()}.rigmodel.json`
      writeFileSync(join(outDir, name), exportRigModel(model))
      console.error(`wrote ${join(outDir, name)}`)
    }
  }
  if (!rows.length) return
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] || '').length)))
  const line = (r: string[]) => r.map((c, i) => (i === 0 ? c.padEnd(w[i]) : c.padStart(w[i]))).join('  ')
  console.log(line(head))
  for (const r of rows) console.log(line(r))
  // MQW and HQW are the reason an ORR boat measures better than an IRC one
  // here: the 25 % stripe is the station widthAt otherwise interpolates.
  console.log('\nMQW/HQW are the quarter-hoist widths — ORR measures them, IRC does not.')
}
main()
