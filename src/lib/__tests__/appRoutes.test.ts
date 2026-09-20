// src/lib/__tests__/appRoutes.test.ts
// ─────────────────────────────────────────────────────────────────────────────
// The App Router's own rules, checked without running `next build`.
//
// WHY THIS EXISTS. A commit on feat/squad-sharing added
// src/app/api/videos/[id]/share beside the existing [videoId]/share. tsc,
// vitest, next lint and lint:undef were all green; the Vercel build died
// instantly with "You cannot use different slug names for the same dynamic
// path ('id' !== 'videoId')". None of the other checks can see this, because it
// is a property of the DIRECTORY TREE and not of any file's contents — and
// CLAUDE.md forbids running `next build` locally while `next dev` is up, which
// is most of the time. So the tree gets its own test.
//
// Two rules, both of which Next enforces at build time:
//   1. One dynamic slug NAME per parent directory.
//   2. One route.ts per resolved URL — two directories differing only in slug
//      name resolve to the same path, and the loser is silently unreachable.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest'
import { readdirSync, statSync } from 'fs'
import { join, relative } from 'path'

const APP = join(process.cwd(), 'src', 'app')

/** Every directory under src/app, as paths relative to it. */
function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (!statSync(full).isDirectory()) continue
    acc.push(full)
    walk(full, acc)
  }
  return acc
}

const dirs = walk(APP)
const isDynamic = (name: string) => /^\[.*\]$/.test(name)
const slugOf = (name: string) => name.replace(/^\[+\.{0,3}|\]+$/g, '')

describe('src/app route tree', () => {
  it('uses ONE slug name per dynamic level', () => {
    const byParent = new Map<string, Set<string>>()
    for (const d of dirs) {
      const name = d.split('/').pop()!
      if (!isDynamic(name)) continue
      const parent = relative(APP, d.slice(0, -name.length - 1)) || '.'
      if (!byParent.has(parent)) byParent.set(parent, new Set())
      byParent.get(parent)!.add(slugOf(name))
    }
    const clashes = [...byParent.entries()]
      .filter(([, slugs]) => slugs.size > 1)
      .map(([parent, slugs]) => `${parent}: ${[...slugs].join(' !== ')}`)
    expect(clashes).toEqual([])
  })

  it('has no two route handlers resolving to the same URL', () => {
    // Slug NAMES vanish from the URL, so [id]/share and [videoId]/share are
    // both /api/videos/:x/share. Group directories by their normalised path.
    const byUrl = new Map<string, string[]>()
    for (const d of dirs) {
      const hasRoute = readdirSync(d).some((f) => /^route\.(ts|tsx|js|jsx)$/.test(f))
      if (!hasRoute) continue
      const rel = relative(APP, d)
      const url = rel.split('/')
        .filter((seg) => !/^\(.*\)$/.test(seg))        // route groups are not URL
        .map((seg) => (isDynamic(seg) ? ':param' : seg))
        .join('/')
      if (!byUrl.has(url)) byUrl.set(url, [])
      byUrl.get(url)!.push(rel)
    }
    const dupes = [...byUrl.entries()]
      .filter(([, paths]) => paths.length > 1)
      .map(([url, paths]) => `${url} ← ${paths.join(' + ')}`)
    expect(dupes).toEqual([])
  })
})
