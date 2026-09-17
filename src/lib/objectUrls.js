// One `blob:` URL per local video, for the life of the page.
//
// THE LEAK THIS REPLACES. Every read of a video row minted a fresh
// URL.createObjectURL for its blob, and nothing ever revoked one. A blob: URL
// pins its Blob in memory until the document goes, so each getVideosForDate /
// getAllVideos pinned that day's footage AGAIN — browse ten days and ten days of
// video are held, hundreds of MB apiece. The sync queues were given a ref to
// dodge it (allVideosRef in the UI, with a comment saying why); loadDate, which
// runs on every date switch and every tab return, was not.
//
// WHY A CACHE RATHER THAN REVOKING ON RE-READ. Revoking when a row is re-read
// would be the obvious fix and is the wrong one: a <video> element may still be
// pointed at that URL, and a revoked URL fails the next fetch it makes — a seek
// past the buffered range dies. Handing back the SAME URL for the same clip is
// both leak-free and safe, because the URL never becomes stale while the bytes
// behind it are unchanged.
//
// A URL is only dropped when the bytes change (a crop, an offline download) or
// the clip is deleted — which is exactly when the old URL is wrong anyway.

const urls = new Map() // video id -> blob: URL

/**
 * The URL for this clip's blob, minting one on first ask.
 * Returns null when there is no blob (a cloud-only clip).
 */
export function objectUrlFor(id, blob) {
  if (!blob) return null
  // No id to key on — hand back a one-off and let the caller own its lifetime.
  if (id == null) return URL.createObjectURL(blob)
  const known = urls.get(id)
  if (known) return known
  const url = URL.createObjectURL(blob)
  urls.set(id, url)
  return url
}

/** Drop a clip's URL: its bytes changed, or it is gone. Safe to call twice. */
export function releaseObjectUrl(id) {
  const url = urls.get(id)
  if (!url) return false
  try { URL.revokeObjectURL(url) } catch { /* already gone */ }
  urls.delete(id)
  return true
}

/** How many URLs are currently held. Tests and debugging. */
export function liveObjectUrlCount() {
  return urls.size
}
