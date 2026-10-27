'use client'
import * as React from 'react'
import ForecastView from '@/components/weather/ForecastView'

// Preview harness for the wind-field TIME BAR — the venue-zone label on the
// cursor, the Now button and the current-time marker.
//
// It renders the REAL ForecastView with a synthetic field injected through
// `persist`, rather than a copy of the time-bar JSX. A harness that
// re-implemented the bar would keep looking right while the component changed
// underneath it, which is the way this project has been bitten before.
//
// The field is pinned to the SAN JUAN ISLANDS on purpose: at UTC−7 the venue
// zone and this laptop's zone are eight hours apart, so a label or a marker
// taken from the browser's clock instead of the venue's is off by most of the
// slider and impossible to miss. A harness built at a home venue would look
// correct under either reading.
//
// ForecastView's fetch effect bails out before it can clear the injected field:
// `tzReady` is false until point 1's zone resolves, and the first-run guard then
// keeps a restored field. So nothing is fetched and nothing is overwritten.

const P1 = { lat: 48.5765, lon: -122.9506 }   // the 1 km domain centre
const SPAN_H = 25                              // 00:00 .. 24:00 venue time

const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** The venue's own calendar day, so the synthetic field always straddles "now". */
function venueToday(tz: string) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date())
  const g = (k: string) => p.find((x) => x.type === k)?.value || ''
  return `${g('year')}-${g('month')}-${g('day')}`
}

function makeField() {
  const day = venueToday('America/Los_Angeles')
  // Zone-less wall clock, exactly as Open-Meteo answers `timezone=auto`.
  const times = Array.from({ length: SPAN_H }, (_, i) => `${day}T${String(i).padStart(2, '0')}:00`)
  const stamps = times.map((t) => {
    const d = new Date(`${t}:00Z`)
    return {
      wd: WD[d.getUTCDay()],
      dd: String(d.getUTCDate()).padStart(2, '0'),
      mon: MON[d.getUTCMonth()],
      hh: d.getUTCHours(),
      mm: '00',
    }
  })
  const labels = stamps.map((s) => `${s.wd} ${String(s.hh).padStart(2, '0')}:00`)
  // A 6×5 grid is enough to draw; the bar does not care about the field values.
  const nx = 6
  const ny = 5
  const header = { nx, ny, lo1: P1.lon - 0.15, la1: P1.lat + 0.1, dx: 0.06, dy: 0.05 }
  const frames = times.map((_, t) => ({
    u: new Array(nx * ny).fill(0).map((__, k) => 4 + ((t + k) % 7)),
    v: new Array(nx * ny).fill(0).map((__, k) => -2 + ((t * 2 + k) % 5)),
  }))
  return {
    times,
    labels,
    stamps,
    frames,
    header,
    maxSpeed: 12,
    box: {
      north: header.la1,
      south: header.la1 - header.dy * (ny - 1),
      west: header.lo1,
      east: header.lo1 + header.dx * (nx - 1),
    },
    timesAreUtc: false,
  }
}

export default function WindFieldTimeHarness() {
  const [persist, setPersist] = React.useState<Record<string, unknown> | null>(null)
  React.useEffect(() => {
    setPersist({
      locations: {
        1: { lat: P1.lat, lon: P1.lon },
        2: { lat: P1.lat + 0.05, lon: P1.lon + 0.08 },
        3: { lat: P1.lat - 0.05, lon: P1.lon + 0.08 },
      },
      fieldModel: 'ICONRACE_1KM',
      fieldHeight: 10,
      fieldHourIdx: 0,
      field: makeField(),
    })
  }, [])
  if (!persist) return null
  return (
    <div style={{ background: '#030F1A', minHeight: '100vh', padding: 12 }}>
      <div style={{ color: '#7DD3FC', font: '700 12px ui-monospace, monospace', marginBottom: 8 }}>
        /dev/wind-field-time — venue America/Los_Angeles (UTC−7), browser{' '}
        {Intl.DateTimeFormat().resolvedOptions().timeZone}
      </div>
      {/* The four callbacks have no defaults in ForecastView, so tsc makes them
          required even through allowJs. No-ops here: this harness has no
          session store to persist into. */}
      <ForecastView
        persist={persist}
        canIconRace
        canHeights
        mastHeight={30}
        onMastHeightChange={() => {}}
        onDataChange={() => {}}
        onActiveModelChange={() => {}}
        onPersistChange={() => {}}
      />
    </div>
  )
}
