'use client'
// src/lib/sailscan.js
// ─────────────────────────────────────────────────────────────────────────────
// SailScan v1 — pure-math helpers for trim-stripe shape analysis.
//
// Given a stripe defined as {luff, leech, mid[]} (image-pixel coordinates),
// fit a natural cubic spline through the points (parameterised in chord-fraction
// space) and extract: chord length, chord angle, draft%, draft position%,
// entry angle, exit angle.
//
// All angles are in degrees, all percentages are 0..100. No React deps.
// ─────────────────────────────────────────────────────────────────────────────

// ── Natural cubic spline ────────────────────────────────────────────────────
// Given n+1 points (xs[i], ys[i]) with xs strictly increasing, returns a
// {yAt(x), dyAt(x)} pair. M_0 = M_n = 0 (natural BC). Solved via Thomas alg.
export function naturalCubicSpline(xs, ys) {
  const n = xs.length - 1;
  if (n < 1) return null;
  const h = new Array(n);
  for (let i = 0; i < n; i++) h[i] = xs[i+1] - xs[i];
  const M = new Array(n + 1).fill(0);
  if (n >= 2) {
    const sz = n - 1;
    const sub  = new Array(sz);
    const diag = new Array(sz);
    const sup  = new Array(sz);
    const rhs  = new Array(sz);
    for (let i = 1; i < n; i++) {
      const k = i - 1;
      sub[k]  = h[i-1];
      diag[k] = 2 * (h[i-1] + h[i]);
      sup[k]  = h[i];
      rhs[k]  = 6 * ((ys[i+1] - ys[i]) / h[i] - (ys[i] - ys[i-1]) / h[i-1]);
    }
    for (let k = 1; k < sz; k++) {
      const f = sub[k] / diag[k-1];
      diag[k] -= f * sup[k-1];
      rhs[k]  -= f * rhs[k-1];
    }
    const Mi = new Array(sz);
    Mi[sz - 1] = rhs[sz - 1] / diag[sz - 1];
    for (let k = sz - 2; k >= 0; k--) {
      Mi[k] = (rhs[k] - sup[k] * Mi[k+1]) / diag[k];
    }
    for (let i = 1; i < n; i++) M[i] = Mi[i - 1];
  }
  const segIdx = (x) => {
    let i = 0;
    while (i < n - 1 && x > xs[i+1]) i++;
    return i;
  };
  return {
    yAt: (x) => {
      const i = segIdx(x);
      const x0 = xs[i], x1 = xs[i+1], y0 = ys[i], y1 = ys[i+1];
      const hi = h[i], M0 = M[i], M1 = M[i+1];
      const A = x1 - x, B = x - x0;
      return (M0 * A*A*A + M1 * B*B*B) / (6 * hi)
           + (y0 / hi - M0 * hi / 6) * A
           + (y1 / hi - M1 * hi / 6) * B;
    },
    dyAt: (x) => {
      const i = segIdx(x);
      const x0 = xs[i], x1 = xs[i+1], y0 = ys[i], y1 = ys[i+1];
      const hi = h[i], M0 = M[i], M1 = M[i+1];
      const A = x1 - x, B = x - x0;
      return -M0 * A*A / (2 * hi) + M1 * B*B / (2 * hi)
           - (y0 / hi - M0 * hi / 6)
           + (y1 / hi - M1 * hi / 6);
    },
  };
}

// ── Stripe geometry ─────────────────────────────────────────────────────────
// All input points are in image-pixel coordinates: x-right, y-DOWN.
// We project midpoints onto a chord-relative frame:
//   t = along-chord fraction (0 at luff, 1 at leech)
//   d = signed perpendicular distance (chord normal); convention below.
//
// For a sail photographed from below looking up, the bellied side of the sail
// curves AWAY from the chord. We use a normal that is the left-hand rotation
// of the chord direction (n = rot90(u)), so positive d ≈ sail belly.
// The user may have placed midpoints on either side; we work with signed d
// throughout and report draft as the largest |d| seen along the spline.

export function projectToChord(point, luff, leech) {
  const dx = leech.x - luff.x, dy = leech.y - luff.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return { t: 0, d: 0, len };
  const ux = dx / len, uy = dy / len;
  const nx = -uy,      ny =  ux;            // 90° left-hand rotation
  const px = point.x - luff.x;
  const py = point.y - luff.y;
  return {
    t: (px * ux + py * uy) / len,
    d: (px * nx + py * ny),
    len,
  };
}

