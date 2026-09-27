'use client'
// src/components/photos/SailGeometryCard.tsx
// ─────────────────────────────────────────────────────────────────────────────
// The astern measurements as they appear under a photograph: each leech height,
// the clew and the boom in millimetres from the mast axis, each with its sigma,
// plus what the numbers are measured FROM and whether the misalignment was
// measured or assumed.
//
// Shared by the Photos tab and the timeline, so one photo reads the same way
// wherever you reach it.
//
// On the sign: when the tack is known the numbers are LEEWARD POSITIVE, so a
// boom or a main leech above the centreline reads negative and the same trim
// reads the same on either tack. Without a tack the sign would only say which
// way round the photograph is, so it is not shown at all — see `formatMm`.
// ─────────────────────────────────────────────────────────────────────────────

import React from 'react'
import { formatMm, type SailTrimAnnotation, type AnnotationTarget } from '../../lib/sailTrimOverlay'

const label = (t: AnnotationTarget) =>
  t.label.replace(/^Jib /, '').replace(/ @ reference height$/, ' @ ref')

export default function SailGeometryCard({
  annotation,
  overlayOn = false,
  onToggleOverlay = null,
  onRemeasure = null,
  compact = false,
}: {
  annotation: SailTrimAnnotation
  overlayOn?: boolean
  onToggleOverlay?: (() => void) | null
  onRemeasure?: (() => void) | null
  compact?: boolean
}) {
  if (!annotation?.targets?.length) return null
  const cols = Math.max(1, Math.min(3, annotation.targets.length))
  return (
    <div style={{ background: '#0A1929', border: '1px solid #38BDF840', borderRadius: 8, padding: compact ? '8px 11px' : '10px 14px', marginBottom: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8, gap: 8 }}>
        <div style={{ fontSize: 9, color: '#38BDF8', letterSpacing: 2, textTransform: 'uppercase' }}>📐 Sail geometry</div>
        <div style={{ fontSize: 8, color: '#8A97A9', fontFamily: 'monospace' }}>{annotation.version}</div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cols},1fr)`, gap: 8 }}>
        {annotation.targets.map((t) => (
          <div key={t.key} style={{ background: '#071624', borderRadius: 6, padding: '7px 8px', border: `1px solid ${t.colour}20`, textAlign: 'center' }}>
            <div style={{ fontSize: 8, color: '#4E5D71', marginBottom: 2 }}>{label(t)}</div>
            <div style={{ fontSize: 14, fontWeight: 700, color: t.colour, fontFamily: 'monospace' }}>
              {formatMm(annotation, t.mm)}<span style={{ fontSize: 8, marginLeft: 1 }}>mm</span>
            </div>
            <div style={{ fontSize: 8, color: '#64748B', fontFamily: 'monospace' }}>±{Math.round(t.sigmaMm)}</div>
          </div>
        ))}
      </div>
      {/* SHAPE. The millimetres above say where the leech is; this says what the
          sail is doing — chord angle per stripe and the twist between them.
          Present once a certificate has been read, because its sail widths are
          the denominator. */}
      {/* THE BOX IS ALWAYS HERE, even with nothing in it.
          It used to render only when there was a twist or a chord to show, so a
          measurement saved before the boat's sail widths were known looked
          exactly like a tool with no twist in it — and the remedy, which is to
          reopen and save again, was nowhere on screen. Dashes and a reason. */}
      {(() => {
        const anyShape = !!(annotation.twist?.length || annotation.chords?.length)
        return (
        <div style={{ marginTop: 9, paddingTop: 8, borderTop: '1px solid #16304A' }} data-testid="sailgeom-twist">
          <div style={{ fontSize: 9, color: '#4ADE80', letterSpacing: 1.5, textTransform: 'uppercase', marginBottom: 5 }}>
            Twist
          </div>
          {!anyShape && (
            <div style={{ fontSize: 9.5, color: '#FCD34D', marginBottom: 5, lineHeight: 1.45 }}>
              Not computed when this was saved — the boat&rsquo;s sail widths are the
              denominator a leech offset is divided by to become an angle, and they were
              not known then. <b>Reopen it in SailTrim and save again</b> and the numbers
              will be here; the marks are all still on the frame.
            </div>
          )}
          {/* Same table as the SailTrim panel: station down the side, sail
              across the top, each with its own accuracy. The two are different
              components and drifted apart once already — the panel got the
              table and this card kept the old per-sail list, which is why it
              looked like the new format had not shipped. */}
          {(() => {
            const chords = annotation.chords || []
            const cell = (sail: string, tag: string) =>
              chords.find((c) => c.sail === sail && c.tag === tag) || null
            // Depth, solved across SEVERAL frames and stored on each of them —
            // no single frame can produce it. An arrow means the dots never
            // reached the deepest part, so it is extrapolated and reads low.
            const draft = (sail: string, tag: string) => {
              const c = (annotation.camber || []).find((x) => x.sail === sail && x.tag === tag)
              return c ? `${c.camberPct.toFixed(1)} %${c.reachedPeak ? '' : '\u2193'}` : '\u2014'
            }
            const th: React.CSSProperties = { fontSize: 8.5, color: '#4E5D71', fontWeight: 700, textAlign: 'right', padding: '0 0 3px 7px', whiteSpace: 'nowrap' }
            const td: React.CSSProperties = { fontSize: 11.5, fontWeight: 700, color: '#E2E8F0', fontFamily: 'monospace', textAlign: 'right', padding: '2px 0 2px 7px' }
            const tdSig: React.CSSProperties = { ...td, fontSize: 10, fontWeight: 600, color: '#64748B' }
            const ROWS = [
              { key: 'stripe87', short: '87.5 %' }, { key: 'stripe75', short: '75 %' },
              { key: 'stripe50', short: '50 %' }, { key: 'stripe25', short: '25 %' },
              { key: 'clew', short: 'clew' },
            ]
            return (
              <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 5 }}>
                <thead>
                  <tr>
                    <th style={{ ...th, textAlign: 'left', paddingLeft: 0 }}>Stripe</th>
                    <th style={th}>Twist Main</th>
                    <th style={th}>Twist Jib</th>
                    <th style={th}>Draft Main</th>
                    <th style={th}>Draft jib</th>
                    <th style={th}>Accuracy Main</th>
                    <th style={th}>Accuracy jib</th>
                  </tr>
                </thead>
                <tbody>
                  {ROWS.map((r) => {
                    const m = cell('main', r.key), j = cell('jib', r.key)
                    return (
                      <tr key={r.key} style={{ borderTop: '1px solid #123253' }}>
                        <td style={{ fontSize: 10.5, color: '#94A3B8', padding: '2px 0' }}>{r.short}</td>
                        <td style={td}>{m ? `${m.angleDeg.toFixed(1)}°${m.widthSource === 'interpolated' ? '*' : ''}` : '—'}</td>
                        <td style={td}>{j ? `${j.angleDeg.toFixed(1)}°${j.widthSource === 'interpolated' ? '*' : ''}` : '—'}</td>
                        <td style={td}>{draft('main', r.key)}</td>
                        <td style={td}>{draft('jib', r.key)}</td>
                        <td style={tdSig}>{m ? `± ${m.angleSigmaDeg.toFixed(2)}` : '—'}</td>
                        <td style={tdSig}>{j ? `± ${j.angleSigmaDeg.toFixed(2)}` : '—'}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )
          })()}

          {(annotation.camber || []).length > 0 && (
            <div style={{ fontSize: 10, color: '#86EFAC', marginBottom: 3, lineHeight: 1.45 }}>
              Draft solved across {annotation.camber![0].frames} frames spanning{' '}
              {annotation.camber![0].baselineDeg.toFixed(1)}°, residual{' '}
              {annotation.camber![0].rmsMm.toFixed(0)} mm — this frame is one of them.
            </div>
          )}

          {/* The twist BETWEEN stations — what the columns are made of. */}
          {(['main', 'jib'] as const).map((sail) => {
            const rows = (annotation.twist || []).filter((w) => w.sail === sail)
            if (!rows.length) return null
            return (
              <div key={`rows-${sail}`} style={{ fontSize: 10, color: '#94A3B8', fontFamily: 'monospace', marginBottom: 2 }}>
                <span style={{ textTransform: 'capitalize' }}>{sail}</span>:{' '}
                {rows.map((w) => `${w.from.replace('stripe', '')}→${w.to.replace('stripe', '')} ${w.twistDeg >= 0 ? '+' : ''}${w.twistDeg.toFixed(2)}°`).join(' · ')}
              </div>
            )
          })}

          {/* Sag, and the unmarked luff it stands in for. */}
          {(['main', 'jib'] as const).map((sail) => {
            const chords = (annotation.chords || []).filter((c) => c.sail === sail)
            const sag = chords.filter((c) => c.luffMm != null)
            if (!chords.length) return null
            return (
              <div key={`sag-${sail}`}>
                {sag.length > 0 && (
                  <div style={{ fontSize: 10, color: '#86EFAC', fontFamily: 'monospace', marginTop: 1 }}>
                    <span style={{ textTransform: 'capitalize' }}>{sail}</span>{' '}
                    {sail === 'jib' ? 'forestay sag' : 'luff off centreplane'}:{' '}
                    {sag.map((c) => `${(c.fraction * 100).toFixed(0)}% ${Math.round(Math.abs(c.luffMm as number))}${c.luffSource === 'fitted' ? '†' : ''}`).join(' · ')} mm
                  </div>
                )}
                {sag.length === 0 && (
                  <div style={{ fontSize: 9.5, color: '#FCD34D', marginTop: 1, lineHeight: 1.4 }}>
                    <span style={{ textTransform: 'capitalize' }}>{sail}</span>: luff not marked — chord taken from the centreplane
                    {sail === 'jib' ? ', i.e. a straight forestay. ~0.29° of twist per 100 mm it is not.' : ''}
                  </div>
                )}
              </div>
            )
          })}
        </div>
        )
      })()}

      <div style={{ marginTop: 7, fontSize: 9, color: '#64748B', lineHeight: 1.5 }}>
        {annotation.defn === 'world' ? 'World-horizontal' : 'Athwartships'} from the centreplane ·{' '}
        <span style={{ color: annotation.psiMeasured ? '#4ADE80' : '#FCD34D' }}>
          ψ {annotation.psiDeg.toFixed(2)}° {annotation.psiMeasured ? 'measured' : 'assumed'}
        </span>
        {annotation.heelDeg != null && <> · heel {annotation.heelDeg.toFixed(1)}°</>}
        {annotation.leewardPositive
          ? <> · {annotation.tack === 'stbd' ? 'stbd' : 'port'} tack, <b style={{ color: '#94A3B8' }}>leeward positive</b></>
          : <> · <span style={{ color: '#FCD34D' }}>unsigned — no tack</span></>}
      </div>
      {(onToggleOverlay || onRemeasure) && (
        <div style={{ marginTop: 8, display: 'flex', gap: 7, flexWrap: 'wrap' }}>
          {onToggleOverlay && (
            <button onClick={onToggleOverlay}
              style={{ background: overlayOn ? '#38BDF820' : 'none', border: '1px solid #38BDF840', borderRadius: 6, padding: '5px 10px', color: '#38BDF8', cursor: 'pointer', fontSize: 10, fontWeight: 600 }}>
              {overlayOn ? '✓ lines on the photo' : 'Draw lines on the photo'}
            </button>
          )}
          {onRemeasure && (
            <button onClick={onRemeasure}
              style={{ background: 'none', border: '1px solid #1E3A5A', borderRadius: 6, padding: '5px 10px', color: '#94A3B8', cursor: 'pointer', fontSize: 10 }}>
              Edit points…
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/** The offer to measure a photo nobody has measured yet. */
export function MeasureGeometryButton({ onClick, compact = false }: {
  onClick?: (() => void) | null
  compact?: boolean
}) {
  if (!onClick) return null
  return (
    <button onClick={onClick}
      style={{ width: '100%', background: '#0A1929', border: '1px solid #38BDF840', borderRadius: 8, padding: compact ? '8px 0' : '10px 0', color: '#38BDF8', fontWeight: 700, cursor: 'pointer', fontSize: 12, marginBottom: 10 }}>
      📐 Analyse sail geometry
    </button>
  )
}
