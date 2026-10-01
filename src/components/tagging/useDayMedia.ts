'use client'
import * as React from 'react'
import { mediaMarks, type MediaMark } from '@/lib/mediaDecks'
import { EMPTY_COVERAGE, normaliseCoverage, type DroneCoverage } from '@/lib/droneCoverage'

// The day's video, drone, photo and sail-scan marks, for drawing on the track.
//
// Three endpoints, one fetch each per day — the same three the timeline reads.
// Deliberately NOT part of useTagger: a failure here must cost the crew a
// colour on the track and nothing else. Tagging has to keep working on a boat
// with no signal, and a media fetch that could take the tagger down with it
// would be the tail wagging the dog.
//
// Sail scans are boat-scoped with no date filter on the API, so they are
// narrowed here — on the SESSION's clock, not the device's, or a scan taken at
// 23:30 local lands on the wrong day for anybody reviewing from another
// timezone.

export interface DayMedia {
  marks: MediaMark[]
  /** Where the drone was filming, and which of it is cut. Measured off the card
   *  by scripts/drone-coverage.ts; empty until somebody plugs the drive in. */
  coverage: DroneCoverage
}

export function useDayMedia(
  teamId?: string | null,
  boatId?: string | null,
  date?: string | null,
  tzOffsetMin = 0
): DayMedia {
  const [marks, setMarks] = React.useState<MediaMark[]>([])
  const [coverage, setCoverage] = React.useState<DroneCoverage>(EMPTY_COVERAGE)

  React.useEffect(() => {
    if (!teamId || !boatId || !date) { setMarks([]); setCoverage(EMPTY_COVERAGE); return }
    let alive = true
    const j = (r: Response) => r.json().catch(() => ({}))
    Promise.all([
      fetch(`/api/teams/${teamId}/boats/${boatId}/videos?date=${date}`).then(j).catch(() => ({})),
      fetch(`/api/teams/${teamId}/boats/${boatId}/photos?date=${date}`).then(j).catch(() => ({})),
      fetch(`/api/teams/${teamId}/sail-scans?boat_id=${boatId}&limit=200`).then(j).catch(() => ({})),
      fetch(`/api/teams/${teamId}/boats/${boatId}/drone-coverage?date=${date}`).then(j).catch(() => ({})),
    ]).then(([vj, pj, sj, cj]: [any, any, any, any]) => {   // eslint-disable-line @typescript-eslint/no-explicit-any
      if (!alive) return
      setCoverage(normaliseCoverage(cj?.coverage))
      const ymd = (t: number) => new Date(t + tzOffsetMin * 60_000).toISOString().slice(0, 10)
      const all = mediaMarks({ videos: vj?.videos || [], photos: pj?.photos || [], scans: sj?.scans || [] })
      setMarks(all.filter((m) => m.kind !== 'sailscan' || ymd(m.t0) === date))
    }).catch(() => { if (alive) { setMarks([]); setCoverage(EMPTY_COVERAGE) } })
    return () => { alive = false }
  }, [teamId, boatId, date, tzOffsetMin])

  return { marks, coverage }
}