export function unprojectFromChord(t, d, luff, leech) {
  const dx = leech.x - luff.x, dy = leech.y - luff.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return { ...luff };
  const ux = dx / len, uy = dy / len;
  const nx = -uy,      ny =  ux;
  const along = t * len;
  return { x: luff.x + along * ux + d * nx, y: luff.y + along * uy + d * ny };
}

// ── Per-stripe metrics ──────────────────────────────────────────────────────
// stripe shape: { luff: {x,y}, leech: {x,y}, mid: [{x,y}, ...] }
// returns: { hasCurve, chordLen, chordAngleDeg, draftPct, draftPositionPct,
//           draftSign, entryAngleDeg, exitAngleDeg, samples: [{t,d}], maxDraft }
//
// Notes on angles:
//   - chordAngleDeg = angle of (leech-luff) vector in image space, where +x is
//     right and +y is DOWN. Useful as a stripe-to-stripe twist reference.
//   - entryAngleDeg / exitAngleDeg = angle of the spline tangent at the
//     respective endpoint, measured relative to the chord (radians of
//     rise-over-run where run is along-chord, rise is perpendicular).
//     Both reported with sign retained (positive = curving toward the
//     measured-draft side at that endpoint).
export function computeStripeMetrics(stripe) {
  if (!stripe || !stripe.luff || !stripe.leech) return null;
  const { luff, leech, mid = [] } = stripe;
  const dx = leech.x - luff.x, dy = leech.y - luff.y;
  const chordLen = Math.hypot(dx, dy);
  if (chordLen < 1e-3) return null;
  const chordAngleDeg = Math.atan2(dy, dx) * 180 / Math.PI;

  // Project mids; keep only those strictly inside chord range (clamp tolerance).
  const proj = mid
    .map(p => projectToChord(p, luff, leech))
    .filter(p => p.t > 0.001 && p.t < 0.999)
    .sort((a, b) => a.t - b.t);

  // Need at least one interior point for a curve.
  if (proj.length === 0) {
    return {
      hasCurve: false,
      chordLen, chordAngleDeg,
      draftPct: 0, draftPositionPct: 50, draftSign: 0, maxDraft: 0,
      entryAngleDeg: 0, exitAngleDeg: 0,
      foreCamberPct: 0, backCamberPct: 0,
      samples: [{t: 0, d: 0}, {t: 1, d: 0}],
    };
  }

  // Build interpolation knots: pin endpoints at d=0, interpolate through mids.
  const ts = [0, ...proj.map(p => p.t), 1];
  const ds = [0, ...proj.map(p => p.d), 0];
  const spl = naturalCubicSpline(ts, ds);

  // Dense sampling for max-draft search and overlay rendering.
  const N = 200;
  const samples = new Array(N + 1);
  let maxAbsD = 0, draftSign = 1, draftT = 0.5;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const d = spl.yAt(t);
    samples[i] = { t, d };
    const ad = Math.abs(d);
    if (ad > maxAbsD) { maxAbsD = ad; draftSign = Math.sign(d) || 1; draftT = t; }
  }

  // Fore/back camber (North's "Front%" / "Back%"): the curve's depth at the
  // 25%- and 75%-chord stations expressed as a % of the max camber depth.
  // Describes entry vs exit fullness; draft-forward sails read high Front%,
  // lower Back%. NOTE: definition matches North's magnitudes to a few %;
  // calibrate the exact stations once we score our spline on North's photo.
  const dAt = (tt) => Math.abs(spl.yAt(tt));
  const foreCamberPct = maxAbsD > 1e-6 ? (dAt(0.25) / maxAbsD) * 100 : 0;
  const backCamberPct = maxAbsD > 1e-6 ? (dAt(0.75) / maxAbsD) * 100 : 0;

  // Slope of d(t) at endpoints; convert to angle relative to chord.
  // d(t) is in pixels; t is dimensionless in [0,1] over a chord of chordLen
  // pixels, so along-chord pixels per t-unit = chordLen.
  // tangent slope (rise/run) = (dd/dt) / chordLen.
  const slopeEntry = spl.dyAt(0);
  const slopeExit  = spl.dyAt(1);
  const entryAngleDeg =  Math.atan(slopeEntry / chordLen) * 180 / Math.PI;
  // Exit-angle convention: angle by which the leech opens AWAY from the chord
  // (so a sail with a "hooked" leech reads negative). The spline slope at t=1
  // is negative on a typical sail (curve descending back to chord), so we
  // negate to make "opening up" positive.
  const exitAngleDeg  = -Math.atan(slopeExit  / chordLen) * 180 / Math.PI;

  return {
    hasCurve: true,
    chordLen, chordAngleDeg,
    draftPct: (maxAbsD / chordLen) * 100,
    draftPositionPct: draftT * 100,
    draftSign, maxDraft: maxAbsD,
    entryAngleDeg, exitAngleDeg,
    foreCamberPct, backCamberPct,
    samples,
  };
}

