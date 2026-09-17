// Every route handler under /api must authorise its own caller.
//
// The middleware does NOT gate /api (see its matcher), so an unguarded route is
// open to the internet. That is not hypothetical: /api/storage/credentials once
// returned the Bunny Storage read/write key to anonymous callers, and
// /api/bunny/storage would list, read, overwrite and delete any object in the
// zone for them.
//
// This test walks the route tree and fails on any handler that neither calls a
// guard nor appears on the allow-list below WITH a reason. Adding a route is
// then a choice you have to make in writing.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'

const API_ROOT = join(process.cwd(), 'src/app/api')

// Routes deliberately reachable without a session. Each one's authorisation is
// something OTHER than the app session, named here so it can be checked.
const PUBLIC_ROUTES: Record<string, string> = {
  'share/[token]': 'the share token itself — looked up, checked for revoke + expiry, grants one clip',
  'invitations/[token]': 'the invitation token — the recipient has no account yet, that is the point',
  'invitations/[token]/stash': 'same invitation token, carried through signup',
  'hls/[guid]/[file]': 'the signed link minted by /api/videos/[id]/url — AVPlayer does not send our cookie',
  'stream/webhook': "Bunny's HMAC signature (verifyBunnySignature) — the caller is Bunny, not a user",
}

// Any of these in the file body counts as authorising the caller.
const GUARDS = [
  'requireActiveUser',
  'requireAdmin',
  'requireTeamManager',
  'authedUserId',
  'auth.getUser()',
  'getFinanceCaller',
  'verifyBunnySignature',
]

function routeFiles(dir: string, rel = ''): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      out.push(...routeFiles(full, rel ? `${rel}/${name}` : name))
    } else if (name === 'route.ts' || name === 'route.js') {
      out.push(rel)
    }
  }
  return out
}

describe('every /api route authorises its caller', () => {
  const routes = routeFiles(API_ROOT)

  it('finds the route tree', () => {
    expect(routes.length).toBeGreaterThan(50)
  })

  for (const rel of routes) {
    const label = PUBLIC_ROUTES[rel] ? `${rel} — public: ${PUBLIC_ROUTES[rel]}` : rel
    it(label, () => {
      const src = readFileSync(join(API_ROOT, rel, 'route.ts'), 'utf8')
      const guarded = GUARDS.some((g) => src.includes(g))
      if (PUBLIC_ROUTES[rel]) {
        // A public route may still guard (e.g. the webhook's signature check);
        // what it must not do is quietly become session-authorised without the
        // note above being removed. Nothing to assert but its own presence.
        expect(typeof PUBLIC_ROUTES[rel]).toBe('string')
        return
      }
      expect(guarded, `${rel} has no auth guard — add one, or list it in PUBLIC_ROUTES with the reason it is safe`).toBe(true)
    })
  }
})
