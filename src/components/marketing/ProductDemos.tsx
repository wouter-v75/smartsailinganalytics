// Glimpses of the product — deliberately partial.
//
// ── WHY THESE ARE FRAGMENTS, NOT DEMOS ─────────────────────────────────────
// A marketing page has to show enough that a coach thinks "I want that", and no
// more. Anything that reads as a specification is now a specification: a
// competitor can hand a screenshot to a model and have a plausible copy the same
// afternoon. The expensive parts of SSA are the wind profile, the phase and
// manoeuvre analysis and the way a day is assembled — none of which anyone needs
// to see working in order to want it.
//
// So each of these is cropped, faded at the edges and stripped of the labels
// that would teach anything: no level counts, no channel maps, no method names,
// no axis scales. What survives is the SHAPE and the impression. The rest is a
// conversation.
//
// ── AND NO REAL DATA ───────────────────────────────────────────────────────
// Every value here is invented. A page whose argument is "measured, not
// claimed" cannot put a customer's performance on the internet to prove it, and
// the captions say so plainly rather than hoping nobody asks.
import React from 'react'

const ACCENT = '#22D3EE'

/** The frame every glimpse sits in, with its honesty note underneath. */
export function DemoFrame({
  label, note, children,
}: { label: string; note: string; children: React.ReactNode }) {
  return (
    <figure className="m-0 overflow-hidden rounded-xl border border-border bg-surface-1">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden="true" />
        <span className="text-[11px] font-bold uppercase tracking-[0.14em] text-muted">{label}</span>
        <span className="ml-auto text-[10px] uppercase tracking-wider text-faint">glimpse</span>
      </div>
      {/* The fade is the point: these read as a corner of a screen, not a screen. */}
      <div className="ssa-demo-fade p-4">{children}</div>
      <figcaption className="border-t border-border px-4 py-2.5 text-[11px] leading-relaxed text-faint">
        {note}
      </figcaption>
    </figure>
  )
}

// ── Wind, with height, over the terrain ────────────────────────────────────
// The real thing renders the wind as a volume at true altitude over the terrain
// map. A flat grid of arrows cannot say that, so this says it the way the tool
// does: three points across the Gulf of St Tropez — one over the Massif des
// Maures, one on the shore, one offshore — each with its own profile rising
// from the ground it stands on.
//
// The shape is honest. Low-level flow is deflected and slowed over high ground
// and cleaner offshore, and it veers with height; that is why a single arrow at
// one height is not an answer. The NUMBERS are invented, there is no scale, and
// the level count is not shown.
//
// St Tropez because that is a venue SSA actually runs a 2 km domain over — see
// src/components/weather/mos/mos_st_tropez.json, which carries its real wind
// sectors (NW mistral, E-SE sea breeze).
export function WindFieldDemo() {
  // Each site: where it stands, how high the ground is, and how its profile
  // behaves. `twist` is how much the wind has already turned at the surface —
  // most over the hills, least offshore.
  // `twist` is a DEFLECTION, never a reversal: terrain turns the surface flow,
  // it does not send it backwards, and an arrow pointing the other way reads as
  // a rendering bug rather than as physics.
  const sites = [
    { x: 118, ground: 150, twist: -24, strength: 0.66, label: 'over the hills' },
    { x: 262, ground: 196, twist: -10, strength: 0.82, label: 'at the shore' },
    { x: 406, ground: 224, twist: 0, strength: 1.00, label: 'offshore' },
  ]
  // Four heights up each column. Higher = longer arrow, closer to the gradient
  // direction, more opaque.
  const heights = [0, 1, 2, 3]

  return (
    <svg viewBox="0 0 500 290" className="w-full" role="img"
      aria-label="Three vertical wind profiles standing over a stylised Gulf of St Tropez: over the hills, at the shore and offshore">
      <defs>
        <marker id="wf-head" markerWidth="5" markerHeight="5" refX="4.2" refY="2.5" orient="auto">
          <path d="M0 0 L5 2.5 L0 5 z" fill={ACCENT} />
        </marker>
        <linearGradient id="wf-sea" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={ACCENT} stopOpacity="0.20" />
          <stop offset="100%" stopColor={ACCENT} stopOpacity="0.02" />
        </linearGradient>
        <linearGradient id="wf-land" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#2B4A63" stopOpacity="0.95" />
          <stop offset="100%" stopColor="#152C41" stopOpacity="0.9" />
        </linearGradient>
        <linearGradient id="wf-land-far" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#24405A" stopOpacity="0.6" />
          <stop offset="100%" stopColor="#16293C" stopOpacity="0.5" />
        </linearGradient>
      </defs>

      {/* The far ridge, then the near one: two layers is all it takes to read as
          depth rather than as a cut-out. */}
      <path d="M0 176 L58 150 L104 132 L150 148 L196 138 L250 164 L300 178 L340 190 L500 196 L500 250 L0 250 Z"
        fill="url(#wf-land-far)" />
      <path d="M0 196 L46 172 L96 154 L142 166 L190 176 L244 196 L292 208 L344 222 L500 228 L500 290 L0 290 Z"
        fill="url(#wf-land)" />

      {/* The gulf, opening to the east. */}
      <path d="M344 222 L500 228 L500 290 L206 290 Z" fill="url(#wf-sea)" />
      {[0, 1, 2].map((i) => (
        <line key={i} x1={250 + i * 22} y1={250 + i * 14} x2={500} y2={244 + i * 15}
          stroke={ACCENT} strokeOpacity={0.13} strokeWidth="1" />
      ))}

      {sites.map((site, si) => (
        <g key={si}>
          {/* The column's mast: where this profile stands. */}
          <line x1={site.x} y1={site.ground} x2={site.x} y2={site.ground - 118}
            stroke="#8FA6B8" strokeOpacity="0.22" strokeDasharray="2 4" />
          <circle cx={site.x} cy={site.ground} r="3" fill={ACCENT} fillOpacity="0.9" />
          <circle cx={site.x} cy={site.ground} r="7" fill="none" stroke={ACCENT} strokeOpacity="0.3" />

          {heights.map((h) => {
            const t = h / (heights.length - 1)
            const y = site.ground - 24 - h * 31
            // Veer toward the gradient direction with height, from whatever the
            // terrain has done to it at the surface.
            const deg = site.twist * (1 - t) + 16 * t
            const a = (deg * Math.PI) / 180
            // A floor on the length: a very short arrow reads as a broken stub,
            // not as light wind.
            const len = (26 + t * 20) * (site.strength * 0.4 + 0.6)
            return (
              <line key={h}
                x1={site.x} y1={y}
                x2={site.x + Math.cos(a) * len} y2={y - Math.sin(a) * len * 0.55}
                stroke={ACCENT} strokeOpacity={0.34 + t * 0.6} strokeWidth={1.2 + t * 0.9}
                markerEnd="url(#wf-head)" />
            )
          })}

          <text x={site.x} y={site.ground + 18} fontSize="9.5" fill="#8FA6B8" opacity="0.7" textAnchor="middle">
            {site.label}
          </text>
        </g>
      ))}

      <text x="20" y="26" fontSize="10.5" fill="#8FA6B8" opacity="0.75">
        Gulf of St Tropez
      </text>
    </svg>
  )
}

