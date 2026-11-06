// src/lib/orrCertificate.ts
// ─────────────────────────────────────────────────────────────────────────────
// Reading an ORR certificate — the American rule, beside `ircCertificate.ts`.
//
// WHAT IT IS FOR, same as the IRC one: a rig model needs P as a scale, J as a
// ψ baseline, and the sail WIDTHS that turn a leech offset into a chord angle.
// A photograph gives where the leech is; only the width at that height makes it
// a shape. ORR carries all of it, and one thing IRC does not — see QUARTER
// WIDTHS below.
//
// THREE WAYS IT DIFFERS FROM IRC, each of which breaks a naive reader:
//
//  1. LABELS, NOT KEYS. IRC writes `P 21.388`; ORR writes `P: 21.388 m`, with
//     labels that contain spaces, dots and slashes — `Prop Dia.:`, `Rated
//     Area:`, `Mast Wt:`, `Narrow Asym (.75 <= SHW/SFL < .85):`.
//
//  2. THE SAME LABEL MEANS DIFFERENT THINGS IN DIFFERENT COLUMNS, which is the
//     one that matters. `Area:` and `Rated Area:` each appear three times — in
//     Mainsail, in Genoa/Jib and in Asym. `LCB:`, `VCGM:`, `Draft:` and
//     `Wetted Area:` appear twice, once under Measurement Trim and once under
//     Sailing Trim, with genuinely different values (Ryujin: draft 3.695 against
//     3.748, wetted area 40.7 against 45.0). A flat label → number map silently
//     keeps whichever came last in the extraction, and nothing downstream can
//     tell. So the text is cut into SECTIONS first and every lookup is scoped.
//
//  3. QUARTER WIDTHS. ORR measures `MQW` and `HQW` — the sail's width at a
//     quarter of the hoist — and IRC does not. That is worth having rather than
//     merely recording: the 25 % stripe is the one station `widthAt` has always
//     had to INTERPOLATE, and on a mainsail, whose planform bends hardest near
//     the foot, a fit from the stations above is about 10 % out. An ORR boat can
//     have that width measured instead of guessed.
//
// THE CERTIFICATE THIS WAS WRITTEN AGAINST CANNOT BE READ BY IT, and that is
// worth saying plainly. Ryujin's `RYUJIN Base (J0) ORR cert.pdf` has every glyph
// drawn as vector outlines — 0 text-show operators against 47,884 path
// operators, no font objects at all — so `extractPdfText` returns 15 characters
// and there is nothing for any parser to read. That is a property of how that
// file was exported, not of the ORR format; a certificate downloaded from the
// ORA carries real text. The field names and layout below were read off the
// rendered pages, so they are right, but the EXTRACTION ORDER a real ORR text
// PDF produces is unverified — see the note on `splitSections`.
// ─────────────────────────────────────────────────────────────────────────────

import { defaultRigModel, type RigModel, type Provenance } from './rigModel'
import { jibGeometry } from './ircCertificate'

/** Metres, unless the certificate was issued in feet — see `FT_PER_M`. */
export interface OrrRig {
  /** Foretriangle height, m. */
  i: number | null
  /** Foretriangle base: forestay at deck to the front of the mast, m. */
  j: number | null
  /** Mainsail hoist between the black bands, m. The scale reference. */
  p: number | null
  /** Mainsail foot, m. */
  e: number | null
  /** Boom above sheer, m. IRC has no equivalent. */
  bas: number | null
  /** Mast width and fore-and-aft depth at the measurement point, m. */
  mw: number | null
  /** Spinnaker/headsail tack point forward of the stem, m. */
  tps: number | null
  /** Headstay/genoa hoist and base, m. */
  ig: number | null
  jg: number | null
}

export interface OrrSail {
  /** Head board width, m. */
  hb: number | null
  /** Widths at a quarter, half, three quarters and seven eighths of the hoist, m. */
  qw: number | null
  hw: number | null
  tw: number | null
  uw: number | null
  /** Luff and leech, m. */
  luff: number | null
  leech: number | null
  /** Foot: E for the main, HLP for the headsail. The width at zero hoist. */
  foot: number | null
  areaM2: number | null
  ratedAreaM2: number | null
}

