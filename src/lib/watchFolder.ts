// watchFolder.ts — pick up clips from the encoder's output folder as they land.
//
// WHY. Trimming and uploading were strictly serial: on 8 Sept the encode
// finished at 15:17Z and the first upload began at 15:40Z. Nothing forced that
// — it was just a person waiting for one job to end before starting the next.
// Watching the folder lets the two overlap, so the race start is uploading
// while the gybes are still being cut.
//
// WHAT MAKES THIS SAFE. scripts/compress-videos.sh writes each segment to a
// hidden `.<name>.part.mp4` and renames it only when ffmpeg exits cleanly. So a
// file appearing under its final name is COMPLETE by construction — there is no
// need to guess from size or mtime, and no window in which we could upload half
// a clip. Both halves of that contract must hold together: if the encoder ever
// stops writing to a temp name, this breaks silently. Hence the explicit checks
// below rather than a bare extension test.

/** Extensions the video importer accepts. Mirrors handleVids in the UI. */
const VIDEO_RE = /\.(mp4|mov|mts|avi|mkv|m4v)$/i

/**
 * Is this a finished clip we should pick up?
 *
 * Rejects, in order of how likely each is to bite:
 *  - `.<name>.part.mp4` — an encode in flight. Dot-prefixed, so also caught by
 *    the dotfile rule, but named explicitly because it is THE case that matters.
 *  - dotfiles generally — `._DJI_0169.MP4` AppleDouble stubs litter every exFAT
 *    card copied on a Mac and are a few hundred bytes of resource fork, not video.
 *  - anything that is not a video extension — manifests, logs, .DS_Store.
 */
export function isCompleteClip(name: string): boolean {
  if (!name || name.startsWith('.')) return false
  if (/\.part\.[^.]+$/i.test(name)) return false
  return VIDEO_RE.test(name)
}

/**
 * Names in `entries` that are finished clips we have not handled yet.
 * Returned in upload-friendly order (see sortForUpload at the call site); here
 * we only guarantee stability, so a folder listed twice yields the same order.
 */
export function newClipNames(entries: readonly string[], seen: ReadonlySet<string>): string[] {
  return entries.filter((n) => isCompleteClip(n) && !seen.has(n)).sort()
}

export interface DirectoryHandleLike {
  values(): AsyncIterableIterator<{
    kind: string
    name: string
    getFile?: () => Promise<File>
  }>
}

/**
 * Read a directory handle and return Files for every finished clip not in
 * `seen`. Adds each returned name to `seen` so a caller polling on a timer does
 * not hand the same clip over twice.
 *
 * A file that cannot be read right now is left OUT of `seen`, so the next poll
 * retries it rather than dropping the clip silently.
 */
export async function collectNewClips(
  dir: DirectoryHandleLike,
  seen: Set<string>
): Promise<File[]> {
  const names: Array<{ name: string; getFile: () => Promise<File> }> = []
  for await (const entry of dir.values()) {
    if (entry.kind !== 'file' || !entry.getFile) continue
    if (!isCompleteClip(entry.name) || seen.has(entry.name)) continue
    names.push({ name: entry.name, getFile: entry.getFile })
  }
  names.sort((a, b) => a.name.localeCompare(b.name))

  const out: File[] = []
  for (const n of names) {
    try {
      const file = await n.getFile()
      seen.add(n.name)
      out.push(file)
    } catch {
      // Leave it unseen: a file being replaced mid-read comes back next poll.
    }
  }
  return out
}

/** Does this browser have the directory picker? Chromium yes, Safari no. */
export function canWatchFolders(): boolean {
  return typeof window !== 'undefined' && typeof (window as unknown as {
    showDirectoryPicker?: unknown
  }).showDirectoryPicker === 'function'
}
