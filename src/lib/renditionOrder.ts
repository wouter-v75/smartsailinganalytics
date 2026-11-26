// WHICH copy of a clip a player is offered, and in what order.
//
// A clip can exist in up to four forms, and they are not interchangeable:
//
//   originalHls   the original on Bunny Stream as an adaptive ladder. The ONLY
//                 form that carries a 1080p rung, because FULL_LADDER is asked
//                 for on the evening TUS upload.
//   proxy         the 720p copy — adaptive once Stream has it, else a single
//                 signed Storage MP4 at ~6 Mbps.
//   originalMp4   the original as ONE signed Storage MP4, no ABR. For a
//                 clips:day cut that is a 720p file and perfectly watchable;
//                 for 4K card footage it is gigabytes at one bitrate.
//   legacyStream  the whole clip on Bunny Stream under `bunny_stream_id`, from
//                 the upload flow removed in Nov 2026 (src/lib/uploadFlows.ts).
//                 Real, adaptive, and still playing.
//   legacy        the same era's `bunny_storage_path`, as a signed Storage MP4.
//
// WHY legacyStream OUTRANKS legacy, which is not the order it reads in. Both
// belong to the removed flow, but only ONE of them has bytes behind it. That
// flow sent the file to Bunny STREAM and then wrote a `bunny_storage_path` of
// `sessions/<date>/videos/<id>/original` describing where it would have gone if
// it had used Storage — a key nothing ever PUT. Measured 26 Nov 2026 on the live
// zone: 79 rows carry such a path, every one of the invented shape, and every
// one 404s. 37 of them have no proxy and no original, so `legacy` was the step
// that answered — handing out a signed URL to nothing while the row's own live
// Stream video sat in a column this route never read.
//
// The main player never saw it (it only calls this route when has_proxy or
// has_original is set, and falls through to /api/stream/status otherwise), which
// is why it stayed hidden. The standalone timeline's fallback player and
// `resolveShareTarget` both call this route unconditionally — so the timeline
// showed a dead video and SHARING one of those clips reported "playable" and
// produced a link that 404s for the recipient.
//
// WHY `hlsOnly` REORDERS RATHER THAN FORBIDS. Mobile wants the original for the
// 1080p rung, and that rung exists only in originalHls. The obvious rule —
// "mobile may not have originalMp4" — would have taken playback away from the
// 370-odd rows that carry an original and no proxy at all, whose originals are
// clips:day 720p files that play on a phone perfectly well. So originalMp4 is
// demoted below the proxy instead of removed: a phone reaches for HD first,
// settles for the 720p proxy, and still falls back to the single-bitrate
// original rather than being told a clip it could play is unavailable.
//
// The order IS the behaviour, which is why it lives here with a test instead of
// being three `||` chains in the route.

export type Prefer = 'original' | 'proxy' | 'auto'
export type RenditionStep =
  | 'originalHls' | 'proxy' | 'originalMp4' | 'legacyStream' | 'legacy'

/**
 * The forms to try, best first.
 *
 * @param prefer   'proxy' asks for the light copy first (sharing, a check that
 *                 anything is playable at all). 'auto' and 'original' both
 *                 reach for the original first.
 * @param hlsOnly  the caller can only make good use of the original as an
 *                 adaptive ladder — see above. Ignored under `prefer: 'proxy'`,
 *                 which already puts the proxy first.
 */
export function renditionOrder(prefer: Prefer, hlsOnly = false): RenditionStep[] {
  if (prefer === 'proxy') return ['proxy', 'originalHls', 'originalMp4', 'legacyStream', 'legacy']
  if (hlsOnly) return ['originalHls', 'proxy', 'originalMp4', 'legacyStream', 'legacy']
  return ['originalHls', 'originalMp4', 'proxy', 'legacyStream', 'legacy']
}
