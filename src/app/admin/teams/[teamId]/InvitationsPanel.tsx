'use client'

// Team invitations: list + create (email-targeted or open-link) + revoke +
// SHARE.
//
// The panel has promised "Share in WhatsApp" for as long as it has existed and
// offered Copy URL, which on a phone means reading a token off a screen and
// typing it. Share… opens the code with the ways people actually send things:
// WhatsApp, a mail draft, the phone's own share sheet (carrying the QR as a
// PNG where that is allowed), the message on the clipboard, and the QR as a
// file to attach.
//
// It knows the difference between the two links. An open /join code is made to
// be posted in a group — the worst a stranger can do is join a queue. An
// email-targeted /welcome link SETS THAT PERSON'S PASSWORD, so it gets a
// warning, an addressed mail draft, and no WhatsApp button at all.

import { useEffect, useMemo, useState } from 'react'
import { roleLabel } from '../../../../lib/roleLabels'
import { useRouter } from 'next/navigation'
import QRCodeSVG from '../../../../components/QRCodeSVG'
import {
  inviteMessage, inviteSubject, mailtoHref, qrFileName, whatsappHref,
} from '../../../../lib/shareInvite'

type Role = 'team_manager' | 'coach' | 'tl3' | 'tl1' | 'owner' | 'consultant' | 'guest'
const ROLES: Role[] = ['team_manager', 'coach', 'tl3', 'tl1', 'owner', 'consultant', 'guest']

