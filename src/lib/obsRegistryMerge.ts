// Whether a probed station belongs in the registry.
//
// THE BUG THIS EXISTS TO FIX. The Davis registry was REBUILT from scratch on
// every run: candidates came from WeatherLink's public index, each was probed,
// and only the ones answering with live wind were written out. Anything else
// vanished.
//
// That erases stations for having a bad day. On 23 Oct 2026 the Yacht Club de
// Saint-Tropez — the one station actually in the Golfe de Saint-Tropez, 1.3 nm
// from where the racing happens — was uploading normally, one minute old, with
// `windSpeed: "--"` and `windDirection: "--"`. Its anemometer was down, not its
// station. It had ALSO dropped out of the public index entirely (the index went
// from 79,443 entries to 78,480 overnight, so this is routine churn, not a
// closure) while its own detail endpoint answered perfectly.
//
// Rebuilding that day would have deleted it permanently, and it would not have
// come back when the club fixed the sensor, because nothing would ever ask it
// again. The symptom — "St Tropez sailing club is not visible today" — would
// have become "St Tropez sailing club is never visible again", with no error
// anywhere.
//
// THE RULE. A registry is a list of places to ASK, not a list of readings.
//
//   answers with usable wind        keep — obviously
//   answers, but no wind right now  keep IF ALREADY KNOWN, else drop
//   answers, but the reading is old keep IF ALREADY KNOWN, else drop
//   does not answer at all          drop
//
// So a NEW candidate has to prove itself — that is what stopped five dead
// stations being listed as silent absences when this list was first built —
// while a station we already trusted gets the benefit of the doubt for as long
// as it still responds. The cost of being wrong is one request per poll. The
// cost of the old rule was losing the only station on the race area.
//
// Nothing downstream is misled by keeping it: a station with no reading
// produces no observation, and the 90-minute staleness window hides a stale
// one. It simply reappears by itself the day the sensor is fixed.

export type ProbeOutcome =
  /** Answered with a wind reading inside the freshness window. */
  | 'wind'
  /** Answered, but publishes no wind — no sensor, or a sensor that is down. */
  | 'answered-no-wind'
  /** Answered with a wind reading, but an old one. */
  | 'stale'
  /** Did not answer: HTTP error, timeout, or gone. */
  | 'no-answer'

export interface MergeDecision {
  keep: boolean
  /** Why, for the run's log — these are read by a person deciding to trust it. */
  why: string
}

export function keepInRegistry(outcome: ProbeOutcome, alreadyKnown: boolean): MergeDecision {
  switch (outcome) {
    case 'wind':
      return { keep: true, why: 'reporting' }
    case 'no-answer':
      // Even a known station goes when it stops responding at all. Nothing is
      // being kept warm for a URL that errors.
      return { keep: false, why: alreadyKnown ? 'dropped — stopped answering' : 'no answer' }
    case 'answered-no-wind':
      return alreadyKnown
        ? { keep: true, why: 'KEPT — known station, anemometer silent today' }
        : { keep: false, why: 'no wind sensor' }
    case 'stale':
      return alreadyKnown
        ? { keep: true, why: 'KEPT — known station, reading is old' }
        : { keep: false, why: 'stale' }
  }
}
