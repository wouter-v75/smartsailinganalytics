'use client'
import * as React from 'react'

// A textarea that is as tall as what is in it.
//
// Why this exists: the AI debrief draft put each section in `rows={5}`. Five
// lines is nothing for a debrief section, so the text scrolled inside the box —
// and a box whose content stops mid-sentence at its bottom edge reads exactly
// like a summary that was cut short. The summary was complete every time; what
// was short was the window onto it. Nobody drags a resize handle to find that
// out, and nobody should have to.
//
// It grows on mount and on every change, including changes that did not come
// from typing (a re-run replacing the draft), which is why the effect watches
// `value` rather than living in onChange.
//
// `maxHeight` caps it so a forty-minute transcript does not push the Save button
// off the page — past the cap it scrolls again, but by then the box is tall
// enough that scrolling is obviously what it is doing.

export interface AutoTextareaProps
  extends Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'rows'> {
  /** Smallest height, in rows, before the content decides. */
  minRows?: number
  /** Tallest it may grow before it scrolls. Any CSS length. */
  maxHeight?: string
}

export function AutoTextarea({
  minRows = 3,
  maxHeight = '60vh',
  value,
  style,
  ...props
}: AutoTextareaProps) {
  const ref = React.useRef<HTMLTextAreaElement | null>(null)

  React.useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    // Collapse first: scrollHeight only ever grows against a fixed height, so
    // without this the box can get taller but never shorter.
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [value])

  return (
    <textarea
      ref={ref}
      value={value}
      rows={minRows}
      style={{ ...style, maxHeight, overflowY: 'auto', resize: 'vertical' }}
      {...props}
    />
  )
}
