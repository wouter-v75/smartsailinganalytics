// The one mediabunny option that decided whether the hardware encoder ran at
// all — asserted against the real library, not against our idea of it.
//
// `fastStart: 'in-place'` is not a value mediabunny accepts. It takes
// `false | 'in-memory' | 'reserve' | 'fragmented'` and throws a TypeError from
// the Mp4OutputFormat CONSTRUCTOR — before a frame is read, before the encoder
// is configured, before anything that could be called a transcode. Three
// things then conspired to hide it for the whole life of the feature:
//
//   • generateProxy catches any throw from the WebCodecs engine and falls back
//     to ffmpeg.wasm, by design — a slow clip beats a failed one;
//   • the only record was a console.warn, in a console nobody had open;
//   • the module was imported as `any` behind a @ts-ignore, so tsc, eslint and
//     every unit test in this repo checked precisely nothing about the options.
//
// So every proxy the app ever made was software: 5-20× slower, needing a CDN
// download, and measured on 28 Nov 2026 at 62 s of CPU for a 60 s clip.
//
// A unit test with a mocked mediabunny would have passed throughout. This one
// constructs the real thing, which is the only version of the question that
// could ever have failed.

import { describe, it, expect } from 'vitest'
import { PROXY_FAST_START } from '../video-proxy'

describe('the proxy output format', () => {
  it('uses a fastStart mediabunny actually accepts', async () => {
    const { Mp4OutputFormat } = await import('mediabunny')
    expect(() => new Mp4OutputFormat({ fastStart: PROXY_FAST_START })).not.toThrow()
  })

  it('and the old value really does throw, so this is not a theory', async () => {
    const { Mp4OutputFormat } = await import('mediabunny')
    expect(() => new Mp4OutputFormat({
      // @ts-expect-error — the whole point: this is not an allowed value, and
      // typing the import is what makes it a compile error rather than a
      // runtime fallback nobody sees.
      fastStart: 'in-place',
    })).toThrow(/fastStart/)
  })

  it('puts the moov atom at the front rather than disabling faststart', () => {
    // `false` is also accepted by mediabunny and would NOT throw, so the test
    // above alone could be satisfied by a proxy no player can start streaming.
    // The point of the proxy is that it plays the moment its bytes land.
    expect(PROXY_FAST_START).not.toBe(false)
    expect(['in-memory', 'reserve', 'fragmented']).toContain(PROXY_FAST_START)
  })
})
