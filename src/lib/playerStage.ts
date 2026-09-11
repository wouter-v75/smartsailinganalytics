// What to tell someone waiting for a clip — three plain stages instead of a
// technical status. Phones showed "not available" for clips that were fine, or
// were merely still being fetched; the wording now matches what is known.
//
//   finding     — we do not have a playable link yet (resolving it, retrying,
//                 or Bunny is still encoding): "bear with us"
//   loading     — we have the link and the browser is buffering it
//   unavailable — we tried, and it cannot be played right now
//   ready       — it is playing / will play; show nothing

export const STAGE_TEXT = {
  finding: 'Bear with us, working on getting the video',
  loading: 'Video loading',
  unavailable: 'Apologies, this video is not available at the moment',
} as const

export type PlayerStage = 'finding' | 'loading' | 'unavailable' | 'ready'
export type PlayState = 'loading' | 'ready' | 'error' | 'retrying'

export interface StageVideo {
  objectUrl?: string | null
  urlFailed?: boolean
  streamFailed?: boolean
  streamStalled?: boolean
  streamProcessing?: boolean
  source?: string
  hasProxy?: boolean
  hasOriginal?: boolean
  streamId?: string | null
  hasLocalBlob?: boolean
}

export function playerStage(v: StageVideo, playState: PlayState): PlayerStage {
  if (!v.objectUrl) {
    if (v.urlFailed || v.streamFailed || v.streamStalled) return 'unavailable'
    // Somewhere to get it from — keep asking the viewer to bear with us.
    const somewhere =
      v.hasProxy || v.hasOriginal || v.streamId || v.hasLocalBlob ||
      v.streamProcessing || v.source === 'processing'
    return somewhere ? 'finding' : 'unavailable'
  }
  if (playState === 'ready') return 'ready'
  if (playState === 'error') return 'unavailable'
  // Failed once; a fresh link is on its way — still "bear with us", not an error.
  if (playState === 'retrying') return 'finding'
  return 'loading'
}

/** A resolved https link that is not about to expire. Signed Storage URLs live
 *  an hour (signBunnyUrl); treat them as stale a minute early. Links without an
 *  expiry (an HLS playlist) stay fresh. */
export function clipUrlIsFresh(
  v: { objectUrl?: string | null; urlExpiresAt?: number | null },
  now = Date.now(),
): boolean {
  if (!v.objectUrl || !String(v.objectUrl).startsWith('http')) return false
  return !(v.urlExpiresAt && v.urlExpiresAt - now < 60_000)
}

/** A progressive file, never an HLS playlist — even when it is a cloud clip. */
export function isMp4Url(url?: string | null): boolean {
  return /\.(mp4|mov|m4v)(\?|$)/i.test(url || '')
}
