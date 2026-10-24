// Sea-surface temperature for the venue a point sits in, as a hook.
//
// WHY A HOOK OF ITS OWN. The stability term needs an air-sea temperature
// difference, the air half rides free on the surface-model request, and the sea
// half is one extra call. Keeping it here means the component that actually
// builds a masthead number asks for it, rather than threading SST state
// through a 1,200-line view that does not otherwise care.
//
// ONE CALL PER VENUE PER HOUR. fetchVenueSst caches on the venue key, so every
// point at Saint-Tropez shares one request however many are clicked — which is
// the whole reason this is venue-level and not per point. Measured: SST moved
// 0.2 K across a 48-hour forecast in the Gulf of Naples.
//
// The timezone is passed straight through on purpose. The marine endpoint
// defaults to GMT and returns naive stamps, so asking in a different zone from
// the surface model silently offsets every air-sea difference by the venue's
// UTC offset.

import { useEffect, useState } from 'react'
import { fetchVenueSst } from './openMeteo'

export function useVenueSst(latitude, longitude, timezone) {
  const [sst, setSst] = useState(null)

  useEffect(() => {
    if (latitude == null || longitude == null || !timezone) { setSst(null); return }
    let alive = true
    fetchVenueSst(latitude, longitude, timezone)
      .then((s) => { if (alive) setSst(s || null) })
      // No SST is a flagged neutral profile, not an error worth showing.
      .catch(() => { if (alive) setSst(null) })
    return () => { alive = false }
  }, [latitude, longitude, timezone])

  return sst
}
