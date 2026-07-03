import * as React from 'react'
import { type LucideIcon, Inbox, TriangleAlert } from 'lucide-react'
import { cn } from '@/lib/ui'
import { Button } from './button'

// EmptyState — an invitation, not an apology. Headline names the space, one-line
// body explains it, optional verb-first CTA.
export function EmptyState({
  icon: Icon = Inbox, title, description, action, className,
}: {
  icon?: LucideIcon
  title: string
  description?: string
  action?: { label: string; onClick: () => void }
  className?: string
}) {
  return (
    <div className={cn('flex flex-col items-center justify-center text-center px-6 py-10', className)}>
      <Icon className="mb-3 text-muted" size={28} strokeWidth={1.5} aria-hidden />
      <p className="text-sm font-medium text-fg">{title}</p>
      {description && <p className="mt-1 text-xs text-muted max-w-xs">{description}</p>}
      {action && (
        <Button variant="primary" size="sm" className="mt-4" onClick={action.onClick}>
          {action.label}
        </Button>
      )}
    </div>
  )
}

// ErrorState — say what happened, offer a retry. No raw exception strings.
export function ErrorState({
  title = "Something didn't load", description, onRetry, className,
}: {
  title?: string
  description?: string
  onRetry?: () => void
  className?: string
}) {
  return (
    <div className={cn('flex flex-col items-center justify-center text-center px-6 py-10', className)}>
      <TriangleAlert className="mb-3 text-warning" size={28} strokeWidth={1.5} aria-hidden />
      <p className="text-sm font-medium text-fg">{title}</p>
      {description && <p className="mt-1 text-xs text-muted max-w-xs">{description}</p>}
      {onRetry && (
        <Button variant="secondary" size="sm" className="mt-4" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  )
}
