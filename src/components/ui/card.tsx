import * as React from 'react'
import { cn } from '@/lib/ui'

// Card — the standard bounded surface. `glass` swaps the solid fill for the
// frosted backdrop layer (use over imagery / the timeline, not over plain bg).
export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  glass?: boolean
}

export const Card = React.forwardRef<HTMLDivElement, CardProps>(
  ({ className, glass, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        'rounded-lg',
        glass ? 'glass' : 'bg-surface-1 border border-[color:var(--border)]',
        className
      )}
      {...props}
    />
  )
)
Card.displayName = 'Card'

export function CardHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('px-4 pt-4 pb-2', className)} {...props} />
}

export function CardTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={cn('text-[15px] font-medium text-fg', className)} {...props} />
}

export function CardContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('px-4 pb-4', className)} {...props} />
}
