// Which of several rows for ONE clip survives, and what must be carried onto it
// first. Pure: no Supabase, no Bunny, no process.
//
// It lives here rather than in scripts/video-row-dedupe.ts because the decision
// is the whole value of that script and every version of it has been wrong in a
// way only the real data showed. The script fetches; this decides; the test
// pins it to the seven groups that exist on the live library.
//
// WHY A COLUMN IS NOT A COPY. The first version counted non-null locator
// columns. `IMG 2894` has two rows, both reading "1 rendition", both resting on
// a legacy `bunny_stream_id` alone — and one of those guids points at a Stream
// video Bunny has DELETED. The count made the pair look symmetrical, so a
// tie-break decided it, and a tie-break cannot know which guid still resolves.
// So the caller resolves every guid against the library and passes a lookup.

/** The row fields the decision needs. */
export interface DedupeRow {
  id: string
  title?: string | null
  tags?: string[] | null
  created_at?: string | null
  duration_ms?: number | null
  bytes?: number | null
  bunny_stream_id?: string | null
  bunny_proxy_stream_id?: string | null
  bunny_original_stream_id?: string | null
  bunny_proxy_path?: string | null
  bunny_original_path?: string | null
}

/**
 * Does this Stream guid hold bytes?
 *
 * An abandoned TUS upload leaves a guid that resolves to nothing, so existing
 * is not enough — the library audit of 26 Nov found 192 such stubs.
 */
export type StreamBytes = (guid: string) => number

export type CopyState = 'live' | 'gone' | 'unverified'
export interface Copy { label: string; state: CopyState }

/** Two encodes of one cut differ by jitter; a re-cut differs by seconds. */
export const LENGTH_TOL = 0.02

/**
 * Every copy a row names, and whether it is really there.
 *
 * A storage path is `unverified`: its shape is checked (a real one ends .mp4 —
 * 0110 cleared the invented `sessions/<date>/videos/<id>/original` layout) but
 * the object is not probed, which would need the Storage API.
 */
export function copies(r: DedupeRow, bytesOf: StreamBytes): Copy[] {
  const out: Copy[] = []
  const stream = (guid: string | null | undefined, label: string) => {
    if (!guid) return
    out.push({ label, state: bytesOf(guid) > 0 ? 'live' : 'gone' })
  }
  const path = (p: string | null | undefined, label: string) => {
    if (!p) return
    out.push({ label, state: /\.mp4$/i.test(p) ? 'unverified' : 'gone' })
  }
  stream(r.bunny_proxy_stream_id, 'proxy')
  stream(r.bunny_original_stream_id, 'orig')
  path(r.bunny_proxy_path, 'proxyFile')
  path(r.bunny_original_path, 'origFile')
  stream(r.bunny_stream_id, 'legacy')
  return out
}

export const markOf = (s: CopyState) => (s === 'live' ? '✓' : s === 'gone' ? '✕' : '?')
export const describe = (cs: Copy[]) =>
  cs.length ? cs.map((c) => `${c.label}${markOf(c.state)}`).join(' ') : 'no locator'

/**
 * HOW MANY copies, not just whether there is one. The count is what decides the
 * 29 Sept pairs: one row has `legacy✓` and ten tags, the other `proxy✓ orig✓`
 * and none. Both play, so a yes/no test ties and falls through to the tags —
 * which would keep the legacy-only row and give those three clips worse
 * playback than they have today, to save an UPDATE that takes a second. Tags
 * carry forward; an HD ladder does not.
 */
export const counts = (cs: Copy[]) => ({
  live: cs.filter((c) => c.state === 'live').length,
  maybe: cs.filter((c) => c.state === 'unverified').length,
})

export type Verdict = 'safe' | 'lengths-differ' | 'nothing-plays'

export interface Plan {
  verdict: Verdict
  keep: DedupeRow | null
  why: string
  /** Tags that exist only on rows being dropped. Carry them BEFORE deleting. */
  tagsToCarry: string[]
  note: string
}

