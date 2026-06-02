'use client'

// Team invitations: list + create (email-targeted or open-link) + revoke.
// Open-link invitations have a QR display modal for screenshotting into
// WhatsApp.

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import QRCodeSVG from '../../../../components/QRCodeSVG'

type Role = 'team_manager' | 'coach' | 'tl3' | 'tl2' | 'tl1' | 'consultant' | 'guest'
const ROLES: Role[] = ['team_manager', 'coach', 'tl3', 'tl2', 'tl1', 'consultant', 'guest']

interface Invitation {
  id: string
  team_id: string
  email: string | null
  role: Role
  boat_id: string | null
  valid_from: string | null
  valid_to: string | null
  token: string
  auto_approve: boolean
  max_uses: number
  used_count: number
  expires_at: string
  revoked_at: string | null
  created_at: string
}

interface Boat {
  id: string
  name: string
}

export default function InvitationsPanel({
  teamId,
  boats,
}: {
  teamId: string
  boats: Boat[]
}) {
  const router = useRouter()
  const [list, setList] = useState<Invitation[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Form state — email
  const [email, setEmail] = useState('')
  const [emailRole, setEmailRole] = useState<Role>('tl2')
  const [emailBoatId, setEmailBoatId] = useState('')

  // Form state — open
  const [openRole, setOpenRole] = useState<Role>('tl1')
  const [openBoatId, setOpenBoatId] = useState('')
  const [openMaxUses, setOpenMaxUses] = useState(25)
  const [openExpiryDays, setOpenExpiryDays] = useState(30)

  // QR modal state
  const [qrFor, setQrFor] = useState<Invitation | null>(null)

  const origin = useMemo(
    () => (typeof window === 'undefined' ? '' : window.location.origin),
    []
  )

  async function reload() {
    setLoading(true)
    try {
      const res = await fetch(`/api/admin/teams/${teamId}/invitations`)
      const j = await res.json().catch(() => ({}))
      if (!res.ok) {
        setErr(j.error || `failed (${res.status})`)
        return
      }
      setList((j.invitations || []) as Invitation[])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamId])

  async function createEmail(e: React.FormEvent) {
    e.preventDefault()
    if (!email.trim()) return
    setBusy(true)
    setErr(null)
    try {
      const res = await fetch(`/api/admin/teams/${teamId}/invitations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: email.trim(),
          role: emailRole,
          boat_id: emailBoatId || null,
        }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) {
        setErr(j.error || `failed (${res.status})`)
        return
      }
      // Surface email-delivery problems so the team_manager knows to copy
      // the URL manually if Resend isn't configured / failed.
      if (j.email_sent && !j.email_sent.ok) {
        setErr(
          `Invite created, but email failed: ${j.email_sent.error}. Copy the URL below.`
        )
      }
      setEmail('')
      reload()
    } finally {
      setBusy(false)
    }
  }

  async function resend(invId: string) {
    setBusy(true)
    setErr(null)
    try {
      const res = await fetch(
        `/api/admin/teams/${teamId}/invitations/${invId}/resend`,
        { method: 'POST' }
      )
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        setErr(j.error || `failed (${res.status})`)
        return
      }
    } finally {
      setBusy(false)
    }
  }

  async function createOpen() {
    setBusy(true)
    setErr(null)
    try {
      const res = await fetch(`/api/admin/teams/${teamId}/invitations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          open: true,
          role: openRole,
          boat_id: openBoatId || null,
          max_uses: openMaxUses,
          expires_in_days: openExpiryDays,
        }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) {
        setErr(j.error || `failed (${res.status})`)
        return
      }
      // Show QR straight away.
      setQrFor(j.invitation as Invitation)
      reload()
    } finally {
      setBusy(false)
    }
  }

  async function revoke(invId: string) {
    if (!confirm('Revoke this invitation? The link stops working.')) return
    setBusy(true)
    try {
      const res = await fetch(
        `/api/admin/teams/${teamId}/invitations/${invId}`,
        { method: 'DELETE' }
      )
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        setErr(j.error || `failed (${res.status})`)
        return
      }
      reload()
      router.refresh()
    } finally {
      setBusy(false)
    }
  }

  function statusOf(inv: Invitation): string {
    if (inv.revoked_at) return 'revoked'
    if (new Date(inv.expires_at).getTime() < Date.now()) return 'expired'
    if (inv.used_count >= inv.max_uses) return 'used up'
    return `${inv.used_count}/${inv.max_uses} used`
  }

  function urlFor(inv: Invitation): string {
    return `${origin}/join/${inv.token}`
  }

  function copy(text: string) {
    navigator.clipboard?.writeText(text).catch(() => {
      // ignore — clipboard may be denied; user can still copy manually
    })
  }

  return (
    <section className="mb-8">
      <h2 className="text-sm font-semibold text-slate-700 uppercase tracking-wide mb-2">
        Invitations
      </h2>

      {/* Email-targeted invite */}
      <div className="bg-white rounded-xl shadow border border-slate-200 p-4 mb-3">
        <h3 className="text-sm font-semibold text-slate-900 mb-2">
          Invite by email
        </h3>
        <p className="text-xs text-slate-500 mb-3">
          The recipient&apos;s access is granted automatically once they
          confirm their email.
        </p>
        <form onSubmit={createEmail} className="flex flex-wrap gap-2">
          <input
            type="email"
            placeholder="email@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="flex-1 min-w-[200px] rounded-lg border border-slate-300 bg-white text-slate-900 placeholder:text-slate-400 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <select
            value={emailRole}
            onChange={(e) => setEmailRole(e.target.value as Role)}
            className="rounded-lg border border-slate-300 bg-white text-slate-900 px-2 py-2 text-sm"
          >
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          <select
            value={emailBoatId}
            onChange={(e) => setEmailBoatId(e.target.value)}
            className="rounded-lg border border-slate-300 bg-white text-slate-900 px-2 py-2 text-sm"
          >
            <option value="">All boats</option>
            {boats.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
          <button
            type="submit"
            disabled={busy || !email.trim()}
            className="rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white px-4 py-2 text-sm font-medium"
          >
            Send
          </button>
        </form>
      </div>

      {/* Open team link / QR */}
      <div className="bg-white rounded-xl shadow border border-slate-200 p-4 mb-3">
        <h3 className="text-sm font-semibold text-slate-900 mb-2">
          Generate team join link / QR
        </h3>
        <p className="text-xs text-slate-500 mb-3">
          Share in WhatsApp. Anyone who clicks signs up and lands in your
          pending queue for approval.
        </p>
        <div className="flex flex-wrap gap-2 items-center">
          <label className="text-xs text-slate-600">
            Default role
            <select
              value={openRole}
              onChange={(e) => setOpenRole(e.target.value as Role)}
              className="block mt-1 rounded-lg border border-slate-300 bg-white text-slate-900 px-2 py-1.5 text-sm"
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-slate-600">
            Boat
            <select
              value={openBoatId}
              onChange={(e) => setOpenBoatId(e.target.value)}
              className="block mt-1 rounded-lg border border-slate-300 bg-white text-slate-900 px-2 py-1.5 text-sm"
            >
              <option value="">All boats</option>
              {boats.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-slate-600">
            Max uses
            <input
              type="number"
              min={1}
              max={500}
              value={openMaxUses}
              onChange={(e) => setOpenMaxUses(Number(e.target.value))}
              className="block mt-1 w-24 rounded-lg border border-slate-300 bg-white text-slate-900 px-2 py-1.5 text-sm"
            />
          </label>
          <label className="text-xs text-slate-600">
            Expires in (days)
            <input
              type="number"
              min={1}
              max={365}
              value={openExpiryDays}
              onChange={(e) => setOpenExpiryDays(Number(e.target.value))}
              className="block mt-1 w-24 rounded-lg border border-slate-300 bg-white text-slate-900 px-2 py-1.5 text-sm"
            />
          </label>
          <button
            disabled={busy}
            onClick={createOpen}
            className="rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white px-4 py-2 text-sm font-medium"
          >
            Create link + QR
          </button>
        </div>
      </div>

      {err && <p className="mb-2 text-sm text-red-600">{err}</p>}

      {/* List */}
      <div className="bg-white rounded-xl shadow border border-slate-200 divide-y divide-slate-100">
        {loading ? (
          <div className="p-4 text-slate-500 text-sm text-center">
            Loading…
          </div>
        ) : list.length === 0 ? (
          <div className="p-4 text-slate-500 text-sm text-center">
            No invitations yet.
          </div>
        ) : (
          list.map((inv) => (
            <div
              key={inv.id}
              className="flex items-start justify-between gap-3 px-4 py-3"
            >
              <div className="min-w-0 flex-1">
                <div className="font-medium text-slate-900 truncate">
                  {inv.email ? inv.email : 'Open team link'}
                  <span className="ml-2 text-xs text-slate-500">
                    {inv.role}
                  </span>
                  {inv.auto_approve && (
                    <span className="ml-2 text-[10px] uppercase tracking-wide bg-emerald-100 text-emerald-700 px-1.5 py-0.5 rounded">
                      auto-approve
                    </span>
                  )}
                </div>
                <div className="text-xs text-slate-500 break-all">
                  {urlFor(inv)}
                </div>
                <div className="text-xs text-slate-400 mt-0.5">
                  {statusOf(inv)} · expires{' '}
                  {new Date(inv.expires_at).toLocaleDateString()}
                </div>
              </div>
              <div className="flex flex-wrap gap-1 shrink-0">
                <button
                  onClick={() => copy(urlFor(inv))}
                  className="text-sm text-blue-600 hover:underline"
                >
                  Copy URL
                </button>
                {!inv.email && (
                  <button
                    onClick={() => setQrFor(inv)}
                    className="text-sm text-blue-600 hover:underline"
                  >
                    Show QR
                  </button>
                )}
                {inv.email && !inv.revoked_at && inv.used_count < inv.max_uses && (
                  <button
                    onClick={() => resend(inv.id)}
                    className="text-sm text-blue-600 hover:underline"
                  >
                    Resend
                  </button>
                )}
                {!inv.revoked_at && (
                  <button
                    onClick={() => revoke(inv.id)}
                    className="text-sm text-red-600 hover:underline"
                  >
                    Revoke
                  </button>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      {qrFor && (
        <div
          className="fixed inset-0 z-[10000] bg-black/50 flex items-center justify-center px-4"
          onClick={() => setQrFor(null)}
        >
          <div
            className="bg-white rounded-2xl shadow-xl p-6 max-w-sm w-full text-center"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold text-slate-900 mb-1">
              Team join QR
            </h3>
            <p className="text-xs text-slate-500 mb-3 break-all">
              {urlFor(qrFor)}
            </p>
            <div className="flex justify-center mb-3">
              <QRCodeSVG text={urlFor(qrFor)} size={240} />
            </div>
            <div className="flex justify-center gap-2">
              <button
                onClick={() => copy(urlFor(qrFor))}
                className="rounded-lg bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 text-sm font-medium"
              >
                Copy URL
              </button>
              <button
                onClick={() => setQrFor(null)}
                className="rounded-lg border border-slate-300 text-slate-700 px-4 py-2 text-sm"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
