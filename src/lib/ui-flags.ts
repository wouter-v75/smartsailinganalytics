'use client'
import { useEffect, useState } from 'react'

// `?ui=next` opts a screen into the redesigned (design-system) UI; `?ui=legacy`
// opts back out. The choice persists in localStorage so it survives navigation.
const KEY = 'ssa:ui'

export function useUiNext(): boolean {
  const [on, setOn] = useState(false)
  useEffect(() => {
    try {
      const p = new URLSearchParams(window.location.search).get('ui')
      if (p === 'next') { localStorage.setItem(KEY, 'next'); setOn(true); return }
      if (p === 'legacy') { localStorage.removeItem(KEY); setOn(false); return }
      setOn(localStorage.getItem(KEY) === 'next')
    } catch { /* SSR / no storage */ }
  }, [])
  return on
}

export function setUiNext(on: boolean) {
  try {
    if (on) localStorage.setItem(KEY, 'next')
    else localStorage.removeItem(KEY)
    const u = new URL(window.location.href)
    u.searchParams.delete('ui')
    window.history.replaceState({}, '', u.toString())
    window.location.reload()
  } catch { /* noop */ }
}
