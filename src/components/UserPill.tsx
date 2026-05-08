'use client'

// Top-right user indicator. Shows the active user's name + a dropdown with
// "Sign out" and (for admins) a link to /admin/users. Self-contained so it
// can be dropped into any layout.

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { getBrowserSupabase } from '../lib/supabase/browser'

interface MeProfile {
  id: string
  email: string
  name: string
  global_role: 'admin' | null
}

export default function UserPill() {
  const router = useRouter()
  const [me, setMe] = useState<MeProfile | null>(null)
  const [open, setOpen] = useState(false)
  const popRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const supabase = getBrowserSupabase()
      const {
        data: { user },
      } = await supabase.auth.getUser()
      if (!user) return
      const { data: profile } = await supabase
        .from('users')
        .select('id, email, name, global_role')
        .eq('id', user.id)
        .maybeSingle()
      if (!cancelled && profile) setMe(profile as MeProfile)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // Close the menu when clicking outside.
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (popRef.current && !popRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    if (open) document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])

  async function signOut() {
    const supabase = getBrowserSupabase()
    await supabase.auth.signOut()
    router.push('/login?reason=signed-out')
    router.refresh()
  }

  // Subtle skeleton while the profile fetch resolves.
  if (!me) {
    return (
      <div
        style={{ zIndex: 9999 }}
        className="fixed top-3 right-3 w-7 h-7 rounded-full bg-slate-700/60 animate-pulse"
        aria-hidden
      />
    )
  }

  const initials = (me.name || me.email)
    .split(/\s+/)
    .map((s) => s[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase()

  return (
    <div style={{ zIndex: 9999 }} className="fixed top-3 right-3" ref={popRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 px-2.5 py-1.5 rounded-full bg-slate-800/90 hover:bg-slate-700 border border-slate-600 backdrop-blur-sm shadow-md"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className="w-7 h-7 rounded-full bg-cyan-500 text-slate-900 text-xs font-semibold flex items-center justify-center">
          {initials || '?'}
        </span>
        <span className="hidden sm:inline text-sm text-slate-100 max-w-[160px] truncate">
          {me.name || me.email}
        </span>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 mt-1 w-56 bg-slate-800 rounded-xl shadow-lg border border-slate-600 py-1 text-sm"
        >
          <div className="px-3 py-2 border-b border-slate-700">
            <div className="font-medium text-slate-100 truncate">
              {me.name || '—'}
            </div>
            <div className="text-slate-400 text-xs truncate">{me.email}</div>
            {me.global_role === 'admin' && (
              <div className="mt-1 inline-block text-[10px] uppercase tracking-wide bg-cyan-500/20 text-cyan-300 px-1.5 py-0.5 rounded">
                Admin
              </div>
            )}
          </div>
          {me.global_role === 'admin' && (
            <Link
              href="/admin/users"
              className="block px-3 py-2 hover:bg-slate-700 text-slate-100"
              onClick={() => setOpen(false)}
            >
              User approvals
            </Link>
          )}
          <button
            onClick={signOut}
            className="block w-full text-left px-3 py-2 hover:bg-slate-700 text-slate-100"
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  )
}
