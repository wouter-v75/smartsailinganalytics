'use client'
import * as React from 'react'

// Shared macOS-Dock magnifier for normal-flow rows (the timeline spine + phase
// rows). Rows register their DOM node; on pointer move we measure each row's
// centre and scale it by a cosine falloff of the vertical distance to the cursor
// — the row under the cursor inflates most, neighbours taper off. Transforms are
// written straight to the DOM inside a rAF (no React re-render), and because the
// transform-origin is left-CENTRE the row's centre Y is invariant under the
// scale, so the measurement never feeds back on itself. Honours reduced-motion.

const DockCtx = React.createContext<{ add: (el: HTMLElement) => void; remove: (el: HTMLElement) => void } | null>(null)

export function useDockItem(): (el: HTMLElement | null) => void {
  const ctx = React.useContext(DockCtx)
  const prev = React.useRef<HTMLElement | null>(null)
  return React.useCallback((el: HTMLElement | null) => {
    if (prev.current && ctx) ctx.remove(prev.current)
    prev.current = el
    if (el && ctx) ctx.add(el)
  }, [ctx])
}

export default function DockMagnifier({ children, amp = 0.26, radius = 120 }: {
  children: React.ReactNode; amp?: number; radius?: number
}) {
  const items = React.useRef<Set<HTMLElement>>(new Set())
  const ptrY = React.useRef<number | null>(null)
  const raf = React.useRef<number | null>(null)
  const reduced = React.useRef(false)
  React.useEffect(() => {
    reduced.current = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  }, [])

  const apply = React.useCallback(() => {
    raf.current = null
    const y = ptrY.current
    items.current.forEach((el) => {
      if (y == null || reduced.current) { el.style.transform = ''; el.style.zIndex = ''; return }
      const r = el.getBoundingClientRect()
      const cy = r.top + r.height / 2
      const d = Math.abs(cy - y)
      const mag = d >= radius ? 1 : 1 + amp * 0.5 * (1 + Math.cos((d / radius) * Math.PI))
      el.style.transform = mag > 1.001 ? `scale(${mag.toFixed(3)})` : ''
      el.style.zIndex = mag > 1.02 ? '30' : ''
    })
  }, [amp, radius])

  const schedule = React.useCallback(() => {
    if (raf.current == null) raf.current = requestAnimationFrame(apply)
  }, [apply])

  const ctx = React.useMemo(() => ({
    add: (el: HTMLElement) => { items.current.add(el) },
    remove: (el: HTMLElement) => { items.current.delete(el); el.style.transform = ''; el.style.zIndex = '' },
  }), [])

  React.useEffect(() => () => { if (raf.current != null) cancelAnimationFrame(raf.current) }, [])

  const clear = () => { ptrY.current = null; schedule() }
  return (
    <DockCtx.Provider value={ctx}>
      {/* Mouse only — continuous magnification on touch fights scrolling; on touch
          the rows are simply tapped to expand. */}
      <div onPointerMove={(e) => { if (e.pointerType !== 'mouse') return; ptrY.current = e.clientY; schedule() }} onPointerLeave={clear} onPointerCancel={clear}>
        {children}
      </div>
    </DockCtx.Provider>
  )
}
