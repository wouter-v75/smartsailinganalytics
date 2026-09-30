'use client'
import * as React from 'react'
import { DeleteButton } from '@/components/video/DeleteButton'

// Preview harness for the clip delete button, without a signed-in session or a
// day of sailing behind it.
//
//   /dev/delete-button
//
// The four shapes below are the ones that decide what the button offers, and
// getting that decision wrong is what made deleted clips come back:
//
//   storage-only  a clip uploaded to Bunny STORAGE — no streamId. The old gate
//                 was `!!video.streamId`, so this got the local-only button
//                 labelled "Confirm delete", and its cloud row survived.
//   cloud-only    source 'supabase' — no local blob. The old button deleted
//                 NOTHING for these and the card came back on the next sync.
//   unmerged      uploaded, but loadDate has not stamped a cloudId yet, so the
//                 row can only be found by the IDB key it was mirrored from.
//   never-up      no cloud row at all. Nothing to fail, nothing to warn about.
//
// The button talks to the real API here. Without a session that is a refusal,
// which is the point of the harness: a refusal must leave the clip alone and
// say why, rather than tick and let the next sync bring it back.

const CLIPS: Array<{ key: string; label: string; video: Record<string, unknown> }> = [
  {
    key: 'storage-only',
    label: 'Uploaded to Bunny Storage (no stream id) — the 29 Sep clips',
    video: {
      id: 'v_1779206586594_abc',
      title: '20260929132920_gate',
      source: 'local',
      cloudId: '11111111-2222-3333-4444-555555555555',
      streamId: null,
    },
  },
  {
    key: 'cloud-only',
    label: 'Cloud-only (uploaded from another device)',
    video: {
      id: '22222222-3333-4444-5555-666666666666',
      title: '20260929134838_topmark',
      source: 'supabase',
      streamId: null,
    },
  },
  {
    key: 'unmerged',
    label: 'Uploaded, merge has not run — only the IDB key can find the row',
    video: { id: 'v_1779206586594_xyz', title: '20260929151732_gate', source: 'local' },
  },
  {
    key: 'never-up',
    label: 'Never uploaded — local only',
    video: { id: 'v_1779206586594_new', title: 'DJI_0007', source: 'local' },
  },
]

export default function DeleteButtonPreview() {
  const [gone, setGone] = React.useState<string[]>([])
  const [cloudUp, setCloudUp] = React.useState(true)
  return (
    <div style={{ minHeight: '100dvh', background: '#04101c', padding: 16, color: '#8A97A9', fontSize: 12 }}>
      <div style={{ display: 'flex', gap: 12, marginBottom: 16, alignItems: 'center' }}>
        <span>Clip delete preview · fixture clips</span>
        <button
          onClick={() => setCloudUp((v) => !v)}
          style={{ minHeight: 44, color: '#06B6D4', background: 'none', border: 'none', textDecoration: 'underline', cursor: 'pointer' }}
        >
          cloud {cloudUp ? 'available' : 'unavailable'}
        </button>
        <span data-testid="deleted">deleted: {gone.join(', ') || '—'}</span>
      </div>
      <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))' }}>
        {CLIPS.map((c) => (
          <div key={c.key} data-testid={`case-${c.key}`} style={{ background: '#071624', borderRadius: 8, padding: 12, border: '1px solid #13293D' }}>
            <div style={{ color: '#CBD5E1', marginBottom: 2 }}>{c.video.title as string}</div>
            <div style={{ fontSize: 10, marginBottom: 4 }}>{c.label}</div>
            <DeleteButton
              video={c.video}
              cloudStatus={{ available: cloudUp }}
              onDeleted={(id: string) => setGone((p) => [...p, id])}
            />
          </div>
        ))}
      </div>
    </div>
  )
}
