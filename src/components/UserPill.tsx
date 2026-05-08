'use client'

// Top-right user indicator + active-membership switcher.
//
// Shows the active user's name and (when present) the active team / boat
// they're scoped to. Clicking opens a dropdown with:
//   - other available memberships to switch to
//   - admin-only links (User approvals, Teams)
//   - Sign out
//
// Active-membership choice persists in localStorage keyed by user id, so it
// survives reloads and is per-browser.

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { getBrowserSupabase } from '../lib/supabase/browser'
import {
  getActiveMembershipId,
  setActiveMembershipId,
} from '../lib/active-membership'

interface MeProfile {
  id: string
  email: string
  name: string
  global_role: 'admin' | null
}

interface MembershipRow {
  id: string
  team_id: string
  boat_id: string | null
  role: string
  valid_from: string | null
  valid_to: string | null
  team_name: string
  boat_name: string | null
}

// Internal helper: fetch memberships for the user and join in team + boat
// names. We do two queries because RLS gates each table separately, and
// nested-select with RLS can be cranky.
async function loadMemberships(userId: string): Promise<MembershipRow[]> {
  const supabase = getBrowserSupabase()

  const { data: memberships } = await supabase
    .from('memberships')
    .select('id, team_id, boat_id, role, valid_from, valid_to')
    .eq('user_id', userId)

  if (!memberships || memberships.length === 0) return []

  const teamIds = Array.from(new Set(memberships.map((m) => m.team_id)))
  const boatIds = memberships
    .map((m) => m.boat_id)
    .filter((x): x is string => Boolean(x))

  const [{ data: teams }, { data: boats }] = await Promise.all([
    supabase.from('teams').select('id, name').in('id', teamIds),
    boatIds.length > 0
      ? supabase.from('boats').select('id, name').in('id', boatIds)
      : Promise.resolve({ data: [] as { id: string; name: string }[] }),
  ])

  const teamMap = new Map((teams || []).map((t) => [t.id, t.name]))
  const boatMap = new Map((boats || []).map((b) => [b.id, b.name]))

  return memberships
    .map((m) => ({
      ...m,
      team_name: teamMap.get(m.team_id) || '(team removed)',
      boat_name: m.boat_id ? boatMap.get(m.boat_id) || '(boat removed)' : null,
    }))
    .filter((m) => isWindowOpen(m.valid_from, m.valid_to))
}

function isWindowOpen(from: string | null, to: string | null): boolean {
  const now = Date.now()
  if (from && new Date(from).getTime() > now) return false
  if (to && new Date(to).getTime() < now) return false
  return true
}

function membershipLabel(m: MembershipRow): string {
  const scope = m.boat_name ? `${m.team_name} · ${m.boat_name}` : m.team_name
  return `${scope} (${m.role})`
}

export default function UserPill() {
  const router = useRouter()
  const [me, setMe] = useState<MeProfile | null>(null)
  const [memberships, setMemberships] = useState<MembershipRow[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
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

      const [{ data: profile }, ms] = await Promise.all([
        supabase
          .from('users')
          .select('id, email, name, global_role')
          .eq('id', user.id)
          .maybeSingle(),
        loadMemberships(user.id),
      ])
      if (cancelled) return
      if (profile) setMe(profile as MeProfile)
      setMemberships(ms)

      // Pick active membership: persisted choice if still valid, else first.
      const stored = getActiveMembershipId(user.id)
      const valid = ms.find((m) => m.id === stored)
      if (valid) {
        setActiveId(valid.id)
      } else if (ms.length > 0) {
        setActiveId(ms[0].id)
        setActiveMembershipId(user.id, ms[0].id)
      } else {
        setActiveId(null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // Close menu on outside click.
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (popRef.current && !popRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    if (open) document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])

  function pick(membershipId: string) {
    if (!me) return
    setActiveId(membershipId)
    setActiveMembershipId(me.id, membershipId)
    setOpen(false)
    // Tell the rest of the app to re-scope. Anything that cares can listen.
    window.dispatchEvent(
      new CustomEvent('ssa:active-membership-changed', {
        detail: { membershipId },
      })
    )
  }

  async function signOut() {
    const supabase = getBrowserSupabase()
    await supabase.auth.signOut()
    router.push('/login?reason=signed-out')
    router.refresh()
  }

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

  const active = memberships.find((m) => m.id === activeId) || null
  const others = memberships.filter((m) => m.id !== activeId)

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
        <span className="hidden sm:flex flex-col items-start text-left max-w-[200px]">
          <span className="text-sm text-slate-100 truncate w-full">
            {me.name || me.email}
          </span>
          {active && (
            <span className="text-[10px] text-slate-400 truncate w-full">
              {active.boat_name
                ? `${active.team_name} · ${active.boat_name}`
                : active.team_name}
            </span>
          )}
        </span>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 mt-1 w-72 bg-slate-800 rounded-xl shadow-lg border border-slate-600 py-1 text-sm"
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

          {/* Memberships */}
          <div className="px-3 py-2 border-b border-slate-700">
            <div className="text-[10px] uppercase tracking-wide text-slate-500 mb-1">
              Active workspace
            </div>
            {active ? (
              <div className="text-slate-100 text-sm truncate">
                {membershipLabel(active)}
              </div>
            ) : (
              <div className="text-slate-400 text-xs italic">
                No memberships yet — ask the admin.
              </div>
            )}
            {others.length > 0 && (
              <>
                <div className="text-[10px] uppercase tracking-wide text-slate-500 mt-2 mb-1">
                  Switch to
                </div>
                {others.map((m) => (
                  <button
                    key={m.id}
                    onClick={() => pick(m.id)}
                    className="block w-full text-left px-2 py-1 -mx-2 rounded hover:bg-slate-700 text-slate-200 text-sm truncate"
                  >
                    {membershipLabel(m)}
                  </button>
                ))}
              </>
            )}
          </div>

          {/* Admin links */}
          {me.global_role === 'admin' && (
            <>
              <Link
                href="/admin/users"
                className="block px-3 py-2 hover:bg-slate-700 text-slate-100"
                onClick={() => setOpen(false)}
              >
                User approvals
              </Link>
              <Link
                href="/admin/teams"
                className="block px-3 py-2 hover:bg-slate-700 text-slate-100"
                onClick={() => setOpen(false)}
              >
                Teams &amp; boats
              </Link>
            </>
          )}

          <button
            onClick={signOut}
            className="block w-full text-left px-3 py-2 hover:bg-slate-700 text-slate-100 border-t border-slate-700"
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  )
}
