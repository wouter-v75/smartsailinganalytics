'use client'
import * as React from 'react'
import * as RadixDialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { cn } from '@/lib/ui'

// Accessible modal built on Radix (focus trap, escape, aria) with the frosted
// glass panel. Usage: <Dialog><DialogTrigger/><DialogContent title="…">…</DialogContent></Dialog>
export const Dialog = RadixDialog.Root
export const DialogTrigger = RadixDialog.Trigger
export const DialogClose = RadixDialog.Close

export function DialogContent({
  title, description, children, className, wide = false,
}: {
  title?: string
  description?: string
  children: React.ReactNode
  className?: string
  /**
   * A near-full-width panel — a photo, a video, anything that wants the screen.
   *
   * It also MOVES THE CLOSE BUTTON to the top middle, and that is why this is
   * one flag rather than a width class plus a placement prop. The user pill is
   * `fixed top-3 right-3` at z-index 9999; a dialog sits at z-1101 and cannot
   * raise itself past it, so a wide panel's top right corner is under the pill
   * and its X is unclickable. A narrow panel's corner is nowhere near it. Tying
   * the two together means the next wide dialog cannot forget — which is how
   * the photo viewer and the video dialog both ended up with a hidden X.
   */
  wide?: boolean
}) {
  return (
    <RadixDialog.Portal>
      <RadixDialog.Overlay className="fixed inset-0 z-[1100] bg-black/50 backdrop-blur-[2px]" />
      <RadixDialog.Content
        className={cn(
          'fixed left-1/2 top-1/2 z-[1101] -translate-x-1/2 -translate-y-1/2',
          'glass-strong rounded-lg text-fg shadow-xl focus:outline-none',
          wide
            ? 'w-[min(1300px,calc(100vw-16px))] max-w-none max-h-[96vh] overflow-auto p-3'
            : 'w-[min(560px,calc(100vw-24px))] p-5',
          className
        )}
      >
        {title && <RadixDialog.Title className="text-base font-medium text-fg">{title}</RadixDialog.Title>}
        {description && <RadixDialog.Description className="mt-1 text-xs text-muted">{description}</RadixDialog.Description>}
        <div className={cn(title && 'mt-3')}>{children}</div>
        <RadixDialog.Close
          aria-label="Close"
          className={cn(
            'absolute top-3 rounded p-1 text-muted hover:bg-surface-2 hover:text-fg',
            wide ? 'left-1/2 -translate-x-1/2' : 'right-3',
          )}
        >
          <X size={16} aria-hidden />
        </RadixDialog.Close>
      </RadixDialog.Content>
    </RadixDialog.Portal>
  )
}
