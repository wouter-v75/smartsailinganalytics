// src/lib/ircCertificate.ts
// ─────────────────────────────────────────────────────────────────────────────
// An IRC certificate is a rig model that already exists, for every boat in the
// fleet — yours and theirs.
//
// SailTrim needs three things the photograph cannot supply: one length that lies
// ACROSS the boat (to set the scale), the fore-and-aft offset of each target
// from the mast (for the depth and misalignment corrections), and the
// fore-and-aft separation of two centreplane points (to measure ψ). An endorsed
// IRC certificate carries all three, measured by a measurer, and it is issued
// for competitors as well — which is what makes a rival boat measurable at all.
//
// THE ONE THAT UNBLOCKS MILLIMETRES IS **P**, the mainsail hoist between the
// black bands on the mast. It is not an athwartships length, but it does not
// need to be: seen from astern the mast lies in the plane perpendicular to the
// line of sight, so P projects at full length. Rake costs cos(rake) — 0.06 % at
// 2°, 0.2 % at 4° — and mast bend costs the arc-to-chord difference, about
// 0.02 % for 300 mm of sagitta over 31 m. Against a spreader at 6 m, P is five
// times the baseline and lands the scale an order of magnitude tighter.
//
// Parsing is against the text that `extractPdfText` produces from an RORC/YCF
// certificate PDF: labels in a block, then their values in the same order, with
// the rig dimensions as plain `KEY value` pairs.
// ─────────────────────────────────────────────────────────────────────────────

import { defaultRigModel, type RigModel, type Provenance } from './rigModel'

export interface IrcHull {
  /** Hull length, m. */
  lh: number | null
  /** Waterline length, m. */
  lwp: number | null
  /** kg, as weighed. */
  weightKg: number | null
  dlr: number | null
  draftM: number | null
}

export interface IrcRig {
  /** Mainsail hoist between the mast black bands, m. The scale reference. */
  p: number | null
  /** Mainsail foot, aft face of the mast to the outer band on the boom, m. */
  e: number | null
  /** Base of the foretriangle: forestay at deck to the front of the mast, m. */
  j: number | null
  /** Spinnaker tack length, m. */
  stl: number | null
  /** Headsail luff perpendicular (clew to luff), m. */
  hlp: number | null
  /** Headsail luff, m. */
  hlu: number | null
  /** Rated areas, m². */
  hsa: number | null
  spa: number | null
  /**
   * Sail WIDTHS, m — luff to leech at 1/2, 3/4 and 7/8 of the hoist.
   *
   * These are the denominator of every shape number. A leech offset alone says
   * where the leech is; divided by the width at that height it becomes a chord
   * ANGLE, and the difference between two heights is TWIST. The photograph can
   * give the first and never the second, and the certificate has had them all
   * along — `MHW`/`MTW`/`MUW` for the main, `HHW`/`HTW`/`HUW` for the headsail.
   *
   * The catch, and it is §8.3's: the certificate dimensions ONE headsail. On
   * Northstar that is the J1.5. J2, J3 and J4 have no widths anywhere.
   */
  mhw: number | null
  mtw: number | null
  muw: number | null
  hhw: number | null
  htw: number | null
  huw: number | null
}

export interface IrcCertificate {
  name: string
  sailNumber: string
  design: string
  certNo: string
  ircClass: string
  endorsed: boolean
  validFrom: string
  expires: string
  hull: IrcHull
  rig: IrcRig
  /** Every `KEY value` pair found, so nothing is silently dropped. */
  fields: Record<string, number>
}

const num = (s: string): number | null => {
  const v = Number(String(s).replace(/[^\d.-]/g, ''))
  return Number.isFinite(v) ? v : null
}
const isNumeric = (s: string) => /^-?[\d]+(\.\d+)?$/.test(s.trim())

/**
 * Parse the text of an IRC certificate.
 *
 * Returns null rather than a half-filled object when the text is not a
 * certificate — a rig model built from the wrong document is worse than none.
 */
