// src/lib/__tests__/orrCertificate.test.ts
// ─────────────────────────────────────────────────────────────────────────────
// The fixture is RYUJIN's own certificate — USA51007, a Ker 52, 2026 ORR —
// transcribed from the rendered pages, because the PDF itself cannot be read by
// anything: every glyph on it is drawn as vector outlines (0 text-show
// operators against 47,884 path operators, no font objects at all), so
// `extractPdfText` returns 15 characters. That is how that file was exported,
// not how ORR issues certificates.
//
// So these tests pin the FIELD NAMES and the SECTION SCOPING, which were read
// off the page and are right. What they cannot pin is the order a real text ORR
// PDF extracts in — see `splitSections`. The layout below is the page's own
// reading order, column by column.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest'
import { parseOrrCertificate, rigModelFromOrr, splitSections } from '../orrCertificate'

const RYUJIN = `
2026 Offshore Racing Rule Certificate Data
RYUJIN   USA51007
ORR Type: Offshore
Valid Year: 2026
Owner(s): Slyngstad, Greg
Class: Ker 52
Builder: KNIERIM
Measurement: Full Measured
Rig Type: Masthead Sloop
Certification #: US42284
Issue Date: 12-Aug-2026
LOA: 16.006 m
Beam Max: 4.754 m
General Purpose Handicap(GPH): 436.3 SpM
Critical Configuration Items
Rated Crew Wgt.: 1079 kg
LPS(limit of posittive stability): 137.8
Measurement Trim
SFFP: 0.293 m
SAFP: 16.006 m
LCB: 8.437 m
VCGM: -0.977 m
Wetted Area: 40.7
Draft: 3.695 m
Sailing Trim
FF: 0.387 m
LCB: 8.673 m
VCGM: -0.573 m
Wetted Area: 45.0
Draft: 3.748 m
Rated Length: 15.714 m
Rig
I: 19.627 m
J: 5.700 m
SFJ: 0.634 m
P: 21.388 m
E: 6.528 m
BAS: 1.907 m
MW: 0.152 m
TL: 3.800 m
Mast Wt: 330.0 kg
Sail Tack & Head
IG: 23.442 m
ISPA: 0.000 m
JG: 8.822 m
TPS: 9.255 m
Propeller
Prop Dia.: 0.448 m
Mainsail
MHB: 1.440 m
MUW: 2.180 m
MTW: 2.990 m
MHW: 4.370 m
MQW: 5.510 m
Area: 91.7
Rated Area: 91.7
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

describe('parseOrrCertificate', () => {
  it('reads the boat, the rig and both sails', () => {
    const c = parseOrrCertificate(RYUJIN)!
    expect(c).toBeTruthy()
    expect(c.sailNumber).toBe('USA51007')
    expect(c.certNo).toBe('US42284')
    expect(c.className).toBe('Ker 52')
    expect(c.measurement).toBe('Full Measured')
    expect(c.rig.p).toBe(21.388)
    expect(c.rig.e).toBe(6.528)
    expect(c.rig.j).toBe(5.700)
    expect(c.rig.i).toBe(19.627)
    expect(c.gph).toBe(436.3)
  })

  it('keeps the three `Area:` apart, which is the whole reason for sections', () => {
    // Mainsail, Genoa/Jib and Asym each have `Area:` and `Rated Area:`. A flat
    // label → number map keeps whichever the extractor emitted last and nothing
    // downstream can tell which sail it belongs to.
    const c = parseOrrCertificate(RYUJIN)!
    expect(c.main.areaM2).toBe(91.7)
    expect(c.jib.areaM2).toBe(108.1)
    expect(c.asym.areaM2).toBe(277.6)
  })

  it('keeps Measurement Trim apart from Sailing Trim, where the SAME label differs', () => {
    // Ryujin's draft is 3.695 measured and 3.748 sailing; wetted area 40.7 and
    // 45.0. Both are real numbers and they are not interchangeable.
    const s = splitSections(RYUJIN)
    expect(s['Measurement Trim'].Draft).toBe(3.695)
    expect(s['Sailing Trim'].Draft).toBe(3.748)
    expect(s['Measurement Trim']['Wetted Area']).toBe(40.7)
    expect(s['Sailing Trim']['Wetted Area']).toBe(45.0)
  })

  it('does not match Rig/Sail Configuration as the Rig section', () => {
    // 'Rig' is a prefix of 'Rig/Sail Configuration', so heading order matters.
    const s = splitSections(RYUJIN)
    expect(s.Rig.P).toBe(21.388)
    expect(s.Rig.I).toBe(19.627)
  })

  it('reads a NEGATIVE value, which VCGM always is', () => {
    expect(splitSections(RYUJIN)['Sailing Trim'].VCGM).toBe(-0.573)
  })

  it('refuses a document that is not an ORR certificate', () => {
    // A rig model built from the wrong document is worse than none — the same
    // rule parseIrcCertificate follows.
    expect(parseOrrCertificate('IRC Certificate\nP 21.388\nE 6.528')).toBeNull()
    expect(parseOrrCertificate('')).toBeNull()
  })
})

describe('rigModelFromOrr', () => {
  const model = () => rigModelFromOrr(parseOrrCertificate(RYUJIN)!)

  it('makes P the scale reference, measured and vertical', () => {
    const p = model().scaleRefs.find((s) => s.key === 'P')!
    expect(p.mm).toBe(21388)
    expect(p.source).toBe('measured')
    // It runs UP the rig, so ψ does not foreshorten it — which is what makes it
    // the right scale for a shot well off the centreplane.
    expect(p.depthMm).toBe(0)
  })

  it('makes J the psi baseline', () => {
    const b = model().baselines.find((x) => x.key === 'tack-mast')!
    expect(b.mm).toBe(5700)
    expect(b.source).toBe('measured')
  })

  it('carries a MEASURED quarter width, which no IRC boat has', () => {
    // The 25 % stripe is the station widthAt otherwise interpolates, and on a
    // mainsail that interpolation is its worst: a fit from the stations above
    // comes back about 10 % out at the foot.
    const w = model().widths!
    expect(w.main!.quarter).toBe(5.510)
    expect(w.jib!.quarter).toBe(6.620)
    expect(w.main!.foot).toBe(6.528)       // E
    expect(w.jib!.foot).toBe(8.520)        // HLP
  })

  it('puts the boom aft of the mast, at E', () => {
    expect(model().depths.boom.mm).toBe(-6528)
    expect(model().depths.boom.source).toBe('measured')
  })

  it('says which certificate it came from', () => {
    expect(model().notes).toMatch(/ORR cert US42284/)
    expect(model().notes).toMatch(/USA51007/)
    expect(model().notes).toMatch(/full measured/)
  })

  it('leaves the main leech depth an estimate, as the IRC path does', () => {
    // One number cannot stand for a quantity that changes by metres over the
    // hoist. The WIDTHS are what a station's depth is looked up from.
    expect(model().depths.mainLeech.source).toBe('estimate')
  })
})
