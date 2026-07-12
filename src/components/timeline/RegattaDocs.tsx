'use client'
// ─────────────────────────────────────────────────────────────────────────────
// Regatta documents (NOR / SI / course notices) on the TIMELINE spine.
//
// The same attachments the Campaign tab uploads against a regatta — they live at
// campaign/attachments?date=<regatta's FIRST day>&kind=regatta. The Campaign tab
// lists them as text rows; here we show the thumbnail treatment used by the
// weather forecast card (ForecastThumb): a real first-page preview for PDFs via a
// 4× iframe scaled to 0.25, an <img> for images, and click-through to open the
// file in a new tab.
//
// Read-only by design. Uploading/removing stays in the Campaign tab so there is
// exactly one place that mutates the document set.
// ─────────────────────────────────────────────────────────────────────────────
import React from 'react'

const THUMB_W = 92
const THUMB_H = 120
const DOC_KIND = 'regatta' // must match CampaignTab's REGATTA_DOC_KIND

export interface Doc {
  id?: string
  name: string
  url?: string | null
  content_type?: string | null
}

// Exported so the speed-team meeting phase can render its PDFs with exactly this
// treatment (real first-page preview, click-through to a new tab) instead of a
// third bespoke document renderer.
export function DocThumb({ doc }: { doc: Doc }) {
  const isImg =
    /^image\//.test(doc.content_type || '') || /\.(png|jpe?g|gif|webp)$/i.test(doc.name || '')
  const isPdf = !isImg
  return (
    <div style={{ width: THUMB_W, flexShrink: 0 }}>
      <a
        href={doc.url || '#'}
        target="_blank"
        rel="noreferrer"
        title={`Open ${doc.name} in a new tab`}
        onClick={(e) => {
          if (!doc.url) e.preventDefault()
          e.stopPropagation() // don't collapse the regatta row behind us
        }}
        style={{ display: 'block', textDecoration: 'none' }}
      >
        <div
          style={{
            position: 'relative', width: THUMB_W, height: THUMB_H, borderRadius: 6,
            overflow: 'hidden', border: '1px solid #1E3A5A', background: '#fff', cursor: 'pointer',
          }}
        >
          {isImg && doc.url ? (
            <img src={doc.url} alt={doc.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          ) : isPdf && doc.url ? (
            <iframe
              src={`${doc.url}#page=1&toolbar=0&navpanes=0&scrollbar=0&view=FitH`}
              title={doc.name}
              scrolling="no"
              style={{
                position: 'absolute', top: 0, left: 0, width: THUMB_W * 4, height: THUMB_H * 4,
                border: 'none', transform: 'scale(0.25)', transformOrigin: '0 0',
                pointerEvents: 'none', background: '#fff',
              }}
            />
          ) : (
            <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'linear-gradient(160deg,#f8fafc,#e2e8f0)' }}>
              <span style={{ fontSize: 24 }}>📄</span>
            </div>
          )}
          {isPdf && (
            <span style={{ position: 'absolute', top: 3, right: 3, background: '#DC2626', color: '#fff', fontSize: 7, fontWeight: 800, borderRadius: 2, padding: '0 3px', letterSpacing: 0.5 }}>PDF</span>
          )}
          <span style={{ position: 'absolute', bottom: 2, right: 3, background: 'rgba(0,0,0,0.55)', color: '#fff', fontSize: 9, borderRadius: 3, padding: '0 3px' }}>↗</span>
        </div>
      </a>
      <div title={doc.name} style={{ fontSize: 9, color: '#94A3B8', marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {doc.name}
      </div>
    </div>
  )
}

export default function RegattaDocs({
  teamId,
  boatId,
  dateFrom,
}: {
  teamId?: string | null
  boatId?: string | null
  dateFrom?: string | null
}) {
  const [docs, setDocs] = React.useState<Doc[] | null>(null)

  React.useEffect(() => {
    if (!teamId || !boatId || !dateFrom) { setDocs([]); return }
    let alive = true
    fetch(`/api/teams/${teamId}/boats/${boatId}/campaign/attachments?date=${dateFrom}&kind=${DOC_KIND}`)
      .then((r) => (r.ok ? r.json() : { attachments: [] }))
      .then((j) => { if (alive) setDocs(j?.attachments || []) })
      .catch(() => { if (alive) setDocs([]) })
    return () => { alive = false }
  }, [teamId, boatId, dateFrom])

  if (docs === null) return <div className="py-2 text-xs text-muted">Loading documents…</div>
  if (!docs.length) return null // nothing uploaded — stay out of the way

  return (
    <div style={{ padding: '6px 0 10px' }}>
      <div style={{ fontSize: 9, letterSpacing: 1, textTransform: 'uppercase', color: '#475569', marginBottom: 6 }}>
        Documents
      </div>
      <div style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 2 }}>
        {docs.map((d) => (
          <DocThumb key={d.id} doc={d} />
        ))}
      </div>
    </div>
  )
}