export interface OrrCertificate {
  name: string
  sailNumber: string
  /** `US42284`. */
  certNo: string
  className: string
  builder: string
  owner: string
  validYear: string
  /** `Full Measured`, or a default-values measurement — which the sail plan
   *  draws in RED and which must not be mistaken for a measured sail. */
  measurement: string
  rigType: string
  issueDate: string
  loaM: number | null
  beamM: number | null
  /** General Purpose Handicap, s/mile. */
  gph: number | null
  rig: OrrRig
  main: OrrSail
  jib: OrrSail
  asym: OrrSail
  /** Every section's own `label → number`, so nothing is silently dropped and
   *  a caller can reach a field this interface does not name. */
  sections: Record<string, Record<string, number>>
  /** True when the certificate was issued in FEET and the numbers above were
   *  converted. ORR issues both; a 21.4 that is really 70 ft is a 3.3x error. */
  convertedFromFeet: boolean
}

const FT_PER_M = 3.280839895

/**
 * The column headings on page 1, in document order.
 *
 * Everything between one heading and the next belongs to that section, which is
 * what keeps three different `Area:` apart. The headings are matched loosely
 * (`&` and case) because a text extractor may or may not preserve them exactly.
 */
const SECTIONS = [
  'Critical Configuration Items',
  'Measurement Trim',
  'Sailing Trim',
  'Rig/Sail Configuration',   // BEFORE 'Rig', or 'Rig' matches its prefix
  'Sail Tack & Head',
  'Rig',
  'Propeller',
  'Mainsail',
  'Genoa/Jib',
  'Asym',
] as const

const num = (s: string): number | null => {
  // Thousands separators are real here: "1,031.8" in the time allowances and
  // "1079 kg" in the crew weight.
  const v = Number(String(s).replace(/,/g, '').replace(/[^\d.-]/g, ''))
  return Number.isFinite(v) ? v : null
}

/**
 * Cut the text into sections, then read `Label: value` inside each.
 *
 * THE ASSUMPTION, and it is the one thing here that a real text PDF has not yet
 * confirmed: that a section's heading is extracted BEFORE the labels beneath
 * it. Page 1 is laid out in five columns, and a PDF text extractor emits runs
 * in content-stream order, which for a multi-column table is usually
 * column-by-column but is not guaranteed. If a certificate ever comes out
 * interleaved, the symptom is specific and findable — `Area` under the wrong
 * sail — which is why `sections` is returned whole rather than only the fields
 * this file names.
 */
export function splitSections(text: string): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {}
  const marks: { name: string; at: number }[] = []
  for (const name of SECTIONS) {
    // A heading sits ALONE on its line. Matching it loosely anywhere finds
    // `Rig Type: Masthead Sloop` in the boat details at the top of page 1 and
    // calls that the start of the Rig column — which then swallows nothing and
    // leaves P, E, I and J filed under whatever section precedes them. The
    // tests pin that case.
    const lit = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(`(?:^|\\n)[ \\t]*${lit}[ \\t]*(?=\\r?\\n|$)`, 'i')
    const m = re.exec(text)
    if (m) marks.push({ name, at: m.index })
  }
  marks.sort((a, b) => a.at - b.at)
  for (let i = 0; i < marks.length; i++) {
    const from = marks[i].at
    const to = i + 1 < marks.length ? marks[i + 1].at : text.length
    const body = text.slice(from, to)
    const fields: Record<string, number> = {}
    // `Label: 21.388` — the label may hold spaces, dots, slashes and brackets,
    // and the value may be negative ("VCGM: -0.573") or carry a separator.
    const re = /([A-Za-z][A-Za-z0-9 ./()&%-]*?)\s*:\s*(-?[\d,]+\.?\d*)/g
    for (let m = re.exec(body); m; m = re.exec(body)) {
      const key = m[1].trim().replace(/\s+/g, ' ')
      const v = num(m[2])
      // FIRST wins inside a section: a label that repeats within one column is
      // the extractor having wrapped something, not a second measurement.
      if (v != null && !(key in fields)) fields[key] = v
    }
    out[marks[i].name] = fields
  }
  return out
}

/** A string field like `Class: Ker 52`, which `splitSections` skips. */
const str = (text: string, label: string): string => {
  const re = new RegExp(`${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:\\s*([^\\n]*)`, 'i')
  const m = re.exec(text)
  return m ? m[1].trim().split(/\s{2,}/)[0].trim() : ''
}

/**
 * Parse the text of an ORR certificate.
 *
 * Returns null rather than a half-filled object when the text is not one — a
 * rig model built from the wrong document is worse than none, which is the same
 * rule `parseIrcCertificate` follows and for the same reason.
 */
