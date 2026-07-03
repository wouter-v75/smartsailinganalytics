import * as React from 'react'
import { cn } from '@/lib/ui'

export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('animate-pulse rounded bg-surface-2', className)} {...props} />
}
