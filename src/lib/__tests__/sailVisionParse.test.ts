import { describe, it, expect } from 'vitest'
import {
  parseSailScanReport, detectFormat, sailVisionTwistCheck, SAILVISION_STRIPE_PCT,
  scanIdentityKey,
} from '../sailScanParse'

// Excerpts from Baraka's 12 Oct 2026 report, verbatim as pdfText extracts it.
// Chosen for the things the real file does that a tidy page would not: a bare
// "-" for a value, a mainsail with no bracketed type, a WhatsApp file name full
// of spaces and brackets, and a negative entry angle.
const JIB = `Sail Vision analysis report Page 1
IMG_6456.JPEG - J1.5 (Jib)
Captured 2026-10-11 09:51
Boat speed 5.6 kn Wind strength 7.2 kn
Upwind angle 37.0 deg Runner load 1.9 t
Tack load 50.0 kg Twist (total) 14.59 deg
Sail scan
Stripe Draft position Camber Entry angle Exit angle
Stripe 1 33.65% 13.28% 37.13 deg 17.57 deg
Stripe 2 35.43% 16.60% 38.83 deg 28.91 deg
Stripe 3 44.11% 14.27% 38.42 deg 21.56 deg
Twist: Stripe 1 to Stripe 2: 7.43 deg | Stripe 2 to Stripe 3: 7.16 deg
Notes: Inhauler car position: 1.5
eye up/down: 1
1st spreader 1
2nd spreader: 1.3
`

const MAIN = `Sail Vision analysis report Page 2
IMG_6455.JPEG - Main 2 (Main)
Captured 2026-10-11 09:50
Boat speed 5.6 kn Wind strength 7.3 kn
Upwind angle 37.0 deg Runner load 1.9 t
Tack load - Twist (total) 12.2 deg
Sail scan
Stripe Draft position Camber Entry angle Exit angle
Stripe 1 40.02% 10.46% 27.44 deg 15.12 deg
Stripe 2 36.20% 12.97% 31.95 deg 19.35 deg
Stripe 3 33.17% 11.60% 39.96 deg 18.37 deg
Stripe 4 32.13% 10.33% 37.65 deg 12.55 deg
Twist: Stripe 1 to Stripe 2: 5.69 deg | Stripe 2 to Stripe 3: 4.81 deg | Stripe 3 to Stripe 4: 1.70 deg
Notes: None recorded
`

// Page 16: a dockside scan. EVERY instrument is a dash, the sail carries no
// bracketed type, and stripe 3's entry angle is negative.
const DASHES = `Sail Vision analysis report Page 16
IMG_6408.JPEG - Main
Captured 2026-10-10 11:03
Boat speed - Wind strength -
Upwind angle - Runner load -
Tack load - Twist (total) -19.91 deg
Sail scan
Stripe Draft position Camber Entry angle Exit angle
Stripe 1 40.90% 7.99% 15.19 deg 12.55 deg
Stripe 2 50.49% 8.91% 8.97 deg 18.40 deg
Stripe 3 55.64% 6.39% -6.32 deg 12.70 deg
Stripe 4 58.18% 4.98% 0.56 deg 9.28 deg
Twist: Stripe 1 to Stripe 2: -8.17 deg | Stripe 2 to Stripe 3: -9.22 deg | Stripe 3 to Stripe 4: -2.52 deg
Notes: None recorded
`

const WHATSAPP = `Sail Vision analysis report Page 17
WhatsApp Image 2026-10-10 at 4.40.43 PM (1).jpeg - Main 2 (Main)
Captured 2026-10-10 09:42
Boat speed 8.6 kn Wind strength 0.0 kn
Upwind angle 36.0 deg Runner load 4.63 t
Tack load - Twist (total) 11.22 deg
Sail scan
Stripe Draft position Camber Entry angle Exit angle
Stripe 1 38.88% 6.91% 14.74 deg 11.84 deg
Stripe 2 44.09% 9.33% 17.34 deg 18.41 deg
Stripe 3 45.22% 8.01% 17.22 deg 14.66 deg
Stripe 4 31.94% 5.89% 19.14 deg 7.79 deg
Twist: Stripe 1 to Stripe 2: 5.87 deg | Stripe 2 to Stripe 3: 4.60 deg | Stripe 3 to Stripe 4: 0.75 deg
Notes: None recorded
`

const parse = (t: string) => parseSailScanReport(t, { tz: 'Europe/London' })

describe('Sail Vision — detection', () => {
  it('is its own format, not mistaken for a North report', () => {
    expect(detectFormat(JIB)).toBe('sailvision')
    expect(parse(JIB).format).toBe('sailvision')
    expect(parse(JIB).scans[0].source).toBe('sailvision')
  })
})

