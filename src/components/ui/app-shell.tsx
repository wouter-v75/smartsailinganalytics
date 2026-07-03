'use client'
import * as React from 'react'
import { Sun, Moon } from 'lucide-react'
import { cn } from '@/lib/ui'
import { Button } from './button'

// AppShell — the responsive frame for redesigned screens: a glass top bar
// (title + actions + theme toggle), an optional scrollable tab strip, and a
// centered content area. Theming is scoped to THIS subtree via data-theme, so a
// light-mode preview can't leak into the still-dark legacy screens.
const THEME_KEY = 'ssa:theme'
export interface ShellTab { key: string; label: string; icon?: React.ReactNode }

export function AppShell({
  title, subtitle, tabs, activeTab, onTab, actions, children, className,
}: {
  title: string
  subtitle?: string
  tabs?: ShellTab[]
  activeTab?: string
  onTab?: (key: string) => void
  actions?: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  const [theme, setTheme] = React.useState<'dark' | 'light'>('dark')
  React.useEffect(() => {
    try {
      const t = localStorage.getItem(THEME_KEY)
      if (t === 'light' || t === 'dark') setTheme(t)
    } catch { /* noop */ }
  }, [])
  const toggle = () =>
    setTheme((t) => {
      const n = t === 'dark' ? 'light' : 'dark'
      try { localStorage.setItem(THEME_KEY, n) } catch { /* noop */ }
      return n
    })

  return (
    <div data-theme={theme} className={cn('h-full overflow-auto bg-bg text-fg', className)}>
      <header className="glass sticky top-0 z-20 flex items-center gap-3 border-b border-[color:var(--border)] px-4 py-3">
        <div className="min-w-0">
          <div className="truncate text-[15px] font-medium">{title}</div>
          {subtitle && <div className="truncate text-xs text-muted">{subtitle}</div>}
        </div>
        <div className="ml-auto flex items-center gap-2">
          {actions}
          <Button variant="ghost" size="icon" aria-label="Toggle light or dark mode" onClick={toggle}>
            {theme === 'dark' ? <Sun size={16} aria-hidden /> : <Moon size={16} aria-hidden />}
          </Button>
        </div>
      </header>

      {tabs && tabs.length > 0 && (
        <nav className="flex gap-1 overflow-x-auto border-b border-[color:var(--border)] px-3 py-2">
          {tabs.map((t) => (
            <button
              key={t.key}
              onClick={() => onTab?.(t.key)}
              className={cn(
                'inline-flex items-center gap-1.5 whitespace-nowrap rounded px-3 py-1.5 text-sm transition-colors',
                activeTab === t.key ? 'bg-accent text-accent-fg' : 'text-secondary hover:bg-surface-1 hover:text-fg'
              )}
            >
              {t.icon}
              {t.label}
            </button>
          ))}
        </nav>
      )}

      <main className="mx-auto w-full max-w-5xl px-4 py-4">{children}</main>
    </div>
  )
}