export function parseIrcCertificate(text: string): IrcCertificate | null {
  if (!text || !/IRC/i.test(text)) return null
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)

  // ── `KEY value` pairs, which is most of the rig ───────────────────────────
  // Also handles the comma-run lines: "SLU 37.74, SLE 31.70".
  //
  // The match is anchored at BOTH ends, and that is not fussiness. The
  // amendment notes at the top of a certificate are prose with dates in them —
  // "PF weighed, ohangs, list, E 8/26" and "new rig ... rig 5/26" — and an
  // unanchored match reads those as E = 8.00 m and P = 5.00 m. Which it did:
  // a 5 m mast on a Maxi 72, printed without a murmur.
  const fields: Record<string, number> = {}
  for (const l of lines) {
    for (const part of l.split(',')) {
      const m = part.trim().match(/^([A-Za-z][A-Za-z/]*)\s+(-?\d+(?:\.\d+)?)\s*(?:m²|m2|mm|m|kg)?$/)
      if (!m) continue
      const v = num(m[2])
      if (v == null) continue
      // "HLU/HLUmax 30.60" means both are that value.
      for (const key of m[1].split('/')) if (!(key in fields)) fields[key] = v
    }
  }

  // ── a label block followed by its values, in order ────────────────────────
  const blockAfter = (marker: string, maxLabels: number): string[] => {
    const i = lines.findIndex((l) => l === marker || l.startsWith(marker))
    if (i < 0) return []
    const labels: string[] = []
    let j = i + 1
    while (j < lines.length && labels.length < maxLabels && !isNumeric(lines[j])) {
      labels.push(lines[j]); j++
    }
    const values: string[] = []
    while (j < lines.length && values.length < labels.length && isNumeric(lines[j].split(' ')[0])) {
      values.push(lines[j]); j++
    }
    return values
  }

  // BOAT: Name / Sail Number / Design / Cert No. / Crew No. — the values are
  // text, so they are taken as the run of lines after the labels.
  const boatIdx = lines.findIndex((l) => l === 'BOAT:')
  let name = '', sailNumber = '', design = '', certNo = ''
  if (boatIdx >= 0) {
    let j = boatIdx + 1
    const labels: string[] = []
    while (j < lines.length && lines[j].endsWith(':')) { labels.push(lines[j]); j++ }
    const vals = lines.slice(j, j + labels.length)
    const pick = (label: string) => {
      const k = labels.findIndex((l) => l.toLowerCase().startsWith(label))
      return k >= 0 && vals[k] ? vals[k] : ''
    }
    name = pick('name')
    sailNumber = pick('sail number')
    design = pick('design')
    certNo = pick('cert')
  }

  // HULL: LH / LWP / Boat Weight / DLR / Draft
  const hullVals = blockAfter('HULL', 6).map(num)
  const hull: IrcHull = {
    lh: hullVals[0] ?? null,
    lwp: hullVals[1] ?? null,
    weightKg: hullVals[2] ?? null,
    dlr: hullVals[3] ?? null,
    draftM: hullVals[4] ?? null,
  }
  // Cheap sanity on the positional read — a maxi is 15–30 m long and floats.
  if (hull.lh != null && (hull.lh < 5 || hull.lh > 120)) hull.lh = null
  if (hull.draftM != null && (hull.draftM < 0.3 || hull.draftM > 15)) hull.draftM = null
  if (hull.weightKg != null && hull.weightKg < 200) hull.weightKg = null

  const rig: IrcRig = {
    p: fields.P ?? null,
    e: fields.E ?? null,
    j: fields.J ?? null,
    stl: fields.STL ?? null,
    hlp: fields.HLP ?? null,
    hlu: fields.HLU ?? fields.HLUmax ?? null,
    hsa: fields.HSA ?? null,
    spa: fields.SPA ?? null,
    mhw: fields.MHW ?? null,
    mtw: fields.MTW ?? null,
    muw: fields.MUW ?? null,
    hhw: fields.HHW ?? null,
    htw: fields.HTW ?? null,
    huw: fields.HUW ?? null,
  }
  // Plausibility, because a wrong number here is worse than a missing one: it
  // propagates into every millimetre the tool reports. These bounds are wide
  // enough for anything from a sportsboat to a J-class.
  const sane = (x: number | null, lo: number, hi: number) => (x != null && x >= lo && x <= hi ? x : null)
  rig.p = sane(rig.p, 5, 80)
  rig.e = sane(rig.e, 1, 35)
  rig.j = sane(rig.j, 1, 35)
  rig.hlu = sane(rig.hlu, 3, 85)
  rig.hlp = sane(rig.hlp, 1, 35)
  // Widths narrow as they go up, and every one is shorter than the foot it
  // belongs to. Bounds wide enough for a sportsboat and a J-class alike.
  rig.mhw = sane(rig.mhw, 0.5, 30)
  rig.mtw = sane(rig.mtw, 0.3, 25)
  rig.muw = sane(rig.muw, 0.2, 20)
  rig.hhw = sane(rig.hhw, 0.3, 30)
  rig.htw = sane(rig.htw, 0.2, 25)
  rig.huw = sane(rig.huw, 0.1, 20)
  // A width that is not smaller than the one below it is a misread, not a sail.
  if (rig.mhw != null && rig.mtw != null && rig.mtw >= rig.mhw) { rig.mtw = null; rig.muw = null }
  if (rig.mtw != null && rig.muw != null && rig.muw >= rig.mtw) rig.muw = null
  if (rig.hhw != null && rig.htw != null && rig.htw >= rig.hhw) { rig.htw = null; rig.huw = null }
  if (rig.htw != null && rig.huw != null && rig.huw >= rig.htw) rig.huw = null
  // A mast hoist shorter than the boom, or a foretriangle base longer than the
  // hoist, means the parse went wrong even if each number looks reasonable.
  if (rig.p != null && rig.e != null && rig.p < rig.e) { rig.p = null; rig.e = null }
  if (rig.p != null && rig.j != null && rig.j > rig.p) { rig.j = null }

  if (rig.p == null && rig.j == null && rig.e == null) return null   // not a rig certificate

  const line = (re: RegExp) => lines.find((l) => re.test(l)) || ''
  return {
    name, sailNumber, design, certNo,
    ircClass: (line(/^IRC Class:/).split(':')[1] || '').trim(),
    endorsed: lines.some((l) => /ENDORSED CERTIFICATE/i.test(l)),
    validFrom: (line(/^Valid from:/).split(':').slice(1).join(':') || '').trim(),
    expires: (line(/^Expires:/).split(':').slice(1).join(':') || '').trim(),
    hull, rig, fields,
  }
}

