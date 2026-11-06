// scripts/ryujin-orr-transcribe.ts
// ─────────────────────────────────────────────────────────────────────────────
// Ryujin's 2026 ORR certificate, transcribed — because the PDF cannot be read.
//
//   npx vite-node scripts/ryujin-orr-transcribe.ts            # print it
//   npx vite-node scripts/ryujin-orr-transcribe.ts --out DIR  # write the JSON
//
// WHY A TRANSCRIPTION AND NOT A PARSE. `RYUJIN Base (J0) ORR cert.pdf` has every
// glyph drawn as vector outlines — 0 text-show operators against 47,884 path
// operators, and no font objects at all — so extractPdfText returns 15
// characters and `orr-rigmodel.ts` has nothing to work on. The numbers below
// were read off the pages rendered at 2600 px. Replace this whole file with a
// run of `orr-rigmodel.ts` the moment a certificate with real text arrives.
//
// IT GOES THROUGH THE SAME PARSER the real thing will. The transcription is a
// certificate-shaped STRING, not a hand-built model, so `parseOrrCertificate`
// and `rigModelFromOrr` do the mapping here exactly as they would from a PDF.
// Hand-assembling a RigModel would have been fewer lines and would have tested
// nothing — and would have let a typo in a width become a measurement nobody
// could trace. Transcribed in the script, so a correction is a diff.
//
// WHAT TO CHECK IF A NUMBER LOOKS WRONG: the rendered pages are reproducible
// from the PDF, and the certificate's own arithmetic is the cross-check — the
// sail areas come with it (main 91.7 m², jib 108.1, asym 277.6), and a width
// typed wrong will not reproduce its area.
// ─────────────────────────────────────────────────────────────────────────────

import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { parseOrrCertificate, rigModelFromOrr } from '../src/lib/orrCertificate'
import { jibGeometry } from '../src/lib/ircCertificate'
import { exportRigModel } from '../src/lib/rigModel'

/** Page 1 of RYUJIN USA51007, 2026 ORR, certificate US42284, as laid out. */
export const RYUJIN_ORR = `
2026 Offshore Racing Rule Certificate Data
RYUJIN   USA51007
ORR Type: Offshore
Valid Year: 2026
Owner(s): Slyngstad, Greg
Class: Ker 52
Builder: KNIERIM
Measurement: Full Measured
Rig Type: Masthead Sloop
Prop Type: 2 Blade Folding Strut Drive
Keel Type: Fixed
Hull Const: Carbon Nomex
Mast Const: Carbon
Offset File: FastExit2025.OFF
Certification #: US42284
Issue Date: 12-Aug-2026
Build Date: 01-May-2012
Measure Date: 05-Feb-2022
Float Date: 16-Feb-2023
LOA: 16.006 m
Beam Max: 4.754 m
Total Inventory: 253.5 kg
Life Raft Wt: 40.0 kg
Emer. Steer Wt: 13.0 kg
General Purpose Handicap(GPH): 436.3 SpM
Critical Configuration Items
Rated Crew Wgt.: 1079 kg
Base Crew Wgt.: 1079 kg
LPS(limit of posittive stability): 137.8
Stab Index: 132.2
Measurement Trim
SFFP: 0.293 m
SAFP: 16.006 m
FFM: 0.421 m
FAM: 1.104 m
SG: 1.025
Disp Empty: 7087 kg
LCB: 8.437 m
VCGD: -0.972 m
VCGM: -0.977 m
Wetted Area: 40.7
Draft: 3.695 m
ECE: 0.000 m
LSM0: 14.892 m
RMC: 367.0
Sink/Float: 317.4
MTCT: 229.82
Sailing Trim
FF: 0.387 m
FA: 1.033 m
Disp Sailing: 8884 kg
LCB: 8.673 m
VCGM: -0.573 m
Wetted Area: 45.0
Draft: 3.748 m
Rated Length: 15.714 m
LSM1: 15.822 m
LSM3: 15.974 m
LSM4: 17.041 m
RM2: 402.6
RM20: 366.1
RM40: 310.9
RM60: 233.1
RM90: 133.6
Rig
I: 19.627 m
J: 5.700 m
SFJ: 0.634 m
P: 21.388 m
E: 6.528 m
BAS: 1.907 m
MW: 0.152 m
GO: 0.152 m
FSP: 0.000 m
MDL1: 0.295 m
MDT1: 0.135 m
MDL2: 0.152 m
MDT2: 0.098 m
TL: 3.800 m
Mast Wt: 330.0 kg
Mast CG: 7.600 m
Sail Tack & Head
IG: 23.442 m
ISPA: 0.000 m
JG: 8.822 m
TPS: 9.255 m
Propeller
Prop Dia.: 0.448 m
EDL: 1.074 m
PSA: 0.0
PSD: 0.000 m
ST1: 0.066 m
ST2: 0.179 m
ST3: 0.184 m
ST4: 0.111 m
ST5: 0.286 m
PIPA: 0.0058
Mainsail
MHB: 1.440 m
MUW: 2.180 m
MTW: 2.990 m
MHW: 4.370 m
MQW: 5.510 m
Area: 91.7
Rated Area: 91.7
Main Wt: 49.8 kg
Genoa/Jib
HLP: 8.520 m
HLU: 24.420 m
HHB: 0.090 m
HUW: 1.150 m
HTW: 2.270 m
HHW: 4.540 m
HQW: 6.620 m
HLE: 22.150 m
Area: 108.1
Rated Area: 108.1
Asym
SLU: 26.260 m
SLE: 22.440 m
SHW: 13.780 m
SFL: 13.290 m
Area: 277.6
Rated Area: 277.6
`

