'use client';
// src/lib/sailscan-bench.ts
// ─────────────────────────────────────────────────────────────────────────────
// SailScan v2 — benchmark utilities (Phase F2).
//
// Compares this app's stripe metrics against the ground-truth dataset built
// from sailscan.thesailcloud.com PDF reports + paired photos. The reference
// JSON is bundled at /public/sailscan-ground-truth.json and fetched at
// runtime; lookup is by photo filename (e.g. "IMG_0316.JPG").
//
// Mapping conventions:
//   - The reference uses positions "25" / "50" / "75" where 25 = top of the
//     sail (near head), 75 = bottom (near foot). The user's stripes are
//     mapped by sorting them top-to-bottom by chord-midpoint y-coordinate
//     in image space (smaller y = higher on the sail = position "25").
//   - Reference's "Camber [%]" maps to our `draftPct`.
//   - Reference's "Draft [%]" maps to our `draftPositionPct`.
//   - Reference's "Twist [°]" is at the same position; we don't currently
//     compute per-position twist (only inter-stripe), so we approximate.
//   - Reference's "Entry Angle [°]" / "Exit Angle [°]" map directly to our
//     `entryAngleDeg` / `exitAngleDeg`.
//   - "Fore Camber [%]" / "Back Camber [%]" don't have direct equivalents
//     in our metrics yet — we surface them as "reference only" so the user
//     can see them but no error is computed.
// ─────────────────────────────────────────────────────────────────────────────

const GT_URL = '/sailscan-ground-truth.json';

export type StripePos = '25' | '50' | '75';

export interface ReferenceMetrics {
  camberPct:     Record<StripePos, number>; // = our draftPct
  draftPct:      Record<StripePos, number>; // = our draftPositionPct
  twistDeg:      Record<StripePos, number>; // inter-stripe twist (per position)
  foreCamberPct: Record<StripePos, number>; // reference only
  backCamberPct: Record<StripePos, number>; // reference only
  entryAngleDeg: Record<StripePos, number>;
  exitAngleDeg:  Record<StripePos, number>;
}

export interface ReferenceSession {
  folder: string;
  folderSignature: Record<string, any>;
  photos: string[];
  metrics: ReferenceMetrics;
}

export interface GroundTruth {
  sessionCount: number;
  stripePositions: Record<StripePos, string>;
  sessions: ReferenceSession[];
}

let _gtPromise: Promise<GroundTruth | null> | null = null;

/** Fetch the ground-truth JSON once, cached. Returns null on 404 / parse fail
 *  so callers can render the rest of the UI without breaking. */
export function loadGroundTruth(): Promise<GroundTruth | null> {
  if (_gtPromise) return _gtPromise;
  _gtPromise = (async () => {
    try {
      const r = await fetch(GT_URL, { cache: 'force-cache' });
      if (!r.ok) return null;
      return await r.json() as GroundTruth;
    } catch {
      return null;
    }
  })();
  return _gtPromise;
}

/** Match an uploaded photo by filename to a reference session. Case-insensitive
 *  exact match on the filename's basename. Returns the session if found. */
export function findSessionByFilename(gt: GroundTruth, filename: string): ReferenceSession | null {
  const base = filename.split('/').pop()?.toLowerCase() ?? '';
  for (const s of gt.sessions) {
    if (s.photos.some(p => p.toLowerCase() === base)) return s;
  }
  return null;
}

// ── Stripe-side comparison ──────────────────────────────────────────────────

interface UserStripe {
  /** Image-pixel coords of luff & leech (used to compute mid y for sorting). */
  luff: { x: number; y: number } | null;
  leech: { x: number; y: number } | null;
}

interface UserMetrics {
  draftPct: number;          // = reference camber
  draftPositionPct: number;  // = reference draft
  entryAngleDeg: number;
  exitAngleDeg: number;
}

export interface StripeError {
  pos: StripePos;
  ours:      Partial<Record<keyof UserMetrics, number>>;
  reference: { camberPct: number; draftPct: number; entryAngleDeg: number; exitAngleDeg: number };
  errors:    { camberPct: number; draftPositionPct: number; entryAngleDeg: number; exitAngleDeg: number };
}

export interface BenchmarkReport {
  matchedSession: string;
  matchedPhoto:   string;
  perStripe: StripeError[];
  meanAbsErrors: { camberPct: number; draftPositionPct: number; entryAngleDeg: number; exitAngleDeg: number };
  /** Reference-only metrics that we don't currently compute. */
  referenceOnly: { foreCamberPct: Record<StripePos, number>; backCamberPct: Record<StripePos, number> };
}

