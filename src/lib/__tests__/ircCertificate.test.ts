import { describe, it, expect } from 'vitest'
import { parseIrcCertificate, jibGeometry, rigModelFromIrc } from '../ircCertificate'
import { missingFrom } from '../rigModel'

// The real layout that `extractPdfText` produces from an RORC/YCF certificate:
// a label block, then its values in the same order, then the rig as KEY value
// pairs. This is Northstar III's own endorsed certificate, trimmed.
const NORTHSTAR = `IRC Boat Data
BOAT:
Name:
Sail Number:
Design:
Cert No.:
Crew No.:
NORTHSTAR III
GBR76X
JUDEL/VROLIJK 76 Custom
50945
23  (1955 kg)
IRC Class: IMA Maxi
ENDORSED CERTIFICATE
Valid from: 28 Aug 26 08:31:58
Expires: 31 Dec 26
Amended draft, sail data
Weighed, ohangs, list, 15mm interceptor meas JJD 8/26; draft & rig measured PF 8/26
HULL
LH
LWP
Boat Weight:
DLR
Draft:
23.20
22.26
17017
47
5.73
Weight includes batteries, excludes cushions
RIG & SAIL NOTES
Max number of headsails carried: 4
SO 0.92, y 0.05 x 0.00, h 0.00
BO 0.02
STL 13.23
MUW 3.63
MTW 4.93
MHW 7.04
ID# 155287 MN-A
HLP 8.96
HSA 145.87m²
HHW 4.90
HLU/HLUmax 30.60
J 8.86
SPA 550.19m²
SLU 37.74, SLE 31.70
E 10.33
P 31.44
3 Spreader/Jumper (sets)`

describe('ircCertificate — parsing', () => {
  const cert = parseIrcCertificate(NORTHSTAR)!

  it('reads the boat off the top', () => {
    expect(cert.name).toBe('NORTHSTAR III')
    expect(cert.sailNumber).toBe('GBR76X')
    expect(cert.design).toBe('JUDEL/VROLIJK 76 Custom')
    expect(cert.certNo).toBe('50945')
    expect(cert.ircClass).toBe('IMA Maxi')
    expect(cert.endorsed).toBe(true)
    expect(cert.expires).toBe('31 Dec 26')
  })

  it('reads the hull block, which is positional', () => {
    expect(cert.hull.lh).toBe(23.20)
    expect(cert.hull.lwp).toBe(22.26)
    expect(cert.hull.weightKg).toBe(17017)
    expect(cert.hull.dlr).toBe(47)
    expect(cert.hull.draftM).toBe(5.73)
  })

  it('reads the rig, including the two-in-one and the comma runs', () => {
    expect(cert.rig.p).toBe(31.44)
    expect(cert.rig.e).toBe(10.33)
    expect(cert.rig.j).toBe(8.86)
    expect(cert.rig.hlu).toBe(30.60)     // from "HLU/HLUmax 30.60"
    expect(cert.rig.hlp).toBe(8.96)
    expect(cert.rig.stl).toBe(13.23)
    expect(cert.rig.hsa).toBe(145.87)
    expect(cert.fields.SLE).toBe(31.70)  // second half of a comma run
    expect(cert.fields.BO).toBe(0.02)
  })

  it('is not fooled by the dates in the amendment notes', () => {
    // "…list, E 8/26; draft & rig measured PF 8/26" and, on other certificates,
    // "new rig … rig 5/26". An unanchored match read those as E = 8.00 m and
    // P = 5.00 m — a 5 m mast on a Maxi 72, printed without a murmur.
    const withProse = NORTHSTAR.replace(
      'Amended draft, sail data',
      'Amended weight, E, sail data\nPF weighed, ohangs, list, E 8/26; new rig, twin rudders 5/26',
    )
    const c = parseIrcCertificate(withProse)!
    expect(c.rig.e).toBe(10.33)
    expect(c.rig.p).toBe(31.44)
  })

  it('refuses documents that are not rig certificates', () => {
    expect(parseIrcCertificate('')).toBeNull()
    expect(parseIrcCertificate('IRC is mentioned but there is no rig here')).toBeNull()
  })

  it('drops a dimension that cannot be true rather than passing it on', () => {
    const broken = NORTHSTAR.replace('P 31.44', 'P 2.10')          // shorter than E
    expect(parseIrcCertificate(broken)!.rig.p).toBeNull()
    const jTooBig = NORTHSTAR.replace('J 8.86', 'J 40.00')          // longer than P
    expect(parseIrcCertificate(jTooBig)!.rig.j).toBeNull()
  })
})

