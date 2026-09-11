// Card thumbnails at card size.
//
// Bunny Stream's thumbnail.jpg is the full 1280×720 frame (~105 KB, measured
// 11 Sept) but a phone shows it at 96×64: a day of 30 clips pulls ~3 MB of
// posters, competing on marina wifi with the clip being opened. Route Bunny
// thumbnails through Next's image optimiser (resized, WebP/AVIF, cached at the
// edge) at card width — a few KB each. Anything else passes through untouched;
// callers fall back to the original URL if the optimiser fails.

const BUNNY_CDN = /^https:\/\/[a-z0-9-]+\.b-cdn\.net\//i

// Widths must be in Next's default imageSizes/deviceSizes, or the optimiser
// rejects the request (and the card falls back to the full-size original).
export function thumbSrc(url: string | null | undefined, width: 128 | 256 | 384 | 640 = 256): string | null | undefined {
  if (!url || !BUNNY_CDN.test(url)) return url
  return `/_next/image?url=${encodeURIComponent(url)}&w=${width}&q=60`
}
