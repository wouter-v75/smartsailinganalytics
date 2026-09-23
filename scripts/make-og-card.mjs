// Regenerate the link-preview card: src/app/opengraph-image.jpg
//
//   node scripts/make-og-card.mjs
//
// The card is a STATIC file on purpose. It was briefly a generated route
// (opengraph-image.tsx + next/og) and that took the front page down in
// production: the route read its background frame from public/, which is served
// by the CDN and is not inside the serverless bundle, so the read threw at
// module scope and took `/` — which Next bundles into the same segment — with
// it. A static file has no runtime, cannot fail, and is faster for the preview
// bots that actually fetch it. See src/lib/__tests__/appAssetPaths.test.ts.
//
// The mark here must match src/app/icon.svg and src/components/marketing/Logo.tsx.
//
// Run this after changing the hero footage or the wording on the card. It needs
// ffmpeg (for the frame) and Chrome, and must run OUTSIDE Claude Code's Bash
// sandbox — Seatbelt blocks Chrome's ProcessSingleton socket, exactly as for
// scripts/md2pdf.mjs.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const CHROME = process.env.CHROME_BIN ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const ROOT = path.resolve(import.meta.dirname, '..')
const FRAME = path.join(ROOT, 'src/app/og-hero.jpg')     // 1200×630, cut from the hero clip
const OUT = path.join(ROOT, 'src/app/opengraph-image.jpg')

if (!fs.existsSync(FRAME)) {
  console.error(`Missing ${FRAME}. Cut it from the hero clip with:
  ffmpeg -ss 8 -i "<source>.mp4" -frames:v 1 \\
    -vf "crop=832:436:0:14,scale=1200:630:flags=lanczos" -q:v 3 ${FRAME}`)
  process.exit(1)
}
if (!fs.existsSync(CHROME)) {
  console.error(`Chrome not found at ${CHROME}. Set CHROME_BIN.`)
  process.exit(1)
}

const frameB64 = fs.readFileSync(FRAME).toString('base64')

// Inlined as base64 rather than referenced by file:// — headless Chrome refuses
// local subresources from a file:// document without --allow-file-access-from-files,
// and inlining avoids needing that flag at all.
const html = `<!doctype html><meta charset="utf-8">
<style>
  @font-face { font-family: sys; src: local("Helvetica Neue"), local("Helvetica"), local("Arial"); }
  html,body { margin:0; padding:0; width:1200px; height:630px; overflow:hidden; }
  body { font-family: sys, -apple-system, Helvetica, Arial, sans-serif; }
  .card { position:relative; width:1200px; height:630px; }
  .frame { width:1200px; height:630px; object-fit:cover; display:block; }
  .band {
    position:absolute; left:0; right:0; bottom:0; height:190px;
    background:linear-gradient(to top, rgba(4,16,26,.93), rgba(4,16,26,0));
    display:flex; align-items:flex-end; justify-content:space-between;
    padding:0 48px 36px; box-sizing:border-box;
  }
  .id { display:flex; align-items:center; gap:14px; }
  .name { color:#EAF6FA; font-size:31px; font-weight:700; letter-spacing:-.4px; }
  .sub { color:rgba(234,246,250,.8); font-size:21px; margin-top:10px; }
  .credit { color:rgba(234,246,250,.62); font-size:17px; }
</style>
<div class="card">
  <img class="frame" src="data:image/jpeg;base64,${frameB64}">
  <div class="band">
    <div>
      <div class="id">
        <svg width="36" height="36" viewBox="0 0 64 64">
          <rect width="64" height="64" rx="15" fill="#0B2032"/>
          <path d="M30 10 L16 52 L34 52 Q39 30 30 10 Z" fill="#22D3EE"/>
          <path d="M44 20 L36 52 L50 52 Q54 35 44 20 Z" fill="#EAF6FA"/>
        </svg>
        <div class="name">Shared Sailing Analytics</div>
      </div>
      <div class="sub">Northstar &middot; 2026 Maxi World Champion &middot; Porto Cervo</div>
    </div>
    <div class="credit">Footage: Jonathan Gagachian</div>
  </div>
</div>`

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'og-card-'))
const htmlPath = path.join(tmp, 'card.html')
const pngPath = path.join(tmp, 'card.png')
fs.writeFileSync(htmlPath, html)

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--disable-crash-reporter',
  `--user-data-dir=${path.join(tmp, 'profile')}`,
  '--hide-scrollbars',
  '--window-size=1200,630',
  '--force-device-scale-factor=1',
  `--screenshot=${pngPath}`,
  `file://${htmlPath}`,
], { stdio: 'ignore' })

// Chrome does NOT exit after --screenshot, the same way it does not after
// --print-to-pdf (see CLAUDE.md and scripts/md2pdf.mjs). Waiting on 'exit'
// hangs forever, so poll for the file, then kill it. That kill is load-bearing.
const deadline = Date.now() + 30_000
async function waitForShot() {
  while (Date.now() < deadline) {
    if (fs.existsSync(pngPath)) {
      // Let the write settle before reading it.
      const a = fs.statSync(pngPath).size
      await new Promise((r) => setTimeout(r, 250))
      if (a > 0 && fs.statSync(pngPath).size === a) return true
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  return false
}

const ok = await waitForShot()
try { chrome.kill('SIGKILL') } catch { /* already gone */ }

{
  if (!ok) {
    console.error('Chrome produced no screenshot within 30s.')
    process.exit(1)
  }
  // PNG of a photograph is needlessly large for a preview card; JPEG at q3 is
  // visually identical at the size these are displayed.
  const ff = spawn('ffmpeg', ['-v', 'error', '-i', pngPath, '-q:v', '3', OUT, '-y'], { stdio: 'inherit' })
  ff.on('exit', (code) => {
    if (code !== 0) process.exit(code ?? 1)
    const kb = (fs.statSync(OUT).size / 1024).toFixed(0)
    console.log(`${path.relative(ROOT, OUT)}  (${kb} kB, 1200x630)`)
    fs.rmSync(tmp, { recursive: true, force: true })
  })
}
