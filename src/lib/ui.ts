// ui.ts — the one class-merging helper the design system uses.
// cn() = clsx (conditional classes) piped through tailwind-merge (so later
// Tailwind utilities win over earlier conflicting ones, e.g. cn('p-2','p-4') → 'p-4').

import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
