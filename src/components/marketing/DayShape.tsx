'use client'

// The shape of a sailing day, as a rail that stays with you while the page moves.
//
// This is the one piece of the public site that is genuinely interactive rather
// than decorative, and it earns that by carrying the argument: SSA is organised
// around a DAY — plan, sail, debrief, season — not around an app's tabs. A
// reader who scrolls this section has been walked through that shape whether or
// not they read a word of it.
//
// It needs JavaScript for one thing only: knowing which stage you are looking
// at. The alternative — named CSS view-timelines with `timeline-scope`, so a
// stage marker animates off a sibling's scroll position — is genuinely elegant
// and has support too thin to hang the section on. So: IntersectionObserver.
//
// WITHOUT JAVASCRIPT the rail still renders, every stage is listed and linked,
// and all the content below is present and readable. What is lost is the
// highlight following you, which is a nicety, not the page.
//
// The rail is desktop-only. On a phone there is no room for a column beside the
// content, and a sticky strip over a 375px viewport eats the screen it is meant
// to help you read.
import { useEffect, useRef, useState } from 'react'

export interface Stage {
  id: string
  /** "Before you go out" */
  title: string
  /** The one-liner under it in the rail. */
  note: string
}

export default function DayShape({
  stages,
  children,
}: {
  stages: Stage[]
  children: React.ReactNode
}) {
  // -1 until we know, so nothing is highlighted during the first paint and the
  // server and client agree.
  const [active, setActive] = useState(-1)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const root = ref.current
    if (!root) return
    const sections = stages
      .map((s) => document.getElementById(s.id))
      .filter((el): el is HTMLElement => Boolean(el))
    if (!sections.length) return

    // Whichever stage's top edge is nearest the reading line — a third of the
    // way down — is the one you are looking at. Picking by "most visible" makes
    // the highlight jitter between two tall sections that both fill the screen.
    const pick = () => {
      const line = window.innerHeight * 0.33
      let best = 0
      let bestDist = Infinity
      sections.forEach((el, i) => {
        const d = Math.abs(el.getBoundingClientRect().top - line)
        if (d < bestDist) { bestDist = d; best = i }
      })
      setActive(best)
    }

    pick()

    // Recompute on scroll, coalesced to one frame. Four rect reads is nothing;
    // an IntersectionObserver cannot answer "nearest the reading line" without
    // reading rects anyway.
    //
    // The setTimeout branch is not belt-and-braces: requestAnimationFrame is
    // PAUSED while a tab is hidden, so coalescing through it alone leaves the
    // highlight frozen wherever it was when the tab went away — and then wrong
    // the moment the reader comes back. Caught with the pane hidden, where the
    // rail sat on the last stage no matter where the page was scrolled.
    let queued = false
    const onScroll = () => {
      if (queued) return
      queued = true
      const run = () => { queued = false; pick() }
      if (document.hidden) setTimeout(run, 100)
      else requestAnimationFrame(run)
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    // Coming back to the tab re-reads position, rather than trusting whatever
    // was true when it was left.
    document.addEventListener('visibilitychange', pick)
    return () => {
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
      document.removeEventListener('visibilitychange', pick)
    }
  }, [stages])

  return (
    <div ref={ref} className="lg:grid lg:grid-cols-[240px_1fr] lg:gap-12">
      {/* The rail. `self-start` so sticky has a box to stick inside; top-28
          clears the sticky site header. */}
      <nav aria-label="The shape of a day" className="hidden lg:block lg:sticky lg:top-28 lg:self-start">
        <div className="mb-4 text-[11px] font-bold uppercase tracking-[0.16em] text-muted">
          The shape of a day
        </div>
        <ol className="relative space-y-1 border-l border-border pl-0">
          {stages.map((s, i) => {
            const on = i === active
            return (
              <li key={s.id} className="relative">
                {/* The marker sits on the rail line itself. */}
                <span
                  aria-hidden="true"
                  className={`absolute -left-[5px] top-[15px] h-2.5 w-2.5 rounded-full border transition-colors duration-300 ${
                    on ? 'border-accent bg-accent' : 'border-border bg-bg'
                  }`}
                />
                <a
                  href={`#${s.id}`}
                  className={`block rounded-r-lg py-2.5 pl-5 pr-3 transition-colors duration-300 ${
                    on ? 'bg-surface-1' : ''
                  }`}
                >
                  <span
                    className={`block text-[14px] font-semibold transition-colors duration-300 ${
                      on ? 'text-fg' : 'text-muted'
                    }`}
                  >
                    {s.title}
                  </span>
                  <span
                    className={`mt-0.5 block text-[12px] leading-snug transition-opacity duration-300 ${
                      on ? 'text-secondary opacity-100' : 'text-muted opacity-60'
                    }`}
                  >
                    {s.note}
                  </span>
                </a>
              </li>
            )
          })}
        </ol>
      </nav>

      <div>{children}</div>
    </div>
  )
}