describe('Sail Vision — one page per scan', () => {
  it('reads every page of a multi-page report', () => {
    const r = parse(JIB + MAIN + DASHES + WHATSAPP)
    expect(r.scans).toHaveLength(4)
    expect(r.scans.map((s) => s.sailName)).toEqual(['J1.5', 'Main 2', 'Main', 'Main 2'])
  })

  it('splits the file name from the sail on the LAST " - "', () => {
    // The name has spaces, dots and brackets of its own; splitting on the first
    // " - " would cut it in half, and there is no " - " in the sail part to
    // split on instead.
    const s = parse(WHATSAPP).scans[0]
    expect(s.imageName).toBe('WhatsApp Image 2026-10-10 at 4.40.43 PM (1).jpeg')
    expect(s.sailName).toBe('Main 2')
  })

  it('takes the type from the report\'s own bracket, and copes without one', () => {
    expect(parse(JIB).scans[0].sailType).toBe('headsail')
    expect(parse(MAIN).scans[0].sailType).toBe('main')
    // "IMG_6408.JPEG - Main" — no bracket at all.
    expect(parse(DASHES).scans[0].sailName).toBe('Main')
    expect(parse(DASHES).scans[0].sailType).toBe('main')
  })
})

describe('Sail Vision — stripes', () => {
  it('puts a three-stripe jib at 25/50/75 from the foot', () => {
    const s = parse(JIB).scans[0]
    expect(s.stripes.map((x) => x.pos)).toEqual([25, 50, 75])
    expect(s.posFromConvention).toBe(true)
    expect(s.stripes.map((x) => x.label)).toEqual(['Stripe 1', 'Stripe 2', 'Stripe 3'])
  })

  it('puts a four-stripe main at 25/50/75/87 from the foot', () => {
    expect(parse(MAIN).scans[0].stripes.map((x) => x.pos)).toEqual([25, 50, 75, 87])
    expect(SAILVISION_STRIPE_PCT[4]).toEqual([25, 50, 75, 87])
  })

  it('reads draft, camber, entry and exit per stripe', () => {
    const s1 = parse(JIB).scans[0].stripes[0]
    expect(s1.draft).toBe(33.65)
    expect(s1.camber).toBe(13.28)
    expect(s1.entry).toBe(37.13)
    expect(s1.exit).toBe(17.57)
    // This report has no fore/back camber columns at all.
    expect(s1.fore).toBeNull()
    expect(s1.back).toBeNull()
  })

  it('keeps a NEGATIVE entry angle rather than reading it as missing', () => {
    // Page 16 stripe 3: "-6.32 deg". The dash-or-number reader has to prefer
    // the number, or a real reading disappears.
    expect(parse(DASHES).scans[0].stripes[2].entry).toBe(-6.32)
  })

  it('accumulates the PAIRWISE twists from the foot, which is zero', () => {
    // The report gives twist between adjacent stripes; this schema's per-stripe
    // twist is an angle, and the foot is what twist is measured from.
    expect(parse(JIB).scans[0].stripes.map((x) => x.twist)).toEqual([0, 7.43, 14.59])
    expect(parse(MAIN).scans[0].stripes.map((x) => x.twist)).toEqual([0, 5.69, 10.5, 12.2])
    expect(parse(DASHES).scans[0].stripes.map((x) => x.twist)).toEqual([0, -8.17, -17.39, -19.91])
  })
})

describe('Sail Vision — the twist total checks the parse', () => {
  it('agrees with the head stripe on every page', () => {
    for (const s of parse(JIB + MAIN + DASHES + WHATSAPP).scans) {
      const c = sailVisionTwistCheck(s)
      expect(c.ok, `${s.imageName}: ${c.reportedDeg} vs ${c.accumulatedDeg}`).toBe(true)
    }
  })

  it('CATCHES a dropped stripe row, which is otherwise invisible', () => {
    // The whole point. Remove one stripe and the table still looks like a
    // table; only the arithmetic notices.
    const short = MAIN.replace('Stripe 3 33.17% 11.60% 39.96 deg 18.37 deg\n', '')
    const s = parse(short).scans[0]
    expect(s.stripes).toHaveLength(3)
    expect(sailVisionTwistCheck(s).ok).toBe(false)
  })

  it('a four-stripe main that loses a row becomes a PLAUSIBLE three-stripe one', () => {
    // Worth stating, because it is the trap: 3 is a count we have a ladder for,
    // so the stripes come out at 25/50/75 and nothing about the table looks
    // wrong. Only the arithmetic above catches it. This is why the twist total
    // is read and checked rather than recomputed and trusted.
    const short = MAIN.replace('Stripe 3 33.17% 11.60% 39.96 deg 18.37 deg\n', '')
    expect(parse(short).scans[0].stripes.map((x) => x.pos)).toEqual([25, 50, 75])
    expect(parse(short).scans[0].posFromConvention).toBe(true)
    expect(sailVisionTwistCheck(parse(short).scans[0]).ok).toBe(false)
  })

  it('falls back to the stripe INDEX when the count has no ladder', () => {
    // Two stripes is not a sail anybody strips; five would be a different sail.
    // Inventing a ladder is how numbers that are not comparable come to be
    // plotted as though they were.
    const two = MAIN
      .replace('Stripe 3 33.17% 11.60% 39.96 deg 18.37 deg\n', '')
      .replace('Stripe 4 32.13% 10.33% 37.65 deg 12.55 deg\n', '')
    const s = parse(two).scans[0]
    expect(s.stripes).toHaveLength(2)
    expect(s.stripes.map((x) => x.pos)).toEqual([1, 2])
    expect(s.posFromConvention).toBe(false)
  })
})