export function parseOrrCertificate(text: string): OrrCertificate | null {
  if (!text) return null
  // Both lines appear on every ORR certificate and neither appears on an IRC
  // one, so this cannot swallow the other format.
  if (!/Offshore Racing Rule/i.test(text) && !/ORR\s*Type/i.test(text)) return null

  const sections = splitSections(text)
  const sec = (name: string, key: string): number | null => {
    const s = sections[name]
    return s && key in s ? s[key] : null
  }

  // FEET OR METRES. The certificate labels its units per value; the cheapest
  // reliable test is the mainsail hoist, which is 15-30 m on anything that
  // carries an ORR certificate and 50-100 in feet.
  const pRaw = sec('Rig', 'P')
  const convertedFromFeet = (pRaw ?? 0) > 45
  const m = (v: number | null): number | null =>
    v == null ? null : (convertedFromFeet ? v / FT_PER_M : v)

  const sail = (name: string, prefix: string, footKey: string): OrrSail => ({
    hb: m(sec(name, `${prefix}HB`)),
    qw: m(sec(name, `${prefix}QW`)),
    hw: m(sec(name, `${prefix}HW`)),
    tw: m(sec(name, `${prefix}TW`)),
    uw: m(sec(name, `${prefix}UW`)),
    luff: m(sec(name, `${prefix}LU`)),
    leech: m(sec(name, `${prefix}LE`)),
    foot: m(sec(name, footKey)),
    // Areas are m², so they scale by the SQUARE — a bug that would read as a
    // plausible number rather than an obvious one.
    areaM2: convertedFromFeet
      ? (sec(name, 'Area') ?? 0) / (FT_PER_M * FT_PER_M) || null
      : sec(name, 'Area'),
    ratedAreaM2: convertedFromFeet
      ? (sec(name, 'Rated Area') ?? 0) / (FT_PER_M * FT_PER_M) || null
      : sec(name, 'Rated Area'),
  })

  return {
    name: str(text, 'Boat Name') || sailNumberLine(text).name,
    sailNumber: sailNumberLine(text).sail,
    certNo: str(text, 'Certification #'),
    className: str(text, 'Class'),
    builder: str(text, 'Builder'),
    owner: str(text, 'Owner\\(s\\)'),
    validYear: str(text, 'Valid Year'),
    measurement: str(text, 'Measurement'),
    rigType: str(text, 'Rig Type'),
    issueDate: str(text, 'Issue Date'),
    loaM: m(sec('Critical Configuration Items', 'LOA') ?? numAfter(text, 'LOA')),
    beamM: m(sec('Critical Configuration Items', 'Beam Max') ?? numAfter(text, 'Beam Max')),
    gph: numAfter(text, 'General Purpose Handicap\\(GPH\\)') ?? numAfter(text, 'GPH'),
    rig: {
      i: m(sec('Rig', 'I')), j: m(sec('Rig', 'J')),
      p: m(pRaw), e: m(sec('Rig', 'E')),
      bas: m(sec('Rig', 'BAS')), mw: m(sec('Rig', 'MW')),
      tps: m(sec('Sail Tack & Head', 'TPS')),
      ig: m(sec('Sail Tack & Head', 'IG')), jg: m(sec('Sail Tack & Head', 'JG')),
    },
    main: { ...sail('Mainsail', 'M', 'E'), foot: m(sec('Rig', 'E')) },
    jib: sail('Genoa/Jib', 'H', 'HLP'),
    asym: {
      hb: null, qw: null, hw: m(sec('Asym', 'SHW')), tw: null, uw: null,
      luff: m(sec('Asym', 'SLU')), leech: m(sec('Asym', 'SLE')),
      foot: m(sec('Asym', 'SFL')),
      areaM2: sec('Asym', 'Area'), ratedAreaM2: sec('Asym', 'Rated Area'),
    },
    sections,
    convertedFromFeet,
  }
}

