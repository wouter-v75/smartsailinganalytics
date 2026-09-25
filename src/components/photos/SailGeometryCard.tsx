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
      {(annotation.twist?.length || annotation.chords?.length) ? (
        <div style={{ marginTop: 9, paddingTop: 8, borderTop: '1px solid #16304A' }}>
          <div style={{ fontSize: 9, color: '#4ADE80', letterSpacing: 1.5, textTransform: 'uppercase', marginBottom: 5 }}>
            Twist
          </div>
          {(['main', 'jib'] as const).map((sail) => {
            const rows = (annotation.twist || []).filter((w) => w.sail === sail)
            const chords = (annotation.chords || []).filter((c) => c.sail === sail)
            if (!rows.length && !chords.length) return null
            const sag = chords.filter((c) => c.luffMm != null)
            return (
              <div key={sail} style={{ marginBottom: 6 }}>
                <div style={{ fontSize: 10, color: '#94A3B8', textTransform: 'capitalize', marginBottom: 2 }}>{sail}</div>
                {chords.map((c) => (
                  <div key={c.tag} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#64748B', fontFamily: 'monospace' }}>
                    <span>chord @ {(c.fraction * 100).toFixed(0)} %</span>
                    <span>
                      {c.angleDeg.toFixed(2)}° ±{c.angleSigmaDeg.toFixed(2)}
                      <span style={{ color: c.widthSource === 'certificate' ? '#4ADE80' : '#FCD34D', marginLeft: 5 }}>
                        {c.widthM.toFixed(2)} m{c.widthSource === 'interpolated' ? '*' : ''}
                      </span>
                    </span>
                  </div>
                ))}
                {rows.map((w) => (
                  <div key={`${w.from}-${w.to}`} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, fontWeight: 700, color: '#E2E8F0', marginTop: 1 }}>
                    <span>{w.from.replace('stripe', '')} % → {w.to.replace('stripe', '')} %</span>
                    <span style={{ fontFamily: 'monospace' }}>
                      {w.twistDeg >= 0 ? '+' : ''}{w.twistDeg.toFixed(2)}° ±{w.sigmaDeg.toFixed(2)}
                    </span>
                  </div>
                ))}
                {sag.length > 0 && (
                  <div style={{ fontSize: 10, color: '#86EFAC', fontFamily: 'monospace', marginTop: 1 }}>
                    {sail === 'jib' ? 'forestay sag' : 'luff off centreplane'}:{' '}
                    {sag.map((c) => `${(c.fraction * 100).toFixed(0)}% ${Math.round(Math.abs(c.luffMm as number))}`).join(' · ')} mm
                  </div>
                )}
                {chords.length > 0 && sag.length === 0 && (
                  <div style={{ fontSize: 9.5, color: '#FCD34D', marginTop: 1, lineHeight: 1.4 }}>
                    luff not marked — chord taken from the centreplane
                    {sail === 'jib' ? ', i.e. a straight forestay. ~0.29° of twist per 100 mm it is not.' : ''}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      ) : null}

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
