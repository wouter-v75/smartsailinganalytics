'use client'
import * as React from 'react'
import { Sailboat, Anchor, Target } from 'lucide-react'
import { AppShell, type ShellTab } from '@/components/ui/app-shell'
import { Card, Badge, Button, EmptyState, ErrorState, Skeleton } from '@/components/ui'
import { setUiNext } from '@/lib/ui-flags'
import targetsData from '@/data/targets-v1.4.json'

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
      {tab === 'polar' ? (
        <TargetsView />
      ) : tab === 'rig' ? (
        <RigView teamId={teamId} boatId={boatId} />
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

const T = targetsData as any
const num = (v: number | undefined, d = 0) => (v == null || Number.isNaN(v) ? '—' : v.toFixed(d))

function TargetsView() {
  const rows: any[] = Array.isArray(T.headline) ? T.headline : []
  const th = 'px-3 py-1 text-right font-normal'
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-sm font-medium text-fg">{T.name}</span>
        <Badge>{T.version}</Badge>
        <span className="text-xs text-muted">{T.source_note} · {T.wind_reference}</span>
      </div>
      <Card className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[11px] uppercase tracking-wide text-muted">
              <th className="px-3 py-2 text-left font-medium">TWS</th>
              <th className="px-3 py-2 text-right font-medium text-accent" colSpan={3}>Upwind</th>
              <th className="px-3 py-2 text-right font-medium" colSpan={3}>Downwind</th>
            </tr>
            <tr className="border-b border-[color:var(--border)] text-[11px] text-muted">
              <th className="px-3 py-1 text-left font-normal">kt</th>
              <th className={th}>TWA</th><th className={th}>BSP</th><th className={th}>Heel</th>
              <th className={th}>TWA</th><th className={th}>BSP</th><th className={th}>Heel</th>
            </tr>
          </thead>
          <tbody className="font-mono">
            {rows.map((r) => (
              <tr key={r.tws} className="border-t border-[color:var(--border)]">
                <td className="px-3 py-1.5 text-left font-medium text-fg">{r.tws}</td>
                <td className="px-3 py-1.5 text-right text-accent">{num(r.up?.twa)}°</td>
                <td className="px-3 py-1.5 text-right text-fg">{num(r.up?.bsp, 1)}</td>
                <td className="px-3 py-1.5 text-right text-secondary">{num(r.up?.heel)}°</td>
                <td className="px-3 py-1.5 text-right text-fg">{num(r.dn?.twa)}°</td>
                <td className="px-3 py-1.5 text-right text-fg">{num(r.dn?.bsp, 1)}</td>
                <td className="px-3 py-1.5 text-right text-secondary">{num(r.dn?.heel)}°</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  )
}

const RIG_ROWS: { label: string; key: string; suffix?: string; dp?: number }[] = [
  { label: 'TWS @ MH', key: 'twsAtMh' },
  { label: 'Rake', key: 'rakeDeg', suffix: '°', dp: 1 },
  { label: 'Mastbase pos', key: 'mastbasePosition' },
  { label: 'Shim', key: 'shimStack' },
  { label: 'Mastbase load', key: 'mastbaseLoadT', suffix: ' T', dp: 1 },
  { label: 'Headstay', key: 'headstayT', suffix: ' T', dp: 1 },
  { label: 'Jib tack', key: 'jibTackT', suffix: ' T', dp: 1 },
  { label: 'Main cunningham', key: 'mainCunninghamT', suffix: ' T', dp: 1 },
  { label: 'Bowsprit tack', key: 'bowspritTackT', suffix: ' T', dp: 1 },
  { label: 'Upper deflector', key: 'upperDeflectorCylStroke' },
  { label: 'Lower deflector', key: 'lowerDeflectorCylStroke' },
]

function RigView({ teamId, boatId }: { teamId: string; boatId: string }) {
  const [tune, setTune] = React.useState<any | null | undefined>(undefined)
  const [err, setErr] = React.useState(false)
  const load = React.useCallback(() => {
    setErr(false); setTune(undefined)
    fetch(`/api/teams/${teamId}/rig-tunes?boat_id=${boatId}&active=1`)
      .then((r) => r.json())
      .then((j) => setTune((Array.isArray(j?.rigTunes) ? j.rigTunes[0] : null) || null))
      .catch(() => setErr(true))
  }, [teamId, boatId])
  React.useEffect(() => { load() }, [load])

  if (err) return <ErrorState description="Couldn't load the rig baseline." onRetry={load} />
  if (tune === undefined) return <div className="grid gap-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-24 w-full" />)}</div>
  if (!tune) return <Card><EmptyState icon={Anchor} title="No rig baseline yet" description="Upload the JV76 rig sheet PDF in the classic view." /></Card>

  const cols: any[] = Array.isArray(tune.data?.columns) ? tune.data.columns : []
  const header = (c: any) => [c.mainsail, c.headsail].filter(Boolean).join(' / ') || c.twsAtMh || '—'
  const cell = (c: any, r: (typeof RIG_ROWS)[number]) => {
    const v = c[r.key]
    if (v == null || v === '') return '—'
    if (typeof v === 'number') return (r.dp != null ? v.toFixed(r.dp) : String(v)) + (r.suffix || '')
    return String(v)
  }

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-sm font-medium text-fg">{tune.name || 'Rig baseline'}</span>
        {tune.revision && <Badge>{tune.revision}</Badge>}
        {tune.effective_date && <span className="text-xs text-muted">effective {tune.effective_date}</span>}
      </div>
      <Card className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[color:var(--border)] text-[11px] uppercase tracking-wide text-muted">
              <th className="px-3 py-2 text-left font-medium">Setting</th>
              {cols.map((c, i) => (
                <th key={i} className="whitespace-nowrap px-3 py-2 text-right font-medium text-fg">{header(c)}</th>
              ))}
            </tr>
          </thead>
          <tbody className="font-mono">
            {RIG_ROWS.map((r) => (
              <tr key={r.label} className="border-t border-[color:var(--border)]">
                <td className="whitespace-nowrap px-3 py-1.5 text-left font-sans text-secondary">{r.label}</td>
                {cols.map((c, i) => (
                  <td key={i} className="whitespace-nowrap px-3 py-1.5 text-right text-fg">{cell(c, r)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
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
