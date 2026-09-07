import { describe, it, expect } from 'vitest'

// Mirror of the playback-state rules in VideoPlayer. Having a URL is not the same
// as having a playable video: the element renders as soon as objectUrl exists, so
// an expired signed URL, an HLS stream Bunny has not finished encoding, or a
// stalled phone connection all rendered the same black rectangle that never played
// and never said why.
type State = 'loading' | 'ready' | 'error'
const onEvent = (s: State, ev: string): State => {
  if (ev === 'error') return 'error'
  if (ev === 'canplay' || ev === 'loadedmetadata') return 'ready'
  if (ev === 'waiting' || ev === 'stalled') return s === 'error' ? s : 'loading'
  return s
}
const mediaErrText = (code?: number) =>
  code === 1 ? 'loading was aborted'
  : code === 2 ? 'network error — check the connection and try again'
  : code === 3 ? 'the video data is damaged and cannot be decoded'
  : code === 4 ? "this device's browser cannot play this file"
  : 'the video could not be loaded'

describe('what the player tells you while a video is not playing', () => {
  it('starts as loading, not as broken', () => {
    // A clip that simply has not buffered yet must not read as unavailable.
    expect(onEvent('loading', 'waiting')).toBe('loading')
  })

  it('becomes ready on metadata or canplay', () => {
    expect(onEvent('loading', 'loadedmetadata')).toBe('ready')
    expect(onEvent('loading', 'canplay')).toBe('ready')
  })

  it('reports an error the moment the browser gives up', () => {
    expect(onEvent('loading', 'error')).toBe('error')
    expect(onEvent('ready', 'error')).toBe('error')
  })

  it('does NOT walk an error back to loading on a late stall event', () => {
    // Media elements fire stalled/waiting after an error too. Reverting would put
    // the player back to "please wait" forever on a clip that will never load.
    expect(onEvent('error', 'stalled')).toBe('error')
    expect(onEvent('error', 'waiting')).toBe('error')
  })

  it('lets a recovered stream play again — buffering is not failure', () => {
    let s: State = 'ready'
    s = onEvent(s, 'waiting')        // mid-clip rebuffer
    expect(s).toBe('loading')
    s = onEvent(s, 'canplay')
    expect(s).toBe('ready')
  })

  it('separates the causes a user can act on from the ones they cannot', () => {
    expect(mediaErrText(2)).toMatch(/connection/)      // retry is worth it
    expect(mediaErrText(4)).toMatch(/cannot play/)     // this device never will
    expect(mediaErrText(3)).toMatch(/damaged/)
    expect(mediaErrText(undefined)).toMatch(/could not be loaded/)
  })
})
