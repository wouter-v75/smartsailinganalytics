// Tiny Plotly wrapper. Lazy-loads Plotly from CDN on first render via the
// shared useScriptsOnce hook (no global script tag pollution; Analytics tab
// or any other consumer reuses the same instance).
//
// Pass `data`, `layout`, `config`; the wrapper handles initial paint + a
// React-effect rebuild on data/layout change + a resize observer so the
// chart auto-fills its container when the window or sub-tab changes size.
//
// Dark-theme defaults baked into the layout merge: chart paper/plot
// backgrounds match SSA's `#0A1929`, axis gridlines are slate-toned.

import React, { useEffect, useRef } from 'react'
import { useScriptsOnce } from './useScriptOnce'

const PLOTLY_JS = 'https://cdnjs.cloudflare.com/ajax/libs/plotly.js/2.24.1/plotly.min.js'

const DARK_LAYOUT = {
  paper_bgcolor: '#0A1929',
  plot_bgcolor: '#071624',
  font: { color: '#E2E8F0', family: "'Segoe UI', system-ui, sans-serif", size: 11 },
  xaxis: { gridcolor: '#1E3A5A', linecolor: '#1E3A5A', zerolinecolor: '#1E3A5A', tickfont: { color: '#94A3B8' }, titlefont: { color: '#7DD3FC' } },
  yaxis: { gridcolor: '#1E3A5A', linecolor: '#1E3A5A', zerolinecolor: '#1E3A5A', tickfont: { color: '#94A3B8' }, titlefont: { color: '#7DD3FC' } },
  legend: { font: { color: '#94A3B8' }, bgcolor: 'rgba(10,25,41,0.6)', bordercolor: '#1E3A5A', borderwidth: 1 },
  hoverlabel: { bgcolor: '#0A1929', bordercolor: '#1E3A5A', font: { color: '#E2E8F0' } },
}

// Merge two layout objects one level deep — enough for the xaxis/yaxis dicts
// to keep their grid colours while the caller overrides title / range etc.
function mergeLayout(base, over) {
  const out = { ...base, ...over }
  for (const k of ['xaxis', 'yaxis', 'legend', 'hoverlabel', 'font']) {
    if (base[k] && over && over[k]) out[k] = { ...base[k], ...over[k] }
  }
  return out
}

export default function PlotlyChart({ data, layout, config, height = 320, placeholder, onHover, onUnhover }) {
  const ready = useScriptsOnce([PLOTLY_JS])
  const ref = useRef(null)

  useEffect(() => {
    if (!ready || !ref.current || !window.Plotly) return
    if (!data || !data.length) {
      ref.current.innerHTML = ''
      return
    }
    const merged = mergeLayout(DARK_LAYOUT, layout || {})
    const gd = ref.current
    window.Plotly.newPlot(
      gd,
      data,
      merged,
      { responsive: true, scrollZoom: true, displaylogo: false, ...config }
    )
    // Optional hover handlers (e.g. highlight the hovered series). gd.on is
    // attached by Plotly after newPlot.
    if (onHover) gd.on('plotly_hover', (e) => onHover(gd, e))
    if (onUnhover) gd.on('plotly_unhover', () => onUnhover(gd))
    // Resize when the container width changes (sub-tab open, etc.)
    const ro = new ResizeObserver(() => {
      try { window.Plotly.Plots.resize(ref.current) } catch { /* ignore */ }
    })
    ro.observe(ref.current)
    return () => {
      ro.disconnect()
      try { window.Plotly.purge(ref.current) } catch { /* ignore */ }
    }
  }, [ready, data, layout, config, onHover, onUnhover])

  if (!ready) {
    return (
      <div style={{ height, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#64748B', fontSize: 11 }}>
        Loading chart…
      </div>
    )
  }
  if (!data || !data.length) {
    return (
      <div style={{ height, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#64748B', fontSize: 11, textAlign: 'center', padding: 20 }}>
        {placeholder || 'No data'}
      </div>
    )
  }
  return <div ref={ref} style={{ width: '100%', height }} />
}