// ── where the jib's corners actually are ────────────────────────────────────

export interface JibGeometry {
  /** Forestay angle from vertical, degrees. */
  forestayRakeDeg: number
  /** Clew, fore-and-aft from the mast, mm, FORWARD positive. */
  clewDepthMm: number
  clewDepthSigmaMm: number
  /** The leech where it crosses the given height, mm, forward positive. */
  leechDepthMm: number
  leechDepthSigmaMm: number
  /** Clew height above the tack, mm. */
  clewHeightMm: number
}

/**
 * Put the jib's clew and leech in the boat's fore-and-aft frame, from J, the
 * luff and the luff perpendicular.
 *
 * The luff runs from the tack — J forward of the mast at deck — up to the head
 * at the masthead, so its horizontal run IS J and sin(rake) = J / HLU. Walk a
 * fraction `clewFrac` of the luff up from the tack, then HLP perpendicular to
 * it in the sail's plane, and that is the clew:
 *
 *     x_clew = J·(1 − clewFrac) − HLP·cos(rake)
 *
 * The result is the one that matters here, and it is not what a guess gives.
 * For Northstar (J 8.86, HLU 30.60, HLP 8.96) it puts the clew **about a metre
 * ABAFT the mast**, not eight metres forward — which is what a 100 %-LP jib
 * means, and it changes what ψ and the depth correction are worth on that
 * target by nearly an order of magnitude.
 *
 * `clewFrac` is the one thing the certificate does not carry. 0.15 with a
 * 0.10–0.22 spread is a maxi jib; the spread is what the sigma is made of.
 */
export function jibGeometry(
  rig: IrcRig,
  opts: { clewFrac?: number; clewFracSpread?: number; spreaderHeightM?: number } = {},
): JibGeometry | null {
  const { j, hlu, hlp } = rig
  if (!j || !hlu || !hlp || hlu <= j) return null
  const frac = opts.clewFrac ?? 0.15
  const spread = opts.clewFracSpread ?? 0.06
  const sinR = j / hlu
  const rake = Math.asin(Math.min(1, sinR))
  const cosR = Math.cos(rake)

  const xClew = j * (1 - frac) - hlp * cosR
  // The clew slides along the luff with clewFrac, at J per unit — so the whole
  // uncertainty in where the clew sits is J × spread.
  const xClewSigma = j * spread

  const zClew = frac * hlu * cosR - hlp * sinR          // above the tack
  const zHead = hlu * cosR
  const xHead = 0                                        // masthead, over the mast

  // The leech is the clew-to-head line; the roach on a jib is small and lives
  // in the sigma. Spreader 2 on a maxi 72 is around 20 m.
  const zSpr = opts.spreaderHeightM ?? 20
  const t = Math.min(1, Math.max(0, (zSpr - zClew) / (zHead - zClew)))
  const xLeech = xClew + t * (xHead - xClew)

  return {
    forestayRakeDeg: (rake * 180) / Math.PI,
    clewDepthMm: xClew * 1000,
    clewDepthSigmaMm: xClewSigma * 1000,
    leechDepthMm: xLeech * 1000,
    // The leech inherits a shrunk share of the clew's uncertainty, plus the
    // height of spreader 2 not being on the certificate either.
    leechDepthSigmaMm: Math.hypot((1 - t) * xClewSigma * 1000, 300),
    clewHeightMm: zClew * 1000,
  }
}

// ── certificate → rig model ─────────────────────────────────────────────────

// Rounded to the millimetre. A derived jib clew carrying ±500 mm has no
// business rendering as -1045.19988 in a form field.
const v = (mm: number, sigmaMm: number, source: Provenance) =>
  ({ mm: Math.round(mm), sigmaMm: Math.round(sigmaMm), source })