// ── A clip, with the boat's state on it ────────────────────────────────────
// Two readouts, not the full set, and the numbers are wrong on purpose. The
// channel list and the tagging vocabulary are part of what makes the product
// worth paying for; they are not decoration for a landing page.
export function OverlayDemo() {
  return (
    <div className="relative overflow-hidden rounded-lg border border-border">
      <div className="relative aspect-[832/464] w-full">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/media/hero-n76-poster.jpg"
          alt="A frame from a clip with two instrument readouts over it"
          className="absolute inset-0 h-full w-full object-cover"
        />
        <div className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-black/70 to-transparent" />

        <div className="absolute bottom-3 left-3 flex gap-2">
          {[{ k: 'TWS', v: '14.6', u: 'kn' }, { k: 'BSP', v: '9.8', u: 'kn' }].map((r) => (
            <div key={r.k} className="rounded-md border border-white/15 bg-black/45 px-2.5 py-1.5 backdrop-blur-sm">
              <div className="text-[9px] font-bold uppercase tracking-wider text-white/55">{r.k}</div>
              <div className="text-[15px] font-bold leading-none text-white">
                {r.v}<span className="ml-0.5 text-[10px] font-normal text-white/60">{r.u}</span>
              </div>
            </div>
          ))}
        </div>

        {/* A scrub bar with one marked moment. That a clip is navigable by what
            happened is the idea; which events are found is not shown. */}
        <div className="absolute inset-x-3 top-3">
          <div className="h-1 w-full rounded-full bg-white/20">
            <div className="h-1 w-[38%] rounded-full bg-accent" />
          </div>
        </div>
        <span className="absolute left-[38%] top-6 h-2.5 w-2.5 -translate-x-1/2 rounded-full border-2 border-accent bg-bg" />
      </div>
    </div>
  )
}

// ── Speed against angle, with the scale taken off ──────────────────────────
// Blanked axes, randomised points, no curve label and no legend. It shows that
// the product plots a season's phases against a target and nothing about what
// the target is or how a phase is found.
export function PolarDemo() {
  // Deterministic pseudo-random: Math.random() would render differently on the
  // server and the client, and React would rightly complain.
  const rnd = (i: number) => (((Math.sin(i * 12.9898) * 43758.5453) % 1) + 1) % 1
  const pts = Array.from({ length: 34 }, (_, i) => {
    const t = i / 33
    return {
      x: 46 + t * 380,
      y: 168 - Math.sin(t * Math.PI) * 100 + (rnd(i) - 0.5) * 30,
      hot: rnd(i + 100) > 0.78,
    }
  })
  const curve = Array.from({ length: 34 }, (_, i) => {
    const t = i / 33
    return `${i === 0 ? 'M' : 'L'}${46 + t * 380},${168 - Math.sin(t * Math.PI) * 100}`
  }).join(' ')

  return (
    <svg viewBox="0 0 460 210" className="w-full" role="img"
      aria-label="A scatter of points against a faint curve, with both axes deliberately unlabelled">
      {[0, 1, 2].map((i) => (
        <line key={i} x1="46" y1={48 + i * 56} x2="426" y2={48 + i * 56}
          stroke="#1E3A5A" strokeWidth="1" strokeDasharray="3 6" />
      ))}
      {/* Ticks with no numbers on them. */}
      {[0, 1, 2, 3].map((i) => (
        <text key={i} x="36" y={52 + i * 42} fontSize="10" fill="#8FA6B8" opacity="0.4" textAnchor="end">—</text>
      ))}
      {[0, 1, 2, 3, 4].map((i) => (
        <text key={i} x={46 + i * 95} y="196" fontSize="10" fill="#8FA6B8" opacity="0.4" textAnchor="middle">—</text>
      ))}

      <path d={curve} fill="none" stroke={ACCENT} strokeOpacity="0.32" strokeWidth="2" strokeDasharray="5 5" />
      {pts.map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r={p.hot ? 3.6 : 2.6}
          fill={p.hot ? ACCENT : '#8FA6B8'} fillOpacity={p.hot ? 0.9 : 0.4} />
      ))}
    </svg>
  )
}