// ── Inter-stripe twist ──────────────────────────────────────────────────────
// Returns the angular difference (degrees) between two stripes' chord angles,
// normalised to [-90, 90]. Positive = upper stripe rotated clockwise relative
// to lower stripe in image space (i.e. leech of upper opens further toward
// the bow / falls off, depending on convention).
export function computeTwist(stripeA, stripeB) {
  if (!stripeA?.luff || !stripeA?.leech || !stripeB?.luff || !stripeB?.leech) return null;
  const aA = Math.atan2(stripeA.leech.y - stripeA.luff.y, stripeA.leech.x - stripeA.luff.x) * 180 / Math.PI;
  const aB = Math.atan2(stripeB.leech.y - stripeB.luff.y, stripeB.leech.x - stripeB.luff.x) * 180 / Math.PI;
  let d = aA - aB;
  while (d > 90) d -= 180;
  while (d < -90) d += 180;
  return d;
}

// ── Seed stripes from an AI-pipeline result ─────────────────────────────────
// The box pipeline (Hugo's analyze_sail) exports, per photo, a JSON of the form
//   { image, width, height, stripes: [ { luff:[x,y], leech:[x,y],
//       interior: [[x,y] near max curvature, [x,y] second], metrics:{...} } ] }
// Convert that into the {luff, leech, mid[]} stripes the SailScan tab edits, so
// the user gets AI-placed control points they can then drag (2 ends + 2 interior).
export function stripesFromAIResult(result) {
  const toP = (a) => (Array.isArray(a) ? { x: a[0], y: a[1] } : null);
  return (result?.stripes || [])
    .map((s) => ({
      luff: toP(s.luff),
      leech: toP(s.leech),
      mid: (s.interior || []).map(toP).filter(Boolean),
      userTaps: [],
    }))
    .filter((s) => s.luff && s.leech);
}

// ── Training-label export ───────────────────────────────────────────────────
// Turn a user-corrected stripe into a label for fine-tuning the keypoint model:
// the two endpoints + N-2 evenly-spaced interior points sampled along the
// fitted spline (default 8 keypoints total, matching Hugo's stripe_keypoints
// model, ordered luff -> leech), plus an enclosing bbox. Coordinates are in
// image-pixel space; the box trainer normalises by image width/height.
export function stripeToLabel(stripe, nKeypoints = 8) {
  const m = computeStripeMetrics(stripe);
  if (!m || !m.hasCurve) return null;
  const poly = splinePolyline(stripe);            // 201 points luff->leech
  if (poly.length < 2) return null;
  const kpts = [];
  for (let k = 0; k < nKeypoints; k++) {
    const idx = Math.round((k / (nKeypoints - 1)) * (poly.length - 1));
    kpts.push([poly[idx].x, poly[idx].y]);
  }
  const xs = poly.map(p => p.x), ys = poly.map(p => p.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const y0 = Math.min(...ys), y1 = Math.max(...ys);
  return {
    luff: [stripe.luff.x, stripe.luff.y],
    leech: [stripe.leech.x, stripe.leech.y],
    keypoints: kpts,                              // [[x,y] x nKeypoints]
    bbox: [x0, y0, x1, y1],
    metrics: {
      camberPct: m.draftPct, draftPositionPct: m.draftPositionPct,
      entryAngleDeg: m.entryAngleDeg, exitAngleDeg: m.exitAngleDeg,
      foreCamberPct: m.foreCamberPct, backCamberPct: m.backCamberPct,
    },
  };
}

// Build the full per-image label object for export/download.
export function buildLabelExport(stripes, { image, width, height } = {}) {
  return {
    image: image || 'sail',
    width: width || null,
    height: height || null,
    stripes: stripes
      .map(s => stripeToLabel(s))
      .filter(Boolean),
  };
}

// ── Helper for overlay rendering ────────────────────────────────────────────
// Returns an array of image-pixel {x,y} points along the fitted spline,
// suitable for stroking with ctx.lineTo() in the canvas overlay.
export function splinePolyline(stripe) {
  const m = computeStripeMetrics(stripe);
  if (!m || !m.hasCurve) return [];
  const out = new Array(m.samples.length);
  for (let i = 0; i < m.samples.length; i++) {
    out[i] = unprojectFromChord(m.samples[i].t, m.samples[i].d, stripe.luff, stripe.leech);
  }
  return out;
}
