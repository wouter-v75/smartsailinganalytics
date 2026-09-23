'use client'

// A glimpse of the timeline's fisheye.
//
// The real one is a dock magnifier over the season's spine: rows swell as the
// pointer nears them so a whole campaign stays on one screen and the day under
// your cursor is still readable. It is the same `transform-origin: left center`
// trick the app uses (see .tl-dock-item in globals.css), which is why the motion
// here feels like the product rather than like a landing page.
//
// DELIBERATELY WITHOUT: what the rows actually are, how the season is divided,
// what a row expands into, or any label beyond a date. The BEHAVIOUR is the
// thing worth showing; the structure is worth a conversation.
//
// Falls back honestly: without JavaScript, or with prefers-reduced-motion, it is
// a static stack of bars that still reads as a timeline. Nothing is hidden
// behind the interaction.
import { useEffect, useRef, useState } from 'react'

const ROWS = 14

export default function FisheyeDemo() {
  const [focus, setFocus] = useState<number | null>(null)
  const [reduced, setReduced] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setReduced(window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  }, [])

  // Pointer position → which row is under it, in row units. Tracked on the
  // container rather than per row so the magnification is continuous instead of
  // snapping between neighbours.
  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (reduced) return
    const box = ref.current?.getBoundingClientRect()
    if (!box) return
    setFocus(((e.clientY - box.top) / box.height) * ROWS)
  }

  return (
    <div
      ref={ref}
      onPointerMove={onMove}
      onPointerLeave={() => setFocus(null)}
      className="flex flex-col gap-[3px] py-1"
      // Touch: a finger dragging down the strip should magnify, not scroll the
      // page out from under it.
      style={{ touchAction: 'pan-x' }}
    >
      {Array.from({ length: ROWS }, (_, i) => {
        // Gaussian falloff: the row under the pointer grows most, its
        // neighbours less, everything else not at all.
        const d = focus == null ? Infinity : Math.abs(i + 0.5 - focus)
        const m = focus == null ? 0 : Math.exp(-(d * d) / 2.4)
        const scale = 1 + m * 0.34
        const width = 34 + m * 46 + (i % 5) * 6 + (i % 3) * 4
        return (
          <div key={i} className="flex items-center gap-2">
            <div
              className="tl-dock-item h-[9px] rounded-[3px]"
              style={{
                width: `${width}%`,
                transform: `scaleY(${scale})`,
                background: m > 0.45 ? 'var(--accent)' : 'var(--border-strong)',
                opacity: 0.35 + m * 0.65,
              }}
            />
            {/* One date, so it reads as a season rather than an equaliser. No
                other label: what a row contains is not on offer here. */}
            {i % 4 === 0 && (
              <span
                className="select-none text-[9px] tabular-nums text-faint transition-opacity duration-200"
                style={{ opacity: m > 0.4 ? 0.9 : 0.35 }}
              >
                {String(4 + i).padStart(2, '0')} Jun
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}
