import { describe, it, expect } from 'vitest'
import { isCompleteClip, newClipNames, collectNewClips } from '../watchFolder'

describe('isCompleteClip — what may be picked up mid-encode', () => {
  it('takes a finished segment', () => {
    expect(isCompleteClip('20260908121330_race-start_day7_drone.mp4')).toBe(true)
    expect(isCompleteClip('DJI_0169.MOV')).toBe(true)
  })

  it('REFUSES an encode still in flight', () => {
    // compress-videos.sh writes .<name>.part.mp4 and renames on clean exit.
    // Uploading one of these would send half a clip to the team.
    expect(isCompleteClip('.20260908121330_race-start_day7_drone.part.mp4')).toBe(false)
    expect(isCompleteClip('clip.part.mp4')).toBe(false)
  })

  it('refuses AppleDouble stubs, which are resource forks not video', () => {
    // Every exFAT card copied on a Mac is full of these; day 7 had five.
    expect(isCompleteClip('._DJI_20260908134751_0172_D.MP4')).toBe(false)
  })

  it('refuses everything that is not video', () => {
    expect(isCompleteClip('manifest.json')).toBe(false)
    expect(isCompleteClip('.DS_Store')).toBe(false)
    expect(isCompleteClip('day7-encode.log')).toBe(false)
    expect(isCompleteClip('')).toBe(false)
  })
})

describe('newClipNames', () => {
  it('returns only what has not been handled', () => {
    const seen = new Set(['a.mp4'])
    expect(newClipNames(['a.mp4', 'b.mp4', '.c.part.mp4'], seen)).toEqual(['b.mp4'])
  })
  it('is stable across repeated listings', () => {
    const e = ['c.mp4', 'a.mp4', 'b.mp4']
    expect(newClipNames(e, new Set())).toEqual(newClipNames(e, new Set()))
  })
})

// A directory handle as the File System Access API really presents one.
//
// getFile MUST be a prototype method that depends on `this`, because that is
// what the browser gives you. The first version of this fake used an own
// arrow-function property that ignored `this`, so it happily passed while the
// real code pulled the method off its handle and threw "Illegal invocation" in
// the browser — the watcher reported "0 picked up" and the tests said fine.
class FakeFileHandle {
  kind = 'file'
  constructor(public name: string, private failing: boolean) {}
  async getFile(): Promise<File> {
    // Throws exactly as the real API does when called unbound.
    if (!(this instanceof FakeFileHandle)) throw new TypeError('Illegal invocation')
    if (this.failing) throw new Error('being written')
    return new File([new Uint8Array(8)], this.name, { type: 'video/mp4' })
  }
}

function fakeDir(names: string[], failing: string[] = []) {
  return {
    async *values() {
      for (const name of names) yield new FakeFileHandle(name, failing.includes(name))
    },
  }
}

describe('collectNewClips — polling a live encode folder', () => {
  it('hands over each clip exactly once across polls', async () => {
    const seen = new Set<string>()
    const first = await collectNewClips(fakeDir(['a.mp4']), seen)
    expect(first.map((f) => f.name)).toEqual(['a.mp4'])

    // second poll: encoder has produced b, a is unchanged
    const second = await collectNewClips(fakeDir(['a.mp4', 'b.mp4']), seen)
    expect(second.map((f) => f.name)).toEqual(['b.mp4'])

    const third = await collectNewClips(fakeDir(['a.mp4', 'b.mp4']), seen)
    expect(third).toEqual([])
  })

  it('ignores the in-flight temp file, then picks up the finished clip', async () => {
    const seen = new Set<string>()
    // mid-encode: only the temp file exists
    expect(await collectNewClips(fakeDir(['.c.part.mp4']), seen)).toEqual([])
    // ffmpeg exits, the script renames
    const done = await collectNewClips(fakeDir(['c.mp4']), seen)
    expect(done.map((f) => f.name)).toEqual(['c.mp4'])
  })

  it('RETRIES a file it could not read, rather than losing the clip', async () => {
    const seen = new Set<string>()
    expect(await collectNewClips(fakeDir(['d.mp4'], ['d.mp4']), seen)).toEqual([])
    expect(seen.has('d.mp4')).toBe(false)      // not marked handled
    const retry = await collectNewClips(fakeDir(['d.mp4']), seen)
    expect(retry.map((f) => f.name)).toEqual(['d.mp4'])
  })

  it('skips directories', async () => {
    const dir = {
      async *values() {
        yield { kind: 'directory', name: 'nested' }
        yield { kind: 'file', name: 'e.mp4', getFile: async () => new File([], 'e.mp4') }
      },
    }
    const out = await collectNewClips(dir, new Set())
    expect(out.map((f) => f.name)).toEqual(['e.mp4'])
  })
})

describe('the handle must not be detached from its method', () => {
  it('calls getFile ON the handle, so a prototype method still works', async () => {
    // Guards the bug directly: pulling getFile off the handle and calling it
    // later loses `this` and throws, which the old bare catch hid.
    const out = await collectNewClips(fakeDir(['a.mp4', 'b.mp4']), new Set())
    expect(out.map((f) => f.name)).toEqual(['a.mp4', 'b.mp4'])
  })

  it('REPORTS a file it could not read instead of swallowing it', async () => {
    // The original failure looked identical to an empty folder. It must not.
    const errs: string[] = []
    const out = await collectNewClips(fakeDir(['x.mp4'], ['x.mp4']), new Set(),
      (name) => errs.push(name))
    expect(out).toEqual([])
    expect(errs).toEqual(['x.mp4'])
  })
})