/** Map the user's stripes (1-3 of them) to the reference positions 25/50/75
 *  by sorting top-to-bottom in image-y. Returns null if zero usable stripes. */
function assignPositions(stripes: { stripe: UserStripe; metrics: UserMetrics }[]): { pos: StripePos; metrics: UserMetrics }[] | null {
  // Filter to stripes with both endpoints
  const usable = stripes
    .filter(s => s.stripe.luff && s.stripe.leech)
    .map(s => ({ ...s, midY: ((s.stripe.luff!.y + s.stripe.leech!.y) / 2) }));
  if (usable.length === 0) return null;
  // Sort by chord-midpoint y; smallest y = topmost (position "25")
  usable.sort((a, b) => a.midY - b.midY);
  // Map by count
  if (usable.length === 1) {
    return [{ pos: '50', metrics: usable[0].metrics }];
  }
  if (usable.length === 2) {
    return [
      { pos: '25', metrics: usable[0].metrics },
      { pos: '75', metrics: usable[1].metrics },
    ];
  }
  // 3 or more: take top, middle, bottom
  const top = usable[0];
  const bot = usable[usable.length - 1];
  const mid = usable[Math.floor(usable.length / 2)];
  return [
    { pos: '25', metrics: top.metrics },
    { pos: '50', metrics: mid.metrics },
    { pos: '75', metrics: bot.metrics },
  ];
}

/** Run the comparison. `ourStripes` is the active stripes from the SailScan
 *  results screen (one per analysed stripe), each with the user's luff/leech
 *  endpoints (used for top-to-bottom ordering) and our computed metrics. */
export function compareToReference(
  session: ReferenceSession,
  photoName: string,
  ourStripes: { stripe: UserStripe; metrics: UserMetrics }[],
): BenchmarkReport | null {
  const assigned = assignPositions(ourStripes);
  if (!assigned) return null;

  const ref = session.metrics;
  const perStripe: StripeError[] = [];
  for (const { pos, metrics: m } of assigned) {
    const refForPos = {
      camberPct:     ref.camberPct?.[pos]     ?? NaN,
      draftPct:      ref.draftPct?.[pos]      ?? NaN,
      entryAngleDeg: ref.entryAngleDeg?.[pos] ?? NaN,
      exitAngleDeg:  ref.exitAngleDeg?.[pos]  ?? NaN,
    };
    perStripe.push({
      pos,
      ours: {
        draftPct:         m.draftPct,
        draftPositionPct: m.draftPositionPct,
        entryAngleDeg:    m.entryAngleDeg,
        exitAngleDeg:     m.exitAngleDeg,
      },
      reference: refForPos,
      errors: {
        camberPct:        m.draftPct         - refForPos.camberPct,
        draftPositionPct: m.draftPositionPct - refForPos.draftPct,
        entryAngleDeg:    m.entryAngleDeg    - refForPos.entryAngleDeg,
        exitAngleDeg:     m.exitAngleDeg     - refForPos.exitAngleDeg,
      },
    });
  }

  // Aggregate mean-absolute errors over the matched stripes.
  const sum = { camberPct: 0, draftPositionPct: 0, entryAngleDeg: 0, exitAngleDeg: 0 };
  for (const s of perStripe) {
    sum.camberPct        += Math.abs(s.errors.camberPct);
    sum.draftPositionPct += Math.abs(s.errors.draftPositionPct);
    sum.entryAngleDeg    += Math.abs(s.errors.entryAngleDeg);
    sum.exitAngleDeg     += Math.abs(s.errors.exitAngleDeg);
  }
  const n = perStripe.length || 1;
  const meanAbsErrors = {
    camberPct:        sum.camberPct        / n,
    draftPositionPct: sum.draftPositionPct / n,
    entryAngleDeg:    sum.entryAngleDeg    / n,
    exitAngleDeg:     sum.exitAngleDeg     / n,
  };

  return {
    matchedSession: session.folder,
    matchedPhoto:   photoName,
    perStripe,
    meanAbsErrors,
    referenceOnly: {
      foreCamberPct: ref.foreCamberPct ?? { '25': NaN, '50': NaN, '75': NaN } as any,
      backCamberPct: ref.backCamberPct ?? { '25': NaN, '50': NaN, '75': NaN } as any,
    },
  };
}
