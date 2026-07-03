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
  title, description, children, className,
}: {
  title?: string
  description?: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <RadixDialog.Portal>
      <RadixDialog.Overlay className="fixed inset-0 z-[1100] bg-black/50 backdrop-blur-[2px]" />
      <RadixDialog.Content
        className={cn(
          'fixed left-1/2 top-1/2 z-[1101] w-[min(560px,calc(100vw-24px))] -translate-x-1/2 -translate-y-1/2',
          'glass-strong rounded-lg p-5 text-fg shadow-xl focus:outline-none',
          className
        )}
      >
        {title && <RadixDialog.Title className="text-base font-medium text-fg">{title}</RadixDialog.Title>}
        {description && <RadixDialog.Description className="mt-1 text-xs text-muted">{description}</RadixDialog.Description>}
        <div className={cn(title && 'mt-3')}>{children}</div>
        <RadixDialog.Close
          aria-label="Close"
          className="absolute right-3 top-3 rounded p-1 text-muted hover:bg-surface-2 hover:text-fg"
        >
          <X size={16} aria-hidden />
        </RadixDialog.Close>
      </RadixDialog.Content>
    </RadixDialog.Portal>
  )
}