describe('ircCertificate — where the jib actually is', () => {
  const cert = parseIrcCertificate(NORTHSTAR)!

  it('puts a 100 %-LP jib clew ABAFT the mast, not metres forward', () => {
    const g = jibGeometry(cert.rig)!
    expect(g.forestayRakeDeg).toBeCloseTo(16.8, 0)
    // HLP 8.96 against J 8.86 is a ~101 % jib, and a 100 % jib's clew lands on
    // the mast. The tool's first guess was +8 m forward — out by nine metres,
    // which is the difference between ψ costing 140 mm a degree and 18.
    expect(g.clewDepthMm).toBeGreaterThan(-1600)
    expect(g.clewDepthMm).toBeLessThan(-500)
    expect(g.clewHeightMm).toBeGreaterThan(1000)   // a metre or two above the tack
    expect(g.clewHeightMm).toBeLessThan(3000)
  })

  it('puts the leech at spreader 2 nearer the mast still', () => {
    const g = jibGeometry(cert.rig, { spreaderHeightM: 20 })!
    expect(Math.abs(g.leechDepthMm)).toBeLessThan(Math.abs(g.clewDepthMm))
    expect(g.leechDepthMm).toBeGreaterThan(-800)
  })

  it('carries the uncertainty of the one thing the certificate does not say', () => {
    // Where the clew sits up the luff is not on the certificate. It slides at
    // J per unit of that fraction, so the sigma is J × the spread.
    const g = jibGeometry(cert.rig, { clewFracSpread: 0.06 })!
    expect(g.clewDepthSigmaMm).toBeCloseTo(8.86 * 0.06 * 1000, -1)
    const wider = jibGeometry(cert.rig, { clewFracSpread: 0.12 })!
    expect(wider.clewDepthSigmaMm).toBeCloseTo(2 * g.clewDepthSigmaMm, -1)
  })

  it('declines when the certificate is missing what it needs', () => {
    expect(jibGeometry({ ...cert.rig, hlp: null })).toBeNull()
    expect(jibGeometry({ ...cert.rig, hlu: 5 })).toBeNull()   // luff shorter than J
  })
})

describe('ircCertificate — building a rig model', () => {
  const model = rigModelFromIrc(parseIrcCertificate(NORTHSTAR)!)

  it('makes P the scale reference, because the mast is in the image plane', () => {
    const p = model.scaleRefs.find((s) => s.key === 'P')!
    expect(p.mm).toBe(31440)
    expect(p.source).toBe('measured')
    expect(p.depthMm).toBe(0)
    // 31 m of baseline is what makes the scale an order better than a spreader
    expect(p.mm).toBeGreaterThan(5 * 6000)
  })

  it('makes J the ψ baseline and E the boom offset', () => {
    expect(model.baselines.find((b) => b.key === 'tack-mast')!.mm).toBe(8860)
    expect(model.depths.boom.mm).toBe(-10330)      // aft of the mast ⇒ negative
    expect(model.depths.boom.source).toBe('measured')
  })

  it('marks worked-out numbers as derived, not measured', () => {
    expect(model.depths.clew.source).toBe('derived')
    expect(model.depths.leech.source).toBe('derived')
    expect(model.scaleRefs.find((s) => s.key === 'HLU')!.source).toBe('measured')
    // and nothing claims to be off the rig drawing
    expect(model.scaleRefs.every((s) => s.source !== 'designer')).toBe(true)
  })

  it('leaves exactly one thing as guesswork — the one the certificate has no answer for', () => {
    // Everything the photograph cannot supply and the certificate can: the
    // scale, the baseline, the jib's corners, the boom. The MAIN's leech depth
    // is the mainsail's width at the height being measured — MHW/MTW/MUW, on the
    // certificate but not yet parsed, and changing by three metres over the
    // hoist. One number cannot stand for it, so it stays flagged rather than
    // being averaged into false confidence. See §8 of the doc.
    expect(missingFrom(model)).toEqual([
      "the main leech's fore-and-aft offset from the mast",
    ])
    expect(model.boat).toBe('NORTHSTAR III')
    expect(model.notes).toMatch(/IRC cert 50945 \(endorsed\)/)
  })

  it('keeps the spreader options around, still marked as estimates', () => {
    const spr = model.scaleRefs.find((s) => s.key === 'spreader2')!
    expect(spr.source).toBe('estimate')
  })
})
