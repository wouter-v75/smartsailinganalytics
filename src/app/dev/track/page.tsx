'use client'
import * as React from 'react'
// The host file is plain JS, so its prop defaults type the parameters as
// `never[]` / `null`. The harness passes real fixtures; widen once, here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import { GPSTrackMap as GPSTrackMapRaw } from '@/components/SmartSailingAnalytics_UI'

const GPSTrackMap = GPSTrackMapRaw as unknown as React.ComponentType<Record<string, unknown>>

// Preview harness for the analytics track: the colour-mode chips, the phase
// shading, and the absence of the white video bands.
//
// Leaflet is loaded from a CDN, so on a machine with no outbound access the map
// itself will not draw — the controls around it still render and still work,
// and a test can install a stand-in on window.L to record what the map WOULD be
// asked to draw. That is the part worth checking here: which polylines go on,
// in which colour.

const DAY = '2026-09-11'
const T = (h: number, m: number, s = 0) =>
  Date.parse(`${DAY}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}Z`)

// A synthetic beat-and-run, with wind and boat speed so the polar colouring has
// something to work with.
const ROWS = (() => {
  const out: Record<string, number>[] = []
  const t0 = T(11, 20)
  for (let i = 0; i < 3600; i += 5) {
    const leg = Math.floor(i / 900)
    const f = (i % 900) / 900
    const up = leg % 2 === 0
    const twa = up ? 42 + Math.sin(i / 60) * 4 : 145 + Math.sin(i / 70) * 5
    out.push({
      utc: t0 + i * 1000,
      lat: 39.5 + (up ? f : 1 - f) * 0.02,
      lon: 2.62 + (Math.floor((i % 900) / 120) % 2 ? 1 : -1) * 0.004 + leg * 0.0006,
      bsp: up ? 7.4 + Math.sin(i / 40) * 0.5 : 11.8 + Math.sin(i / 50) * 0.8,
      twa, tws: 12 + Math.sin(i / 300),
    })
  }
  return out
})()

// Steady-state windows, as an event file records them.
const XML = {
  dayStartUtc: T(11, 20),
  dayStopUtc: T(12, 20),
  phases: [
    { utc: T(11, 25), endUtc: T(11, 30), mode: 1 },
    { utc: T(11, 40), endUtc: T(11, 46), mode: 3 },
    { utc: T(12, 0), endUtc: T(12, 6), mode: 1 },
  ],
  raceGuns: [
    { utc: T(11, 30), raceNum: 1, label: 'Race 1 start' },
    { utc: T(12, 0), raceNum: 2, label: 'Race 2 start' },
  ],
  markRoundings: [{ utc: T(11, 45) }, { utc: T(11, 55) }, { utc: T(12, 12) }],
  // Enough manoeuvres to see whether they read as background or as findings.
  tackJibes: [11.6, 11.8, 12.05, 12.15].map((h, i) => ({
    utc: T(Math.floor(h), Math.round((h % 1) * 60)),
    isTack: i % 2 === 0, isValid: true,
    label: i % 2 === 0 ? 'Tack' : 'Gybe',
  })),
  sailsUpEvents: [],
}

// Clips: they used to be drawn as white bands over the track. They must not be
// any more — the fixture keeps them so a test can prove it.
const VIDEOS = [
  { id: 'v1', startUtc: T(11, 30), duration: 300, title: 'Onboard 1' },
  { id: 'v2', startUtc: T(12, 0), duration: 240, title: 'Onboard 2' },
]

const POLAR = {
  filename: 'preview.pol',
  tws: [8, 16],
  entries: [8, 16].map((tws) => ({
    tws,
    points: [30, 45, 60, 90, 120, 150, 170].map((twa) => ({
      twa, bsp: (tws / 2) * Math.sin((twa * Math.PI) / 180) ** 0.7,
    })),
  })),
}

export default function TrackPreview() {
  const [ready, setReady] = React.useState(false)
  React.useEffect(() => {
    try {
      // GPSTrackMap reads the polar out of local storage, as the app does.
      localStorage.setItem('ssa:polar', JSON.stringify(POLAR))
    } catch { /* private window */ }
    document.documentElement.setAttribute('data-theme', 'dark')
    setReady(true)
  }, [])
  if (!ready) return null
  return (
    <div style={{ minHeight: '100dvh', background: '#030F1A', padding: 12, color: '#E2E8F0' }}>
      <div style={{ fontSize: 11, color: '#64748B', marginBottom: 10 }}>
        Analytics track preview · fixture data
      </div>
      <GPSTrackMap
        rows={ROWS}
        xmlData={XML}
        allVideos={VIDEOS}
        photos={[]}
        onSelection={() => {}}
      />
    </div>
  )
}
