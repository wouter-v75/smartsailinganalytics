// No route may read a file out of public/ at runtime.
//
// This exists because doing it took the front page down in production, in a way
// that no local check could have caught.
//
// src/app/opengraph-image.tsx read its background frame with
//     readFileSync(join(process.cwd(), 'public/media/og-hero.jpg'))
// which is correct locally — `next start` runs beside the real public/ — and
// wrong in a serverless bundle, where public/ is served by the CDN and is NOT
// inside the function. The read threw at MODULE SCOPE, Next bundles a segment's
// routes together, and so `/` returned 500 while the OG route itself still
// served a build-cached PNG. Everything looked fine except the front page.
//
// The fix is to keep an asset next to the route that uses it and load it with
//     fetch(new URL('./thing.jpg', import.meta.url))
// which Vercel's file tracing follows into the bundle.
//
// Static imports (`import x from '../../public/…'`) are a different thing and
// are fine — the bundler resolves those at build time. This only looks for
// runtime filesystem reads aimed at public/.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'

const APP_ROOT = join(process.cwd(), 'src/app')

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full))
    else if (/\.(ts|tsx|js|jsx)$/.test(name)) out.push(full)
  }
  return out
}

// `readFileSync(... 'public/...')`, `readFile('public/…')`, and the
// `process.cwd()` + public join that caused the outage.
const RUNTIME_READ = /(readFileSync|readFile|createReadStream)\s*\([^)]*public[/\\]/s
const CWD_PUBLIC = /process\.cwd\(\)[^)]*['"`]public[/\\]/s

describe('app routes do not read public/ at runtime', () => {
  const files = sourceFiles(APP_ROOT)

  it('finds the app tree', () => {
    expect(files.length).toBeGreaterThan(5)
  })

  for (const file of files) {
    const rel = file.slice(APP_ROOT.length + 1)
    it(rel, () => {
      const src = readFileSync(file, 'utf8')
      // Strip comments so the explanation above (and others like it) does not
      // trip the very check it documents.
      const code = src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
      const hit = RUNTIME_READ.test(code) || CWD_PUBLIC.test(code)
      expect(
        hit,
        `${rel} reads from public/ at runtime. public/ is served by the CDN and is ` +
          `not inside the serverless function, so this throws in production — and if ` +
          `it throws at module scope it takes the whole route segment with it. Put the ` +
          `asset next to the route and load it with fetch(new URL('./asset', import.meta.url)).`,
      ).toBe(false)
    })
  }
})
