'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

export default function TeamHeader({
  team,
}: {
  team: { id: string; name: string }
}) {
  const router = useRouter()
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(team.name)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function save() {
    setBusy(true)
    setErr(null)
    try {
      const res = await fetch(`/api/admin/teams/${team.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() }),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        setErr(j.error || `failed (${res.status})`)
        return
      }
      setEditing(false)
      router.refresh()
    } finally {
      setBusy(false)
    }
  }

  async function destroy() {
    if (
      !confirm(
        `Delete team "${team.name}"? This removes all boats and memberships in it.`
      )
    ) {
      return
    }
    setBusy(true)
    try {
      const res = await fetch(`/api/admin/teams/${team.id}`, {
        method: 'DELETE',
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        setErr(j.error || `failed (${res.status})`)
        return
      }
      router.push('/admin/teams')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mb-6 flex items-center justify-between gap-3">
      {editing ? (
        <div className="flex items-center gap-2 flex-1">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="flex-1 rounded-lg border border-slate-300 bg-white text-slate-900 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <button
            disabled={busy}
            onClick={save}
            className="rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white px-4 py-2 text-sm font-medium"
          >
            Save
          </button>
          <button
            disabled={busy}
            onClick={() => {
              setEditing(false)
              setName(team.name)
            }}
            className="rounded-lg border border-slate-300 text-slate-700 px-4 py-2 text-sm"
          >
            Cancel
          </button>
        </div>
      ) : (
        <>
          <h1 className="text-2xl font-semibold text-slate-900">{team.name}</h1>
          <div className="flex gap-2">
            <button
              onClick={() => setEditing(true)}
              className="rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-100 px-3 py-1.5 text-sm"
            >
              Rename
            </button>
            <button
              disabled={busy}
              onClick={destroy}
              className="rounded-lg border border-red-300 text-red-700 hover:bg-red-50 px-3 py-1.5 text-sm disabled:opacity-50"
            >
              Delete
            </button>
          </div>
        </>
      )}
      {err && <span className="text-xs text-red-600">{err}</span>}
    </div>
  )
}
