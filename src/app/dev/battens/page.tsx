'use client'
import * as React from 'react'
import dynamic from 'next/dynamic'

// Preview harness for Boat → Battens. The panel fetches its own card, so this
// stubs nothing: point it at a real team/boat, or look at the empty state —
// which is what a boat that has not filled the card in yet actually sees.
const BattenCardPanel = dynamic(() => import('@/components/boat/BattenCardPanel'), { ssr: false })

export default function BattensPreview() {
  const [mobile, setMobile] = React.useState(false)
  return (
    <div style={{ minHeight: '100dvh', background: '#04101c', padding: 12 }}>
      <div style={{ display: 'flex', gap: 12, marginBottom: 12, color: '#8A97A9', fontSize: 11 }}>
        <span>Batten card preview · fixture ids</span>
        <button
          onClick={() => setMobile((v) => !v)}
          style={{ minHeight: 44, color: '#06B6D4', background: 'none', border: 'none', textDecoration: 'underline' }}
        >
          {mobile ? 'Desktop grid' : 'Phone layout'}
        </button>
      </div>
      <BattenCardPanel teamId="team-fixture" boatId="boat-fixture" canEdit isMobile={mobile} />
    </div>
  )
}
