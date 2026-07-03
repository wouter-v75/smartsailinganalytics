'use client'
import * as React from 'react'
import { Sailboat, Anchor, Target, Ruler } from 'lucide-react'
import { AppShell, type ShellTab } from '@/components/ui/app-shell'
import { Card, Badge, Button, EmptyState, ErrorState, Skeleton } from '@/components/ui'
import { setUiNext } from '@/lib/ui-flags'

// Reference migration (Phase 1): the Boat Config sail inventory, rebuilt on the
// design system + AppShell, behind ?ui=next. Proves tokens/primitives/theme/
// responsive/real-data end-to-end without rewriting the whole legacy tab.
interface Sail {
  id: string; name: string; category?: string | null; kind?: string | null
  retired?: boolean; sailmaker?: string | null; build_date?: string | null
}

export default function BoatConfigNext({
  teamId, boatId, boatName,
}: { teamId: string; boatId: string; boatName?: string | null }) {
  const [tab, setTab] = React.useState('sails')
  const [sails, setSails] = React.useState<Sail[] | null>(null)
  const [err, setErr] = React.useState(false)

  const load = React.useCallback(() => {
    setErr(false); setSails(null)
    fetch(`/api/teams/${teamId}/sails?boat_id=${boatId}`)
      .then((r) => r.json())
      .then((j) => setSails(Array.isArray(j?.sails) ? j.sails : []))
      .catch(() => setErr(true))
  }, [teamId, boatId])
  React.useEffect(() => { load() }, [load])

  const tabs: ShellTab[] = [
    { key: 'sails', label: 'Sails', icon: <Sailboat size={15} aria-hidden /> },
    { key: 'rig', label: 'Rig', icon: <Anchor size={15} aria-hidden /> },
    { key: 'polar', label: 'Polar', icon: <Target size={15} aria-hidden /> },
  ]

  const active = sails?.filter((s) => !s.retired) ?? []
  const retired = sails?.filter((s) => s.retired) ?? []

  return (
    <AppShell
      title="Boat config"
      subtitle={boatName || undefined}
      tabs={tabs}
      activeTab={tab}
      onTab={setTab}
      actions={<Button variant="ghost" size="sm" onClick={() => setUiNext(false)}>Classic view</Button>}
    >
      {tab !== 'sails' ? (
        <Card><EmptyState icon={Ruler} title={`${tab === 'rig' ? 'Rig' : 'Polar'} — coming to the new UI`} description="This section moves to the redesigned interface next." /></Card>
      ) : err ? (
        <ErrorState description="Couldn't load the sail inventory." onRetry={load} />
      ) : sails === null ? (
        <div className="grid gap-2">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-[60px] w-full" />)}</div>
      ) : sails.length === 0 ? (
        <Card><EmptyState icon={Sailboat} title="No sails yet" description="Import the inventory from an event file's saillist in the classic view." /></Card>
      ) : (
        <div className="grid gap-4">
          <SailList sails={active} />
          {retired.length > 0 && (
            <div>
              <div className="mb-2 text-xs uppercase tracking-wide text-muted">Retired</div>
              <SailList sails={retired} />
            </div>
          )}
        </div>
      )}

      <div className="mt-4 text-xs text-muted">
        {sails ? `${sails.length} sail${sails.length === 1 ? '' : 's'} · ` : ''}reference migration behind <code>?ui=next</code>
      </div>
    </AppShell>
  )
}

function SailList({ sails }: { sails: Sail[] }) {
  return (
    <div className="grid gap-2">
      {sails.map((s) => (
        <Card key={s.id} className="flex items-center gap-3 p-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded bg-surface-2 text-secondary">
            <Sailboat size={18} aria-hidden />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="truncate text-sm font-medium text-fg">{s.name}</span>
              {s.category && <Badge tone="accent">{s.category}</Badge>}
              {s.retired && <Badge tone="warning">retired</Badge>}
            </div>
            <div className="truncate text-xs text-muted">
              {[s.kind, s.sailmaker, s.build_date].filter(Boolean).join(' · ') || '—'}
            </div>
          </div>
        </Card>
      ))}
    </div>
  )
}
