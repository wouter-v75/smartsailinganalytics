'use client'

// Counts a number up when it scrolls into view.
//
// The only JavaScript on the public site's motion layer, because it is the only
// thing CSS genuinely cannot do: reveals, stagger, the hero frame and hover are
// all scroll-driven CSS that degrades to a static page.
//
// It exists because these four numbers ARE the argument. The page says
// "measured, not claimed" and then prints 731, 133,000, 109 h and 1,067; a
// number that counts up asks to be read, where a number that is simply there
// gets skimmed.
//
// THE RULE IT IS BUILT AROUND: the worst case must be "it did not animate",
// never "it showed the wrong number". So:
//
//   - The real value is what the server renders, and what a page that never
//     hydrates keeps.
//   - The zero is written only at the instant the animation actually starts —
//     not on mount. An earlier version zeroed on mount and started a
//     requestAnimationFrame loop; in a BACKGROUND TAB rAF is paused, so the
//     number sat at 0 for as long as the tab stayed hidden. Found by checking
//     it with document.visibilityState === 'hidden'.
//   - A timer outlives the animation and snaps to the true value if the frames
//     never arrive.
//   - prefers-reduced-motion never animates at all.
//   - It runs once. A number that re-counts on every pass is a fidget toy.
import { useEffect, useRef, useState } from 'react'

export default function CountUp({
  value,
  suffix = '',
  durationMs = 1100,
}: {
  value: number
  suffix?: string
  durationMs?: number
}) {
  const ref = useRef<HTMLSpanElement>(null)
  const [shown, setShown] = useState(value)
  const started = useRef(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return

    let raf = 0
    let guard: ReturnType<typeof setTimeout> | undefined

    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting || started.current) continue
          started.current = true
          io.disconnect()

          // Only now does the number leave its true value.
          setShown(0)

          const t0 = performance.now()
          const tick = (t: number) => {
            const p = Math.min(1, (t - t0) / durationMs)
            // easeOutCubic: quick to start, settling at the end, so the last
            // digits are readable rather than a blur.
            setShown(Math.round(value * (1 - Math.pow(1 - p, 3))))
            if (p < 1) raf = requestAnimationFrame(tick)
            else setShown(value)
          }
          raf = requestAnimationFrame(tick)

          // If the frames never come — hidden tab, throttled timer, anything —
          // land on the truth rather than leaving a nought on the page.
          guard = setTimeout(() => setShown(value), durationMs + 600)
        }
      },
      { threshold: 0.4 },
    )
    io.observe(el)

    return () => {
      io.disconnect()
      cancelAnimationFrame(raf)
      if (guard) clearTimeout(guard)
    }
  }, [value, durationMs])

  return (
    <span ref={ref} className="tabular-nums">
      {shown.toLocaleString('en-GB')}
      {suffix}
    </span>
  )
}
