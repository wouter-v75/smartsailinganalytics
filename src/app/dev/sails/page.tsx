'use client'
import * as React from 'react'
import dynamic from 'next/dynamic'

// Preview harness for the Sail inventory row's EDIT form — where kind, sail
// type, group and weight are now hand-editable. Fixture data, no session: the
// last patch it would have sent is printed underneath, which is the thing worth
// checking (that design shapes never travel through the form, above all).
const SailRow = dynamic(
  () => import('@/components/BoatConfigTab').then((m) => m.SailRow),
  { ssr: false }
)

const td: React.CSSProperties = { padding: '6px 8px', fontSize: 12, color: '#cbd5e1', borderBottom: '1px solid #0F2030' }
const input: React.CSSProperties = { background: '#04101c', border: '1px solid #1E3A5A', borderRadius: 6, padding: '5px 7px', color: '#e2e8f0', fontSize: 13 }
const btn = (bg: string): React.CSSProperties => ({ background: bg, border: 'none', borderRadius: 6, padding: '4px 10px', color: '#001018', fontSize: 11, fontWeight: 800, cursor: 'pointer' })

const SAILS = [
  {
    id: 's1', name: 'MAIN_2026', category: 'MAIN', kind: 'mainsail', build_date: '2026-01-15',
    retired: false,
    specs: { sail_type: 'Mainsail', sail_group: 'M', weight_kg: 116.6, source: 'event-file',
             design_shapes: { conditions: [{ tws: 8 }, { tws: 14 }, { tws: 20 }] } },
  },
  {
    id: 's2', name: 'Delivery main', category: 'MAIN', kind: null, build_date: null, retired: false,
    specs: {},
  },
  {
    id: 's3', name: 'A2_2026', category: 'A2', kind: 'spinnaker', build_date: null, retired: false,
    specs: { sail_type: 'Reaching Kite', sail_group: 'S', weight_kg: 49.2, source: 'event-file' },
  },
  {
    id: 's4', name: 'MAIN_2024', category: 'MAIN', kind: 'mainsail', build_date: '2024-02-01',
    retired: true,
    specs: { sail_type: 'Mainsail', sail_group: 'M', weight_kg: 119.4, source: 'event-file' },
  },
]

export default function SailRowPreview() {
  const [patch, setPatch] = React.useState<unknown>(null)
  return (
    <div style={{ minHeight: '100dvh', background: '#04101c', padding: 12, color: '#cbd5e1' }}>
      <div style={{ fontSize: 11, color: '#8A97A9', marginBottom: 10 }}>
        Sail inventory row preview · fixture data · nothing is saved
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ fontSize: 11, color: '#8A97A9', textAlign: 'left' }}>
            <th style={td}>Cat</th><th style={td}>Sail name</th><th style={td}>Kind</th>
            <th style={td}>Sail type</th><th style={td}>Grp</th><th style={td}>Wt (kg)</th>
            <th style={td}>Build date</th><th style={td}>Status</th><th style={td}>Certificate</th>
            <th style={td}>Sailshape design</th><th style={td} />
          </tr>
        </thead>
        <tbody>
          {SAILS.map((s) => (
            <SailRow
              key={s.id} sail={s} canEdit busy={false}
              td={td} input={input} btn={btn}
              onPatch={setPatch} onCert={() => {}} onDelete={() => {}} onShowDesign={() => {}}
            />
          ))}
        </tbody>
      </table>
      <pre id="patch" style={{ marginTop: 14, fontSize: 11, color: '#7DD3FC', whiteSpace: 'pre-wrap' }}>
        {patch ? JSON.stringify(patch, null, 2) : 'no patch yet'}
      </pre>
    </div>
  )
}
