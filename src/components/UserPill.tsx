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
  type ActiveMembership,
  type MembershipRole,
  getActiveMembership,
  setActiveMembership,
} from '../lib/active-membership'

function toActiveMembership(m: MembershipRow): ActiveMembership {
  return {
    id: m.id,
    team_id: m.team_id,
    boat_id: m.boat_id,
    role: m.role as MembershipRole,
    team_name: m.team_name,
    boat_name: m.boat_name,
  }
}

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
//
// "All boats" memberships: a membership row with boat_id NULL grants access
// to *every* boat in the team (RLS: has_boat_access treats NULL as a
// wildcard). The rest of the app is boat-scoped — one boat's data at a time —
// so here we EXPAND such a membership into one selectable workspace per boat.
// The user picks a boat and every downstream call has a concrete boat_id.
async function loadMemberships(userId: string): Promise<MembershipRow[]> {
  const supabase = getBrowserSupabase()

  const { data: memberships } = await supabase
    .from('memberships')
    .select('id, team_id, boat_id, role, valid_from, valid_to')
    .eq('user_id', userId)

  if (!memberships || memberships.length === 0) return []

  const teamIds = Array.from(new Set(memberships.map((m) => m.team_id)))

  // Fetch teams + every boat in those teams. RLS already limits the boats
  // query to boats the caller can access, so a boat-scoped member sees just
  // their boat and an "all boats" member sees the whole team's boats.
  const [{ data: teams }, { data: boats }] = await Promise.all([
    supabase.from('teams').select('id, name').in('id', teamIds),
    supabase.from('boats').select('id, name, team_id').in('team_id', teamIds),
  ])

  const teamMap = new Map((teams || []).map((t) => [t.id, t.name]))
  const boatMap = new Map((boats || []).map((b) => [b.id, b.name]))
  const boatsByTeam = new Map<string, { id: string; name: string }[]>()
  for (const b of boats || []) {
    const arr = boatsByTeam.get(b.team_id) || []
    arr.push({ id: b.id, name: b.name })
    boatsByTeam.set(b.team_id, arr)
  }

  const rows: MembershipRow[] = []
  for (const m of memberships) {
    const team_name = teamMap.get(m.team_id) || '(team removed)'
    if (m.boat_id) {
      rows.push({
        ...m,
        team_name,
        boat_name: boatMap.get(m.boat_id) || '(boat removed)',
      })
    } else {
      // "All boats" — expand to one workspace per boat. Each expanded row
      // gets a synthetic id (`<membershipId>::<boatId>`) so the switcher can
      // tell them apart; that id is only ever read inside this component.
      const teamBoats = boatsByTeam.get(m.team_id) || []
      if (teamBoats.length === 0) {
        rows.push({ ...m, team_name, boat_name: null })
      } else {
        for (const b of teamBoats) {
          rows.push({
            ...m,
            id: `${m.id}::${b.id}`,
            boat_id: b.id,
            team_name,
            boat_name: b.name,
          })
        }
      }
    }
  }

  return rows.filter((m) => isWindowOpen(m.valid_from, m.valid_to))
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

interface QuotaState {
  bytes_used: number
  bytes_limit: number | null
  percent: number
  blocked: boolean
}

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`
  if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`
  return `${(b / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

export default function UserPill() {
  const router = useRouter()
  const [me, setMe] = useState<MeProfile | null>(null)
  const [memberships, setMemberships] = useState<MembershipRow[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [quota, setQuota] = useState<QuotaState | null>(null)
  const [open, setOpen] = useState(false)
  const popRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const supabase = getBrowserSupabase()
      // getSession() reads the auth cookie with NO network round-trip; the
      // middleware already validated/refreshed it server-side on this page load.
      // getUser() here was an extra ~0.3-0.7s call on the critical path.
      const {
        data: { session },
      } = await supabase.auth.getSession()
      const user = session?.user
      if (!user) return

      // Render the name/email as soon as the profile returns — do NOT gate it on
      // memberships (which chains memberships->teams+boats) or the quota fetch.
      supabase
        .from('users')
        .select('id, email, name, global_role')
        .eq('id', user.id)
        .maybeSingle()
        .then(({ data: profile }) => {
          if (!cancelled && profile) setMe(profile as MeProfile)
        })

      const [ms, quotaRes] = await Promise.all([
        loadMemberships(user.id),
        fetch('/api/quota/me')
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null),
      ])
      if (cancelled) return
      if (quotaRes && typeof quotaRes.bytes_used === 'number') {
        setQuota(quotaRes as QuotaState)
      }
      setMemberships(ms)

      // Pick active membership: persisted choice if still valid, else a default.
      // Default preference: the team's CURRENT Northstar boat ("Northstar 76", the
      // 2026 boat) so every Northstar member lands on it; the "Northstar 72" is the
      // retired old boat and must never be the default when a newer boat exists.
      // Matched by pattern + a "not the retired 72" fallback so a rename doesn't
      // silently drop members back onto the old boat.
      const isOldNorthstar = (m: MembershipRow) => /northstar\s*72\b/i.test(m.boat_name || '')
      const isCurrentNorthstar = (m: MembershipRow) => /northstar\s*76\b/i.test(m.boat_name || '')
      const stored = getActiveMembership(user.id)
      const storedRow = ms.find((m) => m.id === stored?.id)
      const preferredDefault =
        ms.find(isCurrentNorthstar) ||        // the current Northstar boat (76)
        ms.find((m) => !isOldNorthstar(m)) ||  // any boat that isn't the retired 72
        ms[0]
      // Honour the persisted choice — EXCEPT a stale pin to the retired Northstar
      // 72 while the current 76 is available: migrate those users onto 76 (and
      // re-persist) so nobody keeps landing on the old boat from an old session.
      const valid =
        storedRow && !(isOldNorthstar(storedRow) && ms.some(isCurrentNorthstar))
          ? storedRow
          : undefined
      if (valid) {
        setActiveId(valid.id)
        // Re-persist with up-to-date team/boat names in case they changed.
        setActiveMembership(user.id, toActiveMembership(valid))
      } else if (ms.length > 0) {
        setActiveId(preferredDefault.id)
        setActiveMembership(user.id, toActiveMembership(preferredDefault))
      } else {
        setActiveId(null)
      }
      // Notify the app about the resolved workspace on FIRST LOAD too — not just
      // on manual switches. Without this the default (e.g. Northstar 76) is
      // written to localStorage but nothing re-scopes, so the timeline stays on
      // "No active boat" until a manual reload.
      const chosen = valid || (ms.length > 0 ? preferredDefault : null)
      if (chosen) {
        window.dispatchEvent(new CustomEvent('ssa:active-membership-changed', { detail: { membershipId: chosen.id, initial: true } }))
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
    const target = memberships.find((m) => m.id === membershipId)
    if (!target) return
    setActiveId(membershipId)
    setActiveMembership(me.id, toActiveMembership(target))
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

          {/* Quota */}
          {quota && quota.bytes_limit != null && (
            <div className="px-3 py-2 border-b border-slate-700">
              <div className="flex items-center justify-between text-[10px] uppercase tracking-wide text-slate-500 mb-1">
                <span>Storage</span>
                <span
                  className={
                    quota.percent >= 100
                      ? 'text-red-400'
                      : quota.percent >= 80
                      ? 'text-amber-400'
                      : 'text-slate-400'
                  }
                >
                  {quota.percent}%
                </span>
              </div>
              <div className="text-xs text-slate-300">
                {formatBytes(quota.bytes_used)} of{' '}
                {formatBytes(quota.bytes_limit)}
              </div>
              <div className="mt-1 h-1.5 bg-slate-700 rounded overflow-hidden">
                <div
                  className={
                    quota.percent >= 100
                      ? 'h-full bg-red-500'
                      : quota.percent >= 80
                      ? 'h-full bg-amber-500'
                      : 'h-full bg-cyan-500'
                  }
                  style={{ width: `${Math.min(100, quota.percent)}%` }}
                />
              </div>
              {quota.blocked && (
                <div className="mt-2 text-xs text-red-400">
                  Uploads blocked. Contact admin to raise the limit.
                </div>
              )}
            </div>
          )}

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
              <Link
                href="/admin/events"
                className="block px-3 py-2 hover:bg-slate-700 text-slate-100"
                onClick={() => setOpen(false)}
              >
                Audit log
              </Link>
            </>
          )}

          {/* Team manager links: one entry per team they manage. De-duped by
              team_id — an "all boats" membership expands to several rows for
              the same team. */}
          {me.global_role !== 'admin' &&
            Array.from(
              new Map(
                memberships
                  .filter((m) => m.role === 'team_manager')
                  .map((m) => [m.team_id, m] as const)
              ).values()
            ).map((m) => (
              <Link
                key={`mgr-${m.team_id}`}
                href={`/admin/teams/${m.team_id}`}
                className="block px-3 py-2 hover:bg-slate-700 text-slate-100"
                onClick={() => setOpen(false)}
              >
                Manage {m.team_name}
              </Link>
            ))}

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
