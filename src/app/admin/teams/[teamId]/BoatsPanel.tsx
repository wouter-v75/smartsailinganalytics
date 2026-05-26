'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

interface Boat {
  id: string
  name: string
  sail_number: string | null
  length_m: number | null
}

type Unit = 'm' | 'ft'

// Convert a typed length + its unit into metres (the canonical storage unit).
// Returns null when the input is empty or unparseable.
function toMetres(value: string, unit: Unit): number | null {
  const n = parseFloat(value)
  if (!Number.isFinite(n) || n <= 0) return null
  return unit === 'ft' ? n * 0.3048 : n
}

// Round-trip a metres value to a displayable string in the chosen unit.
function fromMetres(m: number | null, unit: Unit): string {
  if (m == null) return ''
  return unit === 'ft'
    ? (m / 0.3048).toFixed(1)
    : m.toFixed(2)
}

// "LOA 21.95 m (72.0 ft)" / null when length isn't set.
function formatLengthDisplay(m: number | null): string | null {
  if (m == null) return null
  return `LOA ${m.toFixed(2)} m (${(m / 0.3048).toFixed(1)} ft)`
}

export default function BoatsPanel({
  teamId,
  boats,
}: {
  teamId: string
  boats: Boat[]
}) {
  const router = useRouter()
  const [name, setName] = useState('')
  const [sailNumber, setSailNumber] = useState('')
  const [length, setLength] = useState('')
  const [unit, setUnit] = useState<Unit>('m')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editSail, setEditSail] = useState('')
  const [editLength, setEditLength] = useState('')
  const [editUnit, setEditUnit] = useState<Unit>('m')

  // Flipping the unit toggle should convert the currently-typed value so the
  // user sees the same physical length expressed in the new unit, rather than
  // silently reinterpreting their number.
  function switchUnit(
    next: Unit,
    current: Unit,
    value: string,
    setValue: (s: string) => void,
    setU: (u: Unit) => void,
  ) {
    if (next === current) return
    const n = parseFloat(value)
    if (Number.isFinite(n) && n > 0) {
      setValue(
        next === 'ft'
          ? (n / 0.3048).toFixed(1)
          : (n * 0.3048).toFixed(2),
      )
    }
    setU(next)
  }

  async function add(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    setBusy(true)
    setErr(null)
    try {
      const lengthM = length.trim() ? toMetres(length, unit) : null
      const res = await fetch(`/api/admin/teams/${teamId}/boats`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          sail_number: sailNumber.trim() || null,
          length_m: lengthM,
        }),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        setErr(j.error || `failed (${res.status})`)
        return
      }
      setName('')
      setSailNumber('')
      setLength('')
      router.refresh()
    } finally {
      setBusy(false)
    }
  }

  function startEdit(b: Boat) {
    setEditingId(b.id)
    setEditName(b.name)
    setEditSail(b.sail_number || '')
    // Always edit in metres by default — that's the storage unit; user can
    // flip the toggle to ft and the number above re-converts.
    setEditUnit('m')
    setEditLength(fromMetres(b.length_m, 'm'))
    setErr(null)
  }

  async function saveEdit(boatId: string) {
    if (!editName.trim()) {
      setErr('Name required')
      return
    }
    setBusy(true)
    setErr(null)
    try {
      const lengthM = editLength.trim() ? toMetres(editLength, editUnit) : null
      const res = await fetch(
        `/api/admin/teams/${teamId}/boats/${boatId}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: editName.trim(),
            sail_number: editSail.trim() || null,
            length_m: lengthM,
          }),
        }
      )
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        setErr(j.error || `failed (${res.status})`)
        return
      }
      setEditingId(null)
      router.refresh()
    } finally {
      setBusy(false)
    }
  }

  async function destroy(boatId: string, boatName: string) {
    if (
      !confirm(
        `Delete boat "${boatName}"? Memberships scoped to it are removed.`
      )
    ) {
      return
    }
    setBusy(true)
    try {
      const res = await fetch(
        `/api/admin/teams/${teamId}/boats/${boatId}`,
        { method: 'DELETE' }
      )
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        setErr(j.error || `failed (${res.status})`)
        return
      }
      router.refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="mb-8">
      <h2 className="text-sm font-semibold text-slate-700 uppercase tracking-wide mb-2">
        Boats ({boats.length})
      </h2>

      <form onSubmit={add} className="mb-3 flex gap-2 flex-wrap">
        <input
          type="text"
          placeholder="Boat name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="flex-1 min-w-[12rem] rounded-lg border border-slate-300 bg-white text-slate-900 placeholder:text-slate-400 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <input
          type="text"
          placeholder="Sail # (optional)"
          value={sailNumber}
          onChange={(e) => setSailNumber(e.target.value)}
          className="w-40 rounded-lg border border-slate-300 bg-white text-slate-900 placeholder:text-slate-400 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <input
          type="number"
          inputMode="decimal"
          step="0.1"
          min="0"
          placeholder={`Length (${unit})`}
          value={length}
          onChange={(e) => setLength(e.target.value)}
          className="w-32 rounded-lg border border-slate-300 bg-white text-slate-900 placeholder:text-slate-400 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <select
          value={unit}
          onChange={(e) =>
            switchUnit(e.target.value as Unit, unit, length, setLength, setUnit)
          }
          className="w-16 rounded-lg border border-slate-300 bg-white text-slate-900 px-2 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="m">m</option>
          <option value="ft">ft</option>
        </select>
        <button
          type="submit"
          disabled={busy || !name.trim()}
          className="rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white px-4 py-2 text-sm font-medium"
        >
          Add boat
        </button>
      </form>

      {err && <p className="mb-2 text-sm text-red-600">{err}</p>}

      <div className="bg-white rounded-xl shadow border border-slate-200 divide-y divide-slate-100">
        {boats.length === 0 ? (
          <div className="p-4 text-slate-500 text-sm text-center">
            No boats yet.
          </div>
        ) : (
          boats.map((b) => (
            <div
              key={b.id}
              className="flex items-center justify-between gap-2 px-4 py-3 flex-wrap"
            >
              {editingId === b.id ? (
                <>
                  <input
                    type="text"
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    className="flex-1 min-w-[10rem] rounded-lg border border-slate-300 bg-white text-slate-900 px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="Boat name"
                  />
                  <input
                    type="text"
                    value={editSail}
                    onChange={(e) => setEditSail(e.target.value)}
                    className="w-32 rounded-lg border border-slate-300 bg-white text-slate-900 px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="Sail #"
                  />
                  <input
                    type="number"
                    inputMode="decimal"
                    step="0.1"
                    min="0"
                    value={editLength}
                    onChange={(e) => setEditLength(e.target.value)}
                    className="w-24 rounded-lg border border-slate-300 bg-white text-slate-900 px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder={`LOA (${editUnit})`}
                  />
                  <select
                    value={editUnit}
                    onChange={(e) =>
                      switchUnit(
                        e.target.value as Unit,
                        editUnit,
                        editLength,
                        setEditLength,
                        setEditUnit,
                      )
                    }
                    className="w-14 rounded-lg border border-slate-300 bg-white text-slate-900 px-1 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="m">m</option>
                    <option value="ft">ft</option>
                  </select>
                  <div className="flex gap-1">
                    <button
                      disabled={busy}
                      onClick={() => saveEdit(b.id)}
                      className="rounded-lg bg-blue-600 hover:bg-blue-700 text-white px-3 py-1 text-sm disabled:opacity-50"
                    >
                      Save
                    </button>
                    <button
                      disabled={busy}
                      onClick={() => setEditingId(null)}
                      className="rounded-lg border border-slate-300 text-slate-700 px-3 py-1 text-sm"
                    >
                      Cancel
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div className="flex-1">
                    <div className="font-medium text-slate-900">{b.name}</div>
                    <div className="text-xs text-slate-500 space-x-2">
                      {b.sail_number && <span>Sail #{b.sail_number}</span>}
                      {b.length_m != null && (
                        <span>{formatLengthDisplay(b.length_m)}</span>
                      )}
                      {!b.sail_number && b.length_m == null && (
                        <span className="italic text-slate-400">
                          no sail # · no length set
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex gap-3">
                    <button
                      onClick={() => startEdit(b)}
                      className="text-sm text-blue-600 hover:underline"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => destroy(b.id, b.name)}
                      className="text-sm text-red-600 hover:underline"
                    >
                      Delete
                    </button>
                  </div>
                </>
              )}
            </div>
          ))
        )}
      </div>
    </section>
  )
}
