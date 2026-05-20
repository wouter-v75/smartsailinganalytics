// Bunny CDN — Advanced Token Authentication (HMAC-SHA256).
//
// Reference (verified against docs.bunny.net/cdn/security/token-authentication
// on 2026-05-19):
//
//   token = "HS256-" + Base64URL(
//             HMAC-SHA256(security_key,
//                         signature_path + expires + signing_data + user_ip)
//           )
//
// Where:
//   security_key   — HMAC key (the value from the Pull Zone's Security tab).
//   signature_path — URL path (or `token_path` override if directory tokens).
//   expires        — UNIX seconds (NOT milliseconds).
//   signing_data   — alphabetically-sorted query params joined as
//                    `key=value&key=value`, excluding `token` and `expires`.
//                    Empty string when there are none.
//   user_ip        — optional IP for IP-locked tokens; empty string when
//                    not using IP validation.
//
// Final base64 URL-safe transform: + → -, / → _, strip = padding.
//
// URL format:
//   https://<pull-host>/<path>?token=HS256-<sig>&expires=<unix-seconds>
//
// We do NOT use directory tokens (token_path), IP locking, country
// restrictions, or speed limits — single-file MP4 playback only. Keeps the
// signature trivially compatible with the player's Range requests.
//
// IMPORTANT: Basic (MD5) token auth still works on Bunny but is officially
// deprecated. Don't fall back to it. If you ever see `BUNNY_TOKEN_AUTH_KEY`
// failing, regenerate the key in the Pull Zone's Security tab — Bunny
// rotates the key when you toggle the feature off+on.

import crypto from 'crypto'

const TOKEN_KEY = process.env.BUNNY_TOKEN_AUTH_KEY
const PULL_HOST = process.env.BUNNY_PULL_HOST

export function bunnyConfigured(): boolean {
  return Boolean(TOKEN_KEY && PULL_HOST)
}

interface SignArgs {
  /** Path inside the zone, e.g. `sessions/2025-09-03/proxies/v_abc.mp4`. */
  path: string
  /** TTL in seconds; default 1 hour (typical session length). */
  ttlSec?: number
}

export function signBunnyUrl({
  path,
  ttlSec = 3600,
}: SignArgs): { url: string; expires: number } | null {
  if (!TOKEN_KEY || !PULL_HOST) return null

  // Signature path must start with '/'.
  const signaturePath = path.startsWith('/') ? path : `/${path}`
  const expires = Math.floor(Date.now() / 1000) + ttlSec

  // signing_data is empty (no extra query params we want in the signature).
  // user_ip is empty (we're not using IP locking).
  const message = `${signaturePath}${expires}`

  const hmac = crypto
    .createHmac('sha256', TOKEN_KEY)
    .update(message)
    .digest('base64')

  const tokenSig = hmac
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

  const token = `HS256-${tokenSig}`

  return {
    url: `https://${PULL_HOST}${signaturePath}?token=${token}&expires=${expires}`,
    expires,
  }
}
