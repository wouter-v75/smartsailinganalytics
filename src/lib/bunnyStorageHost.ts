// Where a Bunny Storage zone actually lives.
//
// The API host depends on the zone's PRIMARY region, and Frankfurt is the odd
// one out: it has no prefix. Bunny's docs list `storage.bunnycdn.com` for
// Frankfurt and `<code>.storage.bunnycdn.com` for everywhere else (uk, ny, la,
// sg, se, br, jh, syd).
//
// Worth knowing when reading those docs: the auto-generated OpenAPI
// description lists a SHORTER and partly different set of regions, and maps
// "New York" to `la.storage.bunnycdn.com`. The two disagree. The dashboard's
// Access tab is the only authority for a given zone.
//
// This is one function because getting it wrong is silent in the worst way: a
// PUT to the wrong regional host does not fail with "wrong region", it fails
// with 401, which reads as a bad key.

/** Default region code when none is configured. `de` is Frankfurt. */
export const DEFAULT_STORAGE_REGION = 'de'

export function storageHost(
  region: string | undefined = process.env.BUNNY_STORAGE_REGION
): string {
  const r = (region || DEFAULT_STORAGE_REGION).trim().toLowerCase()
  return r === DEFAULT_STORAGE_REGION
    ? 'https://storage.bunnycdn.com'
    : `https://${r}.storage.bunnycdn.com`
}

/**
 * The Storage API URL of one object — the address that answers to an `AccessKey`
 * header, NOT the public pull-zone URL.
 *
 * Leading slashes on `path` are dropped so a caller holding `/sessions/...` and
 * one holding `sessions/...` address the same object rather than two.
 */
export function storageObjectUrl(
  zone: string,
  path: string,
  region?: string | undefined
): string {
  return `${storageHost(region)}/${zone}/${path.replace(/^\/+/, '')}`
}
