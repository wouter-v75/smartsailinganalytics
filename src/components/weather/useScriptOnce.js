// Inject a third-party script tag once per page. Multiple consumers asking
// for the same URL share the same load promise.
//
// Used by WeatherTab to lazy-load Leaflet (map), Plotly (charts), and D3
// (Skew-T) from CDN — same approach the standalone weather tool uses, just
// gated on tab activation so the libraries don't bloat the main SSA bundle.

import { useEffect, useState } from 'react'

const cache = new Map() // src → Promise<void>

function loadScript(src) {
  if (typeof window === 'undefined') return Promise.resolve()
  if (cache.has(src)) return cache.get(src)
  const p = new Promise((resolve, reject) => {
    // If another component already added the same script (e.g. SSA's
    // Analytics tab loads Leaflet too), reuse it.
    const existing = document.querySelector(`script[src="${src}"]`)
    if (existing) {
      if (existing.dataset.loaded === '1') return resolve()
      existing.addEventListener('load', () => resolve())
      existing.addEventListener('error', reject)
      return
    }
    const s = document.createElement('script')
    s.src = src
    s.async = true
    s.onload = () => { s.dataset.loaded = '1'; resolve() }
    s.onerror = reject
    document.head.appendChild(s)
  })
  cache.set(src, p)
  return p
}

function loadStyle(href) {
  if (typeof window === 'undefined') return
  if (document.querySelector(`link[href="${href}"]`)) return
  const l = document.createElement('link')
  l.rel = 'stylesheet'
  l.href = href
  document.head.appendChild(l)
}

// Public hook. Pass an array of script URLs and (optionally) stylesheet URLs;
// returns `loaded` true once they're all attached.
export function useScriptsOnce(scripts, styles = []) {
  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    let cancelled = false
    for (const href of styles) loadStyle(href)
    Promise.all(scripts.map(loadScript))
      .then(() => { if (!cancelled) setLoaded(true) })
      .catch((e) => {
        // eslint-disable-next-line no-console
        console.warn('[weather] script load failed:', e?.message || e)
      })
    return () => { cancelled = true }
  }, [scripts, styles])
  return loaded
}