/**
 * Build a SailTrim rig model from a certificate.
 *
 * Certificate figures are `measured` — an IRC measurer measured them and
 * endorsed the result — while anything worked out from them is `derived` and
 * carries the working's uncertainty. Nothing here is ever `designer`: that is
 * reserved for a number off the rig drawing.
 */
export function rigModelFromIrc(cert: IrcCertificate, opts: { spreaderHeightM?: number } = {}): RigModel {
  const base = defaultRigModel(cert.name || '')
  const { p, e, j, hlu } = cert.rig
  const geom = jibGeometry(cert.rig, opts)

  const scaleRefs = [...base.scaleRefs]
  const put = (key: string, label: string, mm: number, sigmaMm: number, source: Provenance) => {
    const i = scaleRefs.findIndex((s) => s.key === key)
    // Both of these run UP THE RIG, so ψ does not foreshorten them — which is
    // what makes them the right scale for a shot well off the centreplane.
    const entry = { key, label, mm, sigmaMm, source, depthMm: 0, orientation: 'vertical' as const }
    if (i >= 0) scaleRefs[i] = entry; else scaleRefs.unshift(entry)
  }
  if (p) {
    // 20 mm: a band is a painted line a measurer sets, and you have to click it.
    put('P', 'P — mast black bands (mainsail hoist)', p * 1000, 20, 'measured')
  }
  if (hlu) {
    // The forestay sags under load, so this reads long by an amount nobody
    // knows at the moment of the shutter. Usable, but as the cross-check.
    put('HLU', 'HLU — headsail luff (sags under load)', hlu * 1000, 150, 'measured')
  }

  const baselines = [...base.baselines]
  if (j) {
    const i = baselines.findIndex((b) => b.key === 'tack-mast')
    // J is to the FRONT face of the mast, not its centreline — half a section,
    // call it 200 mm, and it only scales ψ by the same fraction.
    const entry = { key: 'tack-mast', label: 'J — forestay tack → mast', mm: j * 1000, sigmaMm: 200, source: 'measured' as Provenance }
    if (i >= 0) baselines[i] = entry; else baselines.unshift(entry)

    // Mast → transom follows: it is the tack → transom distance less J. The
    // first term is still an estimate, so this inherits its sigma — but it is a
    // NUMBER, and a baseline without one silently disables the ψ correction.
    const bt = baselines.find((b) => b.key === 'bow-transom')
    const mt = baselines.findIndex((b) => b.key === 'mast-transom')
    if (bt && bt.mm > 0 && mt >= 0) {
      baselines[mt] = {
        ...baselines[mt],
        mm: Math.round(bt.mm - j * 1000),
        sigmaMm: Math.round(Math.hypot(bt.sigmaMm, 200)),
        source: 'derived' as Provenance,
      }
    }
  }

  return {
    ...base,
    boat: cert.name || base.boat,
    scaleRefs,
    baselines,
    clewHeightMm: geom ? Math.round(geom.clewHeightMm) : undefined,
    // The widths, straight off the certificate. The foot is E for the main and
    // HLP for the headsail — both already parsed, both the width at zero hoist.
    widths: {
      main: { foot: e, half: cert.rig.mhw, threeQuarter: cert.rig.mtw, upper: cert.rig.muw },
      jib: { foot: cert.rig.hlp, half: cert.rig.hhw, threeQuarter: cert.rig.htw, upper: cert.rig.huw },
    },
    depths: {
      // E is to the outer band on the boom; aft of the mast, so negative.
      boom: e ? v(-e * 1000, 150, 'measured') : base.depths.boom,
      clew: geom ? v(geom.clewDepthMm, geom.clewDepthSigmaMm, 'derived') : base.depths.clew,
      leech: geom ? v(geom.leechDepthMm, geom.leechDepthSigmaMm, 'derived') : base.depths.leech,
      // NOT derived here, deliberately. The main's leech depth is the mainsail's
      // width at the height being measured — MHW at half hoist, MTW at three
      // quarters, MUW at seven eighths — all of which ARE on the certificate and
      // none of which this parser reads yet. One number cannot stand for a
      // quantity that changes by three metres over the hoist, so rather than
      // derive a confident average it stays the flagged estimate until the
      // girths are parsed and the depth is looked up per height tag. See §8 of
      // docs/sail-geometry-from-astern-2026-09.md.
      mainLeech: base.depths.mainLeech,
    },
    notes: [
      `IRC cert ${cert.certNo}${cert.endorsed ? ' (endorsed)' : ''}, ${cert.sailNumber}, ${cert.design}`,
      cert.expires ? `expires ${cert.expires}` : '',
      geom ? `clew and leech derived from J ${j}, HLU ${hlu}, HLP ${cert.rig.hlp} — forestay rake ${geom.forestayRakeDeg.toFixed(1)}°` : '',
    ].filter(Boolean).join(' · '),
  }
}