describe('Sail Vision — the instruments are NOT imported', () => {
  it('leaves wind and angle null even though the page prints them', () => {
    // The log is the instrument record. Leaving tws null is the active choice:
    // tws_kn bands a scan for the per-sail media view, and page 17 prints
    // "Boat speed 8.6 kn Wind strength 0.0 kn".
    const s = parse(WHATSAPP).scans[0]
    expect(s.tws).toBeNull()
    expect(s.twa).toBeNull()
    expect(s.bsp).toBeNull()
    expect(s.jibTackT).toBeNull()
    expect(s.forestayT).toBeNull()
  })

  it('still reads the total twist, which is shape and not an instrument', () => {
    expect(parse(JIB).scans[0].twistTotalDeg).toBe(14.59)
    expect(parse(DASHES).scans[0].twistTotalDeg).toBe(-19.91)
  })
})

describe('Sail Vision — notes and clocks', () => {
  it('keeps multi-line trim notes verbatim', () => {
    expect(parse(JIB).scans[0].notes)
      .toBe('Inhauler car position: 1.5\neye up/down: 1\n1st spreader 1\n2nd spreader: 1.3')
  })

  it('treats "None recorded" as no notes', () => {
    expect(parse(MAIN).scans[0].notes).toBeNull()
  })

  it('reads the stamp as VENUE-LOCAL and converts it', () => {
    // 09:51 BST is 08:51 UTC. Read as the Med default it would be 07:51 and
    // every scan would sit an hour from the log rows it belongs beside.
    const s = parse(JIB).scans[0]
    expect(s.capturedLocal).toBe('2026-10-11T09:51:00')
    expect(s.capturedAt).toBe('2026-10-11T08:51:00.000Z')
  })

  it('summarises the deepest stripe', () => {
    const s = parse(JIB).scans[0]
    expect(s.summary.maxCamberPct).toBe(16.6)
    expect(s.summary.draftPositionPct).toBe(35.43)
  })
})

describe('scanIdentityKey — recognising a scan that is already stored', () => {
  it('matches the SAME INSTANT however it is spelt', () => {
    // This is the whole point. The parser makes "….000Z"; PostgREST hands a
    // timestamptz back as "…+00:00". Compared as text they never match, so the
    // importer's duplicate check silently stopped working and a backfill
    // reported twenty scans "not found" while they sat in the table.
    const mine = scanIdentityKey('IMG_6456.JPEG', '2026-10-11T08:51:00.000Z')
    for (const stored of [
      '2026-10-11T08:51:00+00:00',
      '2026-10-11 08:51:00+00',
      '2026-10-11T08:51:00Z',
    ]) {
      expect(scanIdentityKey('IMG_6456.JPEG', stored), stored).toBe(mine)
    }
  })

  it('still tells two different pages apart', () => {
    const a = scanIdentityKey('IMG_6456.JPEG', '2026-10-11T08:51:00Z')
    expect(scanIdentityKey('IMG_6455.JPEG', '2026-10-11T08:51:00Z')).not.toBe(a)
    expect(scanIdentityKey('IMG_6456.JPEG', '2026-10-11T08:50:00Z')).not.toBe(a)
  })

  it('keeps an unparseable time as text rather than collapsing them together', () => {
    // Two rows with different nonsense must not look like the same scan.
    expect(scanIdentityKey('a.jpg', 'not a time')).not.toBe(scanIdentityKey('a.jpg', 'also not'))
    expect(scanIdentityKey('a.jpg', null)).toBe('a.jpg|')
  })

  it('copes with a file name full of spaces and brackets', () => {
    const n = 'WhatsApp Image 2026-10-10 at 4.40.43 PM (1).jpeg'
    expect(scanIdentityKey(n, '2026-10-10T08:42:00.000Z'))
      .toBe(scanIdentityKey(n, '2026-10-10T08:42:00+00:00'))
  })
})