const argv = process.argv.slice(2)
const outDir = argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : null

const cert = parseOrrCertificate(RYUJIN_ORR)
if (!cert) { console.error('the transcription no longer parses — check splitSections'); process.exit(1) }
const model = rigModelFromOrr(cert)
const g = jibGeometry({ j: cert.rig.j, hlu: cert.jib.luff, hlp: cert.jib.foot, p: cert.rig.p })

const f = (v: number | null | undefined, d = 3) => (v == null ? '—' : v.toFixed(d))
console.log(`${cert.name} ${cert.sailNumber} · ${cert.className} · ORR ${cert.certNo} · ${cert.measurement}`)
console.log(`  P ${f(cert.rig.p)}   E ${f(cert.rig.e)}   J ${f(cert.rig.j)}   I ${f(cert.rig.i)}   GPH ${cert.gph}`)
console.log(`  main widths  foot ${f(cert.main.foot)}  1/4 ${f(cert.main.qw)}  1/2 ${f(cert.main.hw)}`
  + `  3/4 ${f(cert.main.tw)}  7/8 ${f(cert.main.uw)}`)
console.log(`  jib  widths  foot ${f(cert.jib.foot)}  1/4 ${f(cert.jib.qw)}  1/2 ${f(cert.jib.hw)}`
  + `  3/4 ${f(cert.jib.tw)}  7/8 ${f(cert.jib.uw)}`)
console.log(`  forestay ${g ? g.forestayAngleDeg.toFixed(1) : '—'}° from vertical`
  + `  ·  boom depth ${(model.depths.boom.mm / 1000).toFixed(3)} m`
  + `  ·  clew ${g ? (g.clewDepthMm / 1000).toFixed(2) : '—'} m`)
// ── the certificate checks the transcription ────────────────────────────────
//
// The girths and the AREA are published independently, so integrating the one
// has to reproduce the other. It is the only check available on a transcription
// — and it is a sharp one, because a single width typed wrong moves the area by
// more than the method's own error.
//
// It also settles HOW the widths are measured, which the rules state and this
// confirms from the numbers: perpendicular to the LUFF, at stations along the
// luff. Integrating the jib that way — along HLU, not vertically — reproduces
// 108.1 m² to 0.07 %. The main comes out 1.8 % LOW for a reason that is not an
// error: a trapezoid between the 7/8 station and the head cuts the corner off a
// convex roach, and a mainsail's roach is its largest above 7/8.
const trapArea = (len: number, ws: (number | null)[], fr: number[]): number | null => {
  if (ws.some((w) => w == null)) return null
  let a = 0
  for (let i = 0; i < ws.length - 1; i++) a += ((ws[i]! + ws[i + 1]!) / 2) * (fr[i + 1] - fr[i]) * len
  return a
}
const FR = [0, 0.25, 0.5, 0.75, 0.875, 1]
const mainArea = trapArea(cert.rig.p ?? 0, [cert.main.foot, cert.main.qw, cert.main.hw, cert.main.tw, cert.main.uw, cert.main.hb], FR)
const jibArea = trapArea(cert.jib.luff ?? 0, [cert.jib.foot, cert.jib.qw, cert.jib.hw, cert.jib.tw, cert.jib.uw, cert.jib.hb], FR)
const pct = (got: number | null, want: number | null) =>
  got == null || !want ? '—' : `${((got / want - 1) * 100).toFixed(2)} %`
console.log(`  area check   main ${mainArea?.toFixed(1)} vs ${cert.main.areaM2} m² (${pct(mainArea, cert.main.areaM2)}`
  + `, low by the roach above 7/8)   jib ${jibArea?.toFixed(1)} vs ${cert.jib.areaM2} m² (${pct(jibArea, cert.jib.areaM2)})`)

// The quarter widths are the reason an ORR boat measures better than an IRC one:
// the 25 % stripe is the station widthAt otherwise interpolates, and on a main
// that interpolation is its worst.
console.log(`  MQW/HQW present, so the 25 % stripe is MEASURED rather than interpolated`)

// A model whose jib has no luff rake is one the twist maths will silently not
// correct — and the file outlives the session that wrote it. This exact thing
// happened: the JSON was generated before rigModelFromOrr learned to set the
// rake, seeded faithfully, and Ryujin went in at 0°. Refuse rather than write a
// model that looks complete.
if (model.widths?.jib?.luffRakeDeg == null) {
  console.error('\nREFUSING to write: the jib carries no luffRakeDeg.')
  console.error('Both rules girth perpendicular to the luff; without the rake the')
  console.error('twist maths uses a width 4-5 % too small and says nothing.')
  process.exit(1)
}

if (outDir) {
  mkdirSync(outDir, { recursive: true })
  const p = join(outDir, 'ryujin.rigmodel.json')
  writeFileSync(p, exportRigModel(model))
  console.log(`\nwrote ${p}`)
  console.log('seed it with:')
  console.log(`  npx vite-node scripts/rig-model-seed.ts --boat "${cert.name}" --from "${p}" --merge --write`)
}
