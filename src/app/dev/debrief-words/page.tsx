'use client'
import * as React from 'react'
import dynamic from 'next/dynamic'

// Preview harness for Boat → Debrief words, without a signed-in session or a
// boat behind it.
//
//   /dev/debrief-words                 read-write, against the real API
//   /dev/debrief-words?readonly=1      what a crew member without the role sees
//
// The panel fetches its own vocabulary, so this stubs nothing: point it at a
// real team/boat, or look at the empty state — which is what a boat that has
// never added a word actually sees, and is the state that must read as "the
// built-in list applies" rather than "there is no glossary".
const DebriefVocabPanel = dynamic(() => import('@/components/boat/DebriefVocabPanel'), { ssr: false })

export default function DebriefWordsPreview() {
  const [mobile, setMobile] = React.useState(false)
  const [readOnly, setReadOnly] = React.useState(false)
  React.useEffect(() => {
    setReadOnly(new URLSearchParams(window.location.search).has('readonly'))
  }, [])
  return (
    <div style={{ minHeight: '100dvh', background: '#04101c', padding: 12 }}>
      <div style={{ display: 'flex', gap: 12, marginBottom: 12, color: '#8A97A9', fontSize: 11, alignItems: 'center' }}>
        <span>Debrief words preview · fixture ids</span>
        <button
          onClick={() => setMobile((v) => !v)}
          style={{ minHeight: 44, color: '#06B6D4', background: 'none', border: 'none', textDecoration: 'underline', cursor: 'pointer' }}
        >
          {mobile ? 'Desktop grid' : 'Phone layout'}
        </button>
        <button
          onClick={() => setReadOnly((v) => !v)}
          style={{ minHeight: 44, color: '#06B6D4', background: 'none', border: 'none', textDecoration: 'underline', cursor: 'pointer' }}
        >
          {readOnly ? 'Editable' : 'Read-only'}
        </button>
      </div>
      <DebriefVocabPanel teamId="team-fixture" boatId="boat-fixture" canEdit={!readOnly} isMobile={mobile} />
    </div>
  )
}
