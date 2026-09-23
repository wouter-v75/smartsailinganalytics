import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import CountUp from '../CountUp'

// The stat counter on the front page. What is under test is not the easing —
// it is the promise that the WORST case is "it did not animate", never "it
// showed the wrong number". Those four figures are the page's evidence; a 0
// where 133,000 should be is worse than no motion at all.
//
// The bug this was written after: the first version zeroed the value on mount
// and then drove a requestAnimationFrame loop. rAF is PAUSED in a background
// tab, so the number sat at 0 for as long as the tab stayed hidden. Caught by
// checking document.visibilityState in a real browser, not by any test — hence
// this file.

let observers: { cb: IntersectionObserverCallback; el: Element | null }[] = []

class FakeIO {
  cb: IntersectionObserverCallback
  el: Element | null = null
  constructor(cb: IntersectionObserverCallback) {
    this.cb = cb
    observers.push(this)
  }
  observe(el: Element) { this.el = el }
  disconnect() { /* */ }
  unobserve() { /* */ }
  takeRecords() { return [] }
  root = null
  rootMargin = ''
  thresholds = []
}

/** Fire every live observer as if the element had scrolled into view. */
function scrollIntoView() {
  for (const o of observers) {
    act(() => {
      o.cb([{ isIntersecting: true } as IntersectionObserverEntry], o as unknown as IntersectionObserver)
    })
  }
}

function setReducedMotion(reduce: boolean) {
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: reduce && /prefers-reduced-motion: reduce/.test(q),
    media: q, onchange: null,
    addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {}, dispatchEvent() { return false },
  }))
}

beforeEach(() => {
  observers = []
  vi.stubGlobal('IntersectionObserver', FakeIO as unknown as typeof IntersectionObserver)
  setReducedMotion(false)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('CountUp', () => {
  it('renders the real number before anything happens', () => {
    // This is what the server sends and what a page that never hydrates keeps.
    render(<CountUp value={133000} />)
    expect(screen.getByText('133,000')).toBeTruthy()
  })

  it('never animates when the reader asked for less motion', () => {
    setReducedMotion(true)
    render(<CountUp value={1067} />)
    scrollIntoView()
    expect(screen.getByText('1,067')).toBeTruthy()
  })

  it('lands exactly on the real number when the frames do arrive', () => {
    let frame: FrameRequestCallback | null = null
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frame = cb; return 1 })
    vi.stubGlobal('cancelAnimationFrame', () => {})

    const { container } = render(<CountUp value={731} durationMs={1000} />)
    const span = container.querySelector('span') as HTMLSpanElement
    scrollIntoView()

    // Part-way through: a real number on its way, not the answer yet.
    act(() => { frame?.(performance.now() + 300) })
    const mid = Number(span.textContent!.replace(/,/g, ''))
    expect(Number.isNaN(mid)).toBe(false)
    expect(mid).toBeGreaterThan(0)
    expect(mid).toBeLessThan(731)

    // Past the end: exactly the real number, not an eased approximation.
    act(() => { frame?.(performance.now() + 5000) })
    expect(span.textContent).toBe('731')
  })

  it('falls back to the real number when the frames never arrive', () => {
    // A hidden tab: rAF is registered and never called.
    vi.useFakeTimers()
    vi.stubGlobal('requestAnimationFrame', () => 1)
    vi.stubGlobal('cancelAnimationFrame', () => {})

    render(<CountUp value={109} suffix=" h" durationMs={1000} />)
    scrollIntoView()

    // The guard has not fired yet, so the value has legitimately gone to 0…
    act(() => { vi.advanceTimersByTime(200) })
    // …and by the time the guard runs it is back to the truth, animation or not.
    act(() => { vi.advanceTimersByTime(2000) })
    expect(screen.getByText(/109/)).toBeTruthy()
  })
})