/**
 * KEEP WHAT ACTUALLY PLAYS, most copies first.
 *
 * THEN LOOK AT THE TAGS, because on the real data they go the OTHER WAY. Three
 * of the four 29 Sept pairs have the live copies on one row and ALL the tags on
 * the other. The obvious rule — "keep the playable one, delete the rest" —
 * throws away ten tags a person typed. Hence a MERGE before any delete.
 *
 * TWO GROUPS GET NO PLAN AT ALL, because a plan would invite the wrong action:
 *
 *   lengths-differ   `20260929153553` is 100 s on one row and 90 s on the
 *                    other. The other three 29 Sept pairs are the same encode
 *                    twice (bytes within 0.03 %); this one is the same moment
 *                    cut with a different window, so dropping the longer row
 *                    throws away ten seconds of footage.
 *   nothing-plays    all four `11591` rows have no copy in the cloud. There is
 *                    no dedupe to do — the question is whether to keep one row
 *                    as the record of a clip that is not there, or drop it.
 */
export function plan(group: DedupeRow[], bytesOf: StreamBytes): Plan {
  const info = new Map(group.map((r) => [r.id, copies(r, bytesOf)]))
  const cnt = (r: DedupeRow) => counts(info.get(r.id) || [])
  const any = (r: DedupeRow) => { const c = cnt(r); return c.live + c.maybe }

  const durs = group.map((r) => r.duration_ms).filter((d): d is number => !!d)
  if (durs.length > 1) {
    const lo = Math.min(...durs), hi = Math.max(...durs)
    if (lo > 0 && (hi - lo) / lo > LENGTH_TOL) {
      return {
        verdict: 'lengths-differ', keep: null, why: '', tagsToCarry: [],
        note: `lengths differ ${(lo / 1000).toFixed(0)} s vs ${(hi / 1000).toFixed(0)} s ` +
          `(${(((hi - lo) / lo) * 100).toFixed(1)} %) — two different CUTS of one moment, ` +
          `not one clip filed twice. Dropping the longer row loses footage.`,
      }
    }
  }

  if (!group.some((r) => any(r) > 0)) {
    return {
      verdict: 'nothing-plays', keep: null, why: '', tagsToCarry: [],
      note: 'no row here has a copy in the cloud, so there is no dedupe to do. ' +
        'The question is whether to keep one row as the record or drop the clip.',
    }
  }

  const ranked = [...group].sort((a, b) => {
    const d = cnt(b).live - cnt(a).live
    if (d) return d
    const m = cnt(b).maybe - cnt(a).maybe
    if (m) return m
    // Tags are typed by a person and the carry-forward UPDATE can be skipped.
    const t = (b.tags?.length || 0) - (a.tags?.length || 0)
    if (t) return t
    // Then the oldest, which any share link already handed out points at.
    return (a.created_at || '').localeCompare(b.created_at || '')
  })
  const keep = ranked[0]
  const keptCopies = info.get(keep.id) || []
  const why = cnt(keep).live > cnt(ranked[1]).live
    ? `most copies in the cloud (${describe(keptCopies)})`
    : (keep.tags?.length || 0) > (ranked[1].tags?.length || 0)
      ? `equal copies — the one carrying ${keep.tags?.length} tags`
      : 'equal copies and labels — the oldest, which any shared link points at'

  const kept = new Set(keep.tags || [])
  const tagsToCarry = Array.from(new Set(
    group.filter((r) => r.id !== keep.id).flatMap((r) => r.tags || [])
  )).filter((t) => !kept.has(t))

  return {
    verdict: 'safe', keep, why, tagsToCarry,
    note: counts(keptCopies).live === 0
      ? 'the keeper rests on a STORAGE PATH this script does not probe — confirm it plays before deleting the rest'
      : '',
  }
}
