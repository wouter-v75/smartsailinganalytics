'use client'
// src/components/analytics/PctLegend.jsx
// ─────────────────────────────────────────────────────────────────────────────
// The key to the VMG% / BSP_trg% / %Pol colour scale (lib/pctScale).
//
// It exists because the one thing about that scale nobody can guess is which
// END is good: "dark green is better than light green" is a convention, not a
// fact about colour, and on a dark UI the dark end is the quieter one, which
// argues the opposite. Anyone but the person who chose the stops needs telling.
//
// Drawn as a GRADIENT BAR rather than six chips, because the scale interpolates
// — a row of chips would say it has six values. The ticks sit under the numbers
// that were actually specified, so the plateau either side of 100 is visible as
// a flat stretch rather than described in words.
// ─────────────────────────────────────────────────────────────────────────────

import React from 'react'
import { pctColour } from '../../lib/pctScale'

// Sampled from the real function, so the bar cannot drift from the cells it
// explains — there is no second copy of the stops here to fall out of date.
const SAMPLES = Array.from({ length: 36 }, (_, i) => 80 + i)
const GRADIENT = `linear-gradient(to right, ${SAMPLES.map(
  (v, i) => `${pctColour(v)} ${((i / (SAMPLES.length - 1)) * 100).toFixed(1)}%`,
).join(', ')})`

const TICKS = [85, 90, 95, 100, 105, 110]
const at = v => ((v - 80) / 35) * 100

export default function PctLegend({ label = 'VMG% · BSP_trg% · %Pol' }) {
  return (
    <div style={{ margin: '2px 0 12px', maxWidth: 340 }}>
      <div style={{ fontSize: 9, color: '#64748B', marginBottom: 4, letterSpacing: '.03em' }}>{label}</div>
      <div style={{ height: 9, borderRadius: 3, background: GRADIENT, border: '1px solid #1E3A5A' }} />
      <div style={{ position: 'relative', height: 12, fontSize: 9, color: '#64748B' }}>
        {TICKS.map(v => (
          <span key={v} style={{ position: 'absolute', left: `${at(v)}%`, transform: 'translateX(-50%)', top: 1 }}>
            {v}
          </span>
        ))}
      </div>
      {/* The sentence the bar cannot say on its own. */}
      <div style={{ fontSize: 9, color: '#475569', lineHeight: 1.45 }}>
        % of target — 100 is on it. Pale green either side of 100 is the band where
        ordinary variation lives; deeper green is faster, red is slower.
      </div>
    </div>
  )
}
