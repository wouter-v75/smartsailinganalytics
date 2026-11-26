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
//   legacy        rows predating the split, with only bunny_storage_path.
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
export type RenditionStep = 'originalHls' | 'proxy' | 'originalMp4' | 'legacy'

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
  if (prefer === 'proxy') return ['proxy', 'originalHls', 'originalMp4', 'legacy']
  if (hlsOnly) return ['originalHls', 'proxy', 'originalMp4', 'legacy']
  return ['originalHls', 'originalMp4', 'proxy', 'legacy']
}
