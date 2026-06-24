'use client';
// src/components/SailScanReportTable.tsx
// ─────────────────────────────────────────────────────────────────────────────
// North-Sails-format readout for SailScan stripes.
//
// Columns mirror the North Sails app report: Stripe | Draft | Camber | Entry |
// Exit | Front% | Back%, plus a Twist column (which North omits but we keep).
// Pure presentational: give it the same Stripe[] the SailScan tab edits and it
// recomputes live as the user drags points.
// ─────────────────────────────────────────────────────────────────────────────

import React from 'react';
import { computeStripeMetrics, computeTwist } from '../lib/sailscan';

interface P { x: number; y: number; }
export interface Stripe { luff: P | null; leech: P | null; mid: P[]; }

interface Row {
  label: string;
  draft: number | null;
  camber: number | null;
  entry: number | null;
  exit: number | null;
  front: number | null;
  back: number | null;
  twist: number | null;
}

// Stripe height label: North uses 25% (head) … 75% (foot), top→bottom.
function heightLabels(n: number): string[] {
  if (n === 3) return ['25%', '50%', '75%'];
  if (n === 1) return ['50%'];
  return Array.from({ length: n }, (_, i) =>
    `${Math.round((25 + (50 * i) / Math.max(1, n - 1)))}%`);
}

export function buildRows(stripes: Stripe[]): Row[] {
  // order top → bottom by mean y (smaller y = higher up = head)
  const withY = stripes
    .map((s, i) => ({ s, i, y: meanY(s) }))
    .filter(o => o.y !== null)
    .sort((a, b) => (a.y as number) - (b.y as number));
  const labels = heightLabels(withY.length);

  return withY.map((o, k) => {
    const m = computeStripeMetrics(o.s as any);
    // twist relative to the foot (lowest) stripe as reference
    const ref = withY[withY.length - 1].s;
    const tw = (o.s !== ref) ? computeTwist(o.s as any, ref as any) : 0;
    return {
      label: labels[k],
      draft: m?.draftPositionPct ?? null,
      camber: m?.draftPct ?? null,
      entry: m?.entryAngleDeg ?? null,
      exit: m?.exitAngleDeg ?? null,
      front: m?.foreCamberPct ?? null,
      back: m?.backCamberPct ?? null,
      twist: tw,
    };
  });
}

function meanY(s: Stripe): number | null {
  if (!s.luff || !s.leech) return null;
  return (s.luff.y + s.leech.y) / 2;
}

const fmt = (v: number | null, d = 1) =>
  v === null || Number.isNaN(v) ? '—' : v.toFixed(d);

export default function SailScanReportTable({
  stripes, tws, sailName, imageName, imageTime,
}: {
  stripes: Stripe[];
  tws?: number | string;
  sailName?: string;
  imageName?: string;
  imageTime?: string;
}) {
  const rows = buildRows(stripes);
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900/60 p-4 text-slate-100">
      {(sailName || imageName) && (
        <div className="mb-2 text-sm text-slate-300">
          {sailName && <span className="font-semibold">Sail: {sailName}</span>}
          {imageName && <span className="ml-3 text-slate-400">{imageName}</span>}
          {imageTime && <span className="ml-3 text-slate-400">{imageTime}</span>}
        </div>
      )}
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="text-left text-slate-300">
            <th className="px-2 py-1">Stripe</th>
            <th className="px-2 py-1">Draft</th>
            <th className="px-2 py-1">Camber</th>
            <th className="px-2 py-1">Entry</th>
            <th className="px-2 py-1">Exit</th>
            <th className="px-2 py-1">Front%</th>
            <th className="px-2 py-1">Back%</th>
            <th className="px-2 py-1">Twist</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className={i % 2 ? 'bg-slate-800/40' : ''}>
              <td className="px-2 py-1 font-medium">{r.label}</td>
              <td className="px-2 py-1">{fmt(r.draft, 1)}</td>
              <td className="px-2 py-1">{fmt(r.camber, 1)}</td>
              <td className="px-2 py-1">{fmt(r.entry, 0)}</td>
              <td className="px-2 py-1">{fmt(r.exit, 0)}</td>
              <td className="px-2 py-1">{fmt(r.front, 1)}</td>
              <td className="px-2 py-1">{fmt(r.back, 1)}</td>
              <td className="px-2 py-1">{i === rows.length - 1 ? '—' : fmt(r.twist, 1)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {tws !== undefined && tws !== '' && (
        <div className="mt-2 inline-flex items-center gap-2 rounded border border-slate-600 px-2 py-1 text-sm">
          <span className="text-slate-400">TWS</span>
          <span className="font-semibold">{tws}</span>
        </div>
      )}
    </div>
  );
}
