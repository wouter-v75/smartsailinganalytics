'use client'

import dynamic from 'next/dynamic'
import UserPill from '../components/UserPill'

// The main app is a large, entirely client-side component (IndexedDB, blob URLs,
// localStorage — it never rendered on the server anyway). Statically importing it
// here put its ~500 KB into the SAME page chunk as UserPill, so the top-right
// username could not paint until the whole component had downloaded and parsed.
// Code-split it into its own chunk (ssr:false) so the shell + UserPill render
// immediately and the heavy app streams in behind a lightweight fallback.
const SmartSailingAnalytics = dynamic(
  () => import('../components/SmartSailingAnalytics_UI'),
  {
    ssr: false,
    loading: () => (
      <div
        style={{
          position: 'fixed',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#030F1A',
          color: '#7DD3FC',
          fontSize: 13,
          letterSpacing: 0.5,
        }}
      >
        <div
          style={{
            width: 22,
            height: 22,
            border: '2px solid #1E3A5A',
            borderTopColor: '#06B6D4',
            borderRadius: '50%',
            marginRight: 10,
            animation: 'ssa-spin 0.8s linear infinite',
          }}
        />
        Loading…
        <style>{'@keyframes ssa-spin{to{transform:rotate(360deg)}}'}</style>
      </div>
    ),
  }
)

export default function Home() {
  return (
    <>
      <UserPill />
      <SmartSailingAnalytics />
    </>
  )
}
