'use client'

// The front page's hero clip: the Northstar 76 under way, which is the whole
// pitch in four seconds and the one thing on the page no competitor can copy —
// it is the actual boat the product was built on.
//
// Client component for one reason: prefers-reduced-motion. CSS can hide a
// looping video but it cannot stop it playing, and a silent autoplaying loop is
// exactly what that setting exists to prevent. When it is set we render the
// poster with normal controls instead, so the footage is still reachable — a
// person who asked for less motion wants the choice, not the removal.
//
// The source is a WhatsApp-compressed 832×464, so it is deliberately NOT
// full-bleed: it sits in the page's own column where the upscale stays modest.
// Motion hides softness far better than a still does, which is why the poster is
// the frame that has to survive scrutiny.
import { useEffect, useState } from 'react'

const SRC = '/media/hero-n76.mp4'
const POSTER = '/media/hero-n76-poster.jpg'

export default function HeroVideo() {
  // Starts null so the first paint matches the server's, then resolves on the
  // client. Rendering the poster during that beat means no layout shift either
  // way and no autoplay before the preference is known.
  const [reduced, setReduced] = useState<boolean | null>(null)

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    setReduced(mq.matches)
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  return (
    <figure className="m-0">
      <div className="relative overflow-hidden rounded-xl border border-border bg-surface-1">
        {/* 832×464 ≈ 16:9; reserving the box stops the page jumping as it loads. */}
        <div className="relative aspect-[832/464] w-full">
          {reduced ? (
            <video
              className="absolute inset-0 h-full w-full object-cover"
              src={SRC}
              poster={POSTER}
              controls
              playsInline
              preload="none"
            />
          ) : (
            <video
              className="absolute inset-0 h-full w-full object-cover"
              src={SRC}
              poster={POSTER}
              autoPlay
              muted
              loop
              playsInline
              // metadata, not auto: the clip is 2 MB and the page must be
              // readable on marina wifi before it is decorative.
              preload="metadata"
              aria-label="The Northstar 76 racing under main and jib"
            />
          )}
          {/* Keeps the caption legible over bright water without dimming the
              footage itself. */}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-20 bg-gradient-to-t from-black/55 to-transparent" />
          <figcaption className="pointer-events-none absolute inset-x-0 bottom-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 text-[12px]">
            <span className="font-medium text-white/85">
              GBR 76X — a real day, from the season SSA was built on
            </span>
            {/* The footage is someone's work and is credited on the page it sells
                from, not buried in a file name. */}
            <span className="text-white/70">Footage: Jonathan Gagachian</span>
          </figcaption>
        </div>
      </div>
    </figure>
  )
}