interface Invitation {
  id: string
  team_id: string
  email: string | null
  role: Role
  boat_id: string | null
  valid_from: string | null
  valid_to: string | null
  data_from: string | null
  data_to: string | null
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
  teamName,
  boats,
}: {
  teamId: string
  /** Named in the message that goes to WhatsApp, and in the QR's filename. */
  teamName: string
  boats: Boat[]
}) {
  const router = useRouter()
  const [list, setList] = useState<Invitation[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Form state — email
  const [email, setEmail] = useState('')
  const [emailRole, setEmailRole] = useState<Role>('tl3')
  const [emailBoatId, setEmailBoatId] = useState('')
  // Consultant-only windows (shown when emailRole === 'consultant').
  const [validFrom, setValidFrom] = useState('') // login access window
  const [validTo, setValidTo] = useState('')
  const [dataFrom, setDataFrom] = useState('') // session dates they may VIEW
  const [dataTo, setDataTo] = useState('')

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
    if (emailRole === 'consultant' && (!validFrom || !validTo)) {
      setErr('Consultant invites need an Access from / to window.')
      return
    }
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
          valid_from: validFrom || null,
          valid_to: validTo || null,
          data_from: dataFrom || null,
          data_to: dataTo || null,
        }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) {
        setErr(j.error || `failed (${res.status})`)
        return
      }
      // Surface email-delivery problems. WHICH advice depends on what actually
      // happened, and the two are opposite:
      //
      //   provisioned — the account EXISTS and is active, and the invite link
      //     was deliberately consumed, so copying it hands over a dead URL.
      //     They recover with "Forgot password?", which goes to their own
      //     address. We do NOT surface the one-click set-password link: it is
      //     a capability to become that person, and the inviter should not
      //     hold it for somebody else's address.
      //
      //   not provisioned — no account was made, the invite link is live, and
      //     copying it is exactly right.
      // Surface email-delivery problems, with advice that matches what is
      // actually true of the link now. The invitation is no longer consumed at
      // send time, so for a provisioned invite the /welcome link below IS live
      // — which is the only way in when the mail did not land.
      if (j.email_sent && !j.email_sent.ok && j.email_sent.notConfigured) {
        setErr(
          `${j.provisioned ? 'Set up and active' : 'Invitation created'} — but this environment cannot ` +
          `send email at all: RESEND_API_KEY and RESEND_FROM are not set, so nothing will reach anybody ` +
          `from here. Expected on a dev server; in production, fix that before inviting anyone. ` +
          `Meanwhile the link below works — give it to them yourself.`
        )
      } else if (j.email_sent && !j.email_sent.ok) {
        setErr(
          j.provisioned
            ? `Set up and active — but the email failed: ${j.email_sent.error}. ` +
              `Copy the link below and give it to them yourself; it sets their ` +
              `password, so treat it like one and send it to them directly. ` +
              `"Forgot password?" on the sign-in page does the same job if you ` +
              `would rather it went to their address.`
            : `Invite created, but email failed: ${j.email_sent.error}. Copy the URL below.`
        )
      }
      setEmail('')
      setValidFrom('')
      setValidTo('')
      setDataFrom('')
      setDataTo('')
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

  // TWO ROADS, two links, and handing over the wrong one wastes somebody's
  // evening. An email-targeted invitation (Road 1) points at /welcome/<token>:
  // the account already exists and that page sets its password. An open link
  // (Road 2, the QR code) points at /join/<token>, where a stranger signs
  // themselves up and waits for approval.
  function urlFor(inv: Invitation): string {
    return inv.email
      ? `${origin}/welcome/${inv.token}`
      : `${origin}/join/${inv.token}`
  }

  /** Everything the share buttons need, for whichever invitation is open. */
  function shareFor(inv: Invitation) {
    const url = urlFor(inv)
    // An email-targeted invitation points at /welcome, which SETS THAT
    // PERSON'S PASSWORD. It is not a thing to post in a group chat, and the
    // message, the warning and the missing WhatsApp button all say so.
    const personal = !!inv.email
    const share = { teamName, url, personal }
    return { url, personal, message: inviteMessage(share), subject: inviteSubject(share) }
  }

  /** The QR as a PNG — for saving, and for a native share that carries the
   *  image rather than a bare link. Rendered here rather than scraped out of
   *  the <img>, so it is full size whatever the dialog is showing. */
  async function qrPng(url: string): Promise<Blob | null> {
    try {
      const QRCode = (await import('qrcode')).default
      const dataUrl = await QRCode.toDataURL(url, { errorCorrectionLevel: 'M', margin: 2, width: 1024 })
      return await (await fetch(dataUrl)).blob()
    } catch {
      return null
    }
  }

  async function saveQr(inv: Invitation) {
    const blob = await qrPng(urlFor(inv))
    if (!blob) { setErr('Could not draw the QR to save.'); return }
    const href = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = href
    a.download = qrFileName(teamName)
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(href), 60_000)
  }

  /** The phone's own share sheet, with the QR attached where that is allowed. */
  async function shareNative(inv: Invitation) {
    const { url, message } = shareFor(inv)
    const nav = navigator as Navigator & {
      share?: (d: ShareData) => Promise<void>
      canShare?: (d: ShareData) => boolean
    }
    if (!nav.share) return
    try {
      const blob = await qrPng(url)
      const file = blob ? new File([blob], qrFileName(teamName), { type: 'image/png' }) : null
      if (file && nav.canShare?.({ files: [file] })) {
        await nav.share({ text: message, files: [file] })
        return
      }
      await nav.share({ text: message, url })
    } catch {
      // The sheet was dismissed. Not an error worth saying anything about.
    }
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
          The account is created and added to the team straight away. They get
          an email saying their membership is set up, with a link to choose a
          password &mdash; nothing to approve and no address to confirm.
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
                {roleLabel(r)}
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

          {emailRole === 'consultant' && (
            <div className="w-full mt-2 grid grid-cols-2 sm:grid-cols-4 gap-2">
              <label className="text-xs text-slate-600">
                Access from
                <input
                  type="date"
                  value={validFrom}
                  onChange={(e) => setValidFrom(e.target.value)}
                  title="When the consultant can start logging in"
                  className="block mt-1 w-full rounded-lg border border-slate-300 bg-white text-slate-900 px-2 py-1.5 text-sm"
                />
              </label>
              <label className="text-xs text-slate-600">
                Access to
                <input
                  type="date"
                  value={validTo}
                  onChange={(e) => setValidTo(e.target.value)}
                  title="When the consultant's login access ends"
                  className="block mt-1 w-full rounded-lg border border-slate-300 bg-white text-slate-900 px-2 py-1.5 text-sm"
                />
              </label>
              <label className="text-xs text-slate-600">
                Data from
                <input
                  type="date"
                  value={dataFrom}
                  onChange={(e) => setDataFrom(e.target.value)}
                  title="Earliest session date they may view (blank = all)"
                  className="block mt-1 w-full rounded-lg border border-slate-300 bg-white text-slate-900 px-2 py-1.5 text-sm"
                />
              </label>
              <label className="text-xs text-slate-600">
                Data to
                <input
                  type="date"
                  value={dataTo}
                  onChange={(e) => setDataTo(e.target.value)}
                  title="Latest session date they may view (blank = all)"
                  className="block mt-1 w-full rounded-lg border border-slate-300 bg-white text-slate-900 px-2 py-1.5 text-sm"
                />
              </label>
              <p className="col-span-2 sm:col-span-4 text-xs text-slate-500">
                <strong>Access</strong> = login window. <strong>Data</strong> = which session dates they can
                view (blank = all). E.g. inviting a sailmaker on 1 Jul to see only 25–27 Jun: Access from today,
                Data 25 Jun → 27 Jun.
              </p>
            </div>
          )}
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
                  {roleLabel(r)}
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
                    className="text-sm font-medium text-blue-600 hover:underline"
                  >
                    Share…
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
            {(() => {
              const { url, personal, message, subject } = shareFor(qrFor)
              const canNative = typeof navigator !== 'undefined' && 'share' in navigator
              const act = 'rounded-lg border border-slate-300 text-slate-700 px-3 py-2 text-sm hover:bg-slate-50'
              return (
                <>
                  <h3 className="text-lg font-semibold text-slate-900 mb-1">
                    {personal ? `Set-up link for ${qrFor.email}` : `Join ${teamName}`}
                  </h3>
                  {personal ? (
                    // The one case where the cheerful share row would be a
                    // mistake: this link sets that person's password, so
                    // anybody holding it can become them.
                    <p className="mb-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-left text-xs text-amber-900">
                      <b>Send this to {qrFor.email} and nobody else.</b> It sets their password,
                      so treat it like one — not the group chat.
                    </p>
                  ) : (
                    <p className="text-xs text-slate-500 mb-3">
                      Anyone who opens this signs themselves up and lands in your pending queue
                      for approval. They can do nothing until you approve them.
                    </p>
                  )}
                  <div className="flex justify-center mb-3">
                    <QRCodeSVG text={url} size={240} />
                  </div>
                  <p className="text-xs text-slate-400 mb-4 break-all">{url}</p>

                  <div className="grid grid-cols-2 gap-2 mb-2">
                    {!personal && (
                      <a
                        href={whatsappHref(message)}
                        target="_blank" rel="noopener noreferrer"
                        className="rounded-lg bg-[#25D366] hover:bg-[#1FBE5A] text-white px-3 py-2 text-sm font-medium"
                      >
                        WhatsApp
                      </a>
                    )}
                    <a
                      href={mailtoHref(subject, message, personal ? qrFor.email || '' : '')}
                      className={`${act} ${personal ? 'col-span-2' : ''}`}
                    >
                      Email
                    </a>
                    <button onClick={() => copy(url)} className={act}>Copy link</button>
                    <button onClick={() => copy(message)} className={act}>Copy message</button>
                    <button onClick={() => void saveQr(qrFor)} className={act}>Save QR</button>
                    {canNative && (
                      <button onClick={() => void shareNative(qrFor)} className={act}>Share…</button>
                    )}
                  </div>
                  <button
                    onClick={() => setQrFor(null)}
                    className="w-full rounded-lg border border-slate-300 text-slate-700 px-4 py-2 text-sm"
                  >
                    Close
                  </button>
                </>
              )
            })()}
          </div>
        </div>
      )}
    </section>
  )
}
