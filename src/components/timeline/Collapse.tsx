'use client'
import * as React from 'react'

// Smooth "harmonica" collapse. Animates to the content's intrinsic height using
// the grid-template-rows 0fr↔1fr technique (stable across Chrome/Firefox/Safari
// since 2023) plus a soft opacity/translate settle — so both opening AND closing
// glide instead of popping. Content is lazy-mounted on first open and then kept
// mounted, so re-open/close stay animated (and expensive children only mount
// when actually revealed). Honours prefers-reduced-motion via CSS.
export default function Collapse({ open, children, className }: {
  open: boolean
  children: React.ReactNode
  className?: string
}) {
  const [mounted, setMounted] = React.useState(open)
  React.useEffect(() => { if (open) setMounted(true) }, [open])
  return (
    <div className={`tl-collapse${className ? ` ${className}` : ''}`} data-open={open ? 'true' : 'false'} aria-hidden={!open}>
      <div className="tl-collapse-clip">
        <div className="tl-collapse-fade">{mounted ? children : null}</div>
      </div>
    </div>
  )
}