/** `RYUJIN   USA51007` under the title — the name and sail number in one run. */
function sailNumberLine(text: string): { name: string; sail: string } {
  const m = /^\s*([A-Z0-9'’ .-]{2,30}?)\s{2,}([A-Z]{2,3}\s?\d{2,6})\s*$/m.exec(text)
  return m ? { name: m[1].trim(), sail: m[2].replace(/\s+/g, '') } : { name: '', sail: '' }
}

/** A value that follows a label without a colon between them. */
function numAfter(text: string, label: string): number | null {
  const re = new RegExp(`${label}\\s*:?\\s*(-?[\\d,]+\\.?\\d*)`, 'i')
  const m = re.exec(text)
  return m ? num(m[1]) : null
}

/**
 * A rig model from an ORR certificate.
 *
 * Deliberately the same shape as `rigModelFromIrc`, because the two rules
 * measure the same boat and SailTrim should not be able to tell which one a
 * model came from — except through `notes`, and except that an ORR model may
 * carry a MEASURED quarter width where an IRC one always interpolates it.
 */
export function rigModelFromOrr(cert: OrrCertificate): RigModel {
  const base = defaultRigModel(cert.name || '')
  const { p, e, j } = cert.rig
  const hlu = cert.jib.luff
  const hlp = cert.jib.foot
  const geom = jibGeometry({ j, hlu, hlp, p })

  const scaleRefs = [...base.scaleRefs]
  const put = (key: string, label: string, mm: number, sigmaMm: number, source: Provenance) => {
    const i = scaleRefs.findIndex((s) => s.key === key)
    // Both run UP the rig, so ψ does not foreshorten them — which is what makes
    // them the right scale for a shot well off the centreplane.
    const entry = { key, label, mm, sigmaMm, source, depthMm: 0, orientation: 'vertical' as const }
    if (i >= 0) scaleRefs[i] = entry; else scaleRefs.unshift(entry)
  }
  if (p) put('P', 'P — mast black bands (mainsail hoist)', p * 1000, 20, 'measured')
  if (hlu) put('HLU', 'HLU — headsail luff (sags under load)', hlu * 1000, 150, 'measured')

  const baselines = [...base.baselines]
  if (j) {
    const i = baselines.findIndex((b) => b.key === 'tack-mast')
    // As on an IRC certificate, J is to the FRONT face of the mast rather than
    // its centreline — half a section, call it 200 mm.
    const entry = { key: 'tack-mast', label: 'J — forestay tack → mast', mm: j * 1000, sigmaMm: 200, source: 'measured' as Provenance }
    if (i >= 0) baselines[i] = entry; else baselines.unshift(entry)
    const bt = baselines.find((b) => b.key === 'bow-transom')
    const mt = baselines.findIndex((b) => b.key === 'mast-transom')
    if (bt && bt.mm > 0 && mt >= 0) {
      baselines[mt] = {
        ...baselines[mt],
        mm: Math.round(bt.mm - j * 1000),
        sigmaMm: Math.round(Math.hypot(bt.sigmaMm, 200)),
        // Taking J off an ESTIMATED bow-transom leaves an estimate, however
        // exact J is. Calling it 'derived' would launder a guess into something
        // that reads as working.
        source: (bt.source === 'estimate' ? 'estimate' : 'derived') as Provenance,
      }
    }
  }

  const v = (mm: number, sigmaMm: number, source: Provenance) => ({ mm, sigmaMm, source })

  return {
    ...base,
    boat: cert.name || base.boat,
    scaleRefs,
    baselines,
    clewHeightMm: geom ? Math.round(geom.clewHeightMm) : undefined,
    widths: {
      // `quarter` is the one ORR gives and IRC does not. It is the station
      // `widthAt` otherwise interpolates, and on a mainsail that interpolation
      // is the worst one it does.
      main: { foot: e, quarter: cert.main.qw, half: cert.main.hw, threeQuarter: cert.main.tw, upper: cert.main.uw },
      jib: { foot: hlp, quarter: cert.jib.qw, half: cert.jib.hw, threeQuarter: cert.jib.tw, upper: cert.jib.uw },
    },
    depths: {
      // E is to the outer band on the boom; aft of the mast, so negative.
      boom: e ? v(-e * 1000, 150, 'measured') : base.depths.boom,
      clew: geom ? v(geom.clewDepthMm, geom.clewDepthSigmaMm, 'derived') : base.depths.clew,
      leech: geom ? v(geom.leechDepthMm, geom.leechDepthSigmaMm, 'derived') : base.depths.leech,
      // Left as the flagged estimate for the same reason as IRC: the main's
      // leech depth changes by metres over the hoist, and one number cannot
      // stand for it. The WIDTHS above are what a station's depth is looked up
      // from — now including a measured quarter.
      mainLeech: base.depths.mainLeech,
    },
    notes: [
      `ORR cert ${cert.certNo}, ${cert.sailNumber}, ${cert.className}`,
      cert.measurement ? cert.measurement.toLowerCase() : '',
      cert.validYear ? `valid ${cert.validYear}` : '',
      cert.convertedFromFeet ? 'converted from FEET' : '',
      geom ? `clew and leech derived from J ${j}, HLU ${hlu}, HLP ${hlp} — forestay ${geom.forestayAngleDeg.toFixed(1)}° from vertical` : '',
    ].filter(Boolean).join(' · '),
  }
}
