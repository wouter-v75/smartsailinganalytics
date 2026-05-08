'use client'

// Per-user action buttons (Approve / Disable / Reactivate). Calls the
// /api/admin/users route which performs the privileged write via the
// service-role key.

import { useState } from 'react'
import { useRouter } from 'next/navigation'

type Status = 'pending' | 'active' | 'disabled'
type Action = 'approve' | 'disable' | 'reactivate'

export default function UserActions({
  userId,
  status,
}: {
  userId: string
  status: Status
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function run(action: Action) {
    setBusy(true)
    setErr(null)
    try {
      const res = await fetch('/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, action }),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        setErr(j.error || `Request failed (${res.status})`)
        return
      }
      router.refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex items-center gap-2 shrink-0">
      {err && <span className="text-xs text-red-600">{err}</span>}
      {status === 'pending' && (
        <>
          <button
            disabled={busy}
            onClick={() => run('approve')}
            className="px-3 py-1.5 text-sm rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white disabled:opacity-50"
          >
            Approve
          </button>
          <button
            disabled={busy}
            onClick={() => run('disable')}
            className="px-3 py-1.5 text-sm rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            Reject
          </button>
        </>
      )}
      {status === 'active' && (
        <button
          disabled={busy}
          onClick={() => run('disable')}
          className="px-3 py-1.5 text-sm rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50 disabled:opacity-50"
        >
          Disable
        </button>
      )}
      {status === 'disabled' && (
        <button
          disabled={busy}
          onClick={() => run('reactivate')}
          className="px-3 py-1.5 text-sm rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white disabled:opacity-50"
        >
          Reactivate
        </button>
      )}
    </div>
  )
}
