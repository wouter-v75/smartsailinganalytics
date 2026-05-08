'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

export default function CreateTeamForm() {
  const router = useRouter()
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setErr(null)
    if (!name.trim()) return
    setBusy(true)
    try {
      const res = await fetch('/api/admin/teams', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() }),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        setErr(j.error || `failed (${res.status})`)
        return
      }
      setName('')
      router.refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={onSubmit} className="mb-6 flex gap-2">
      <input
        type="text"
        placeholder="New team name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="flex-1 rounded-lg border border-slate-300 bg-white text-slate-900 placeholder:text-slate-400 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
      />
      <button
        type="submit"
        disabled={busy || !name.trim()}
        className="rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white px-4 py-2 font-medium"
      >
        {busy ? 'Creating…' : 'Create team'}
      </button>
      {err && (
        <span className="self-center text-sm text-red-600">{err}</span>
      )}
    </form>
  )
}
