// scripts/drime-manifest.ts
// ─────────────────────────────────────────────────────────────────────────────
// Walk a Drime (BeDrive) public share and write a manifest of every file in it.
//
//   npx vite-node scripts/drime-manifest.ts -- <share-url> --out drime.json
//
// Read-only. It lists; it downloads nothing and uploads nothing.
//
// The two endpoints, both anonymous on a public share:
//
//   listing   GET /api/v1/shareable-links/<name>:<b64>?withEntries=true&page=N
//   download  GET /api/v1/file-entries/<id>/raw?shareable_link=<linkId>
//
// where <b64> is base64("<folderId>|") — the folder id with a trailing pipe.
// That is how the SPA addresses a subfolder of a share, and it is the whole
// trick: the share is registered against its root folder, but any descendant
// folder id encoded the same way lists fine.
//
// A caution that costs a day if missed: `created_at` here is the UPLOAD time,
// not the capture time, and Drime stamps it `…Z` while meaning local wall
// clock — the same lie the log exports and EXIF tell (see CLAUDE.md). Nothing
// in this file may be used to decide which sailing day a photo belongs to.
// That comes from EXIF DateTimeOriginal, in day-media-upload.ts.
//
// Runs OUTSIDE Claude Code's Bash sandbox (it needs the network).
// ─────────────────────────────────────────────────────────────────────────────

import { writeFileSync } from 'fs'

const args = process.argv.slice(2)
const argVal = (f: string) => (args.includes(f) ? args[args.indexOf(f) + 1] : null)
const shareUrl = args.find(a => a.startsWith('http')) || ''
const out = argVal('--out') || 'drime-manifest.json'
const fail = (m: string): never => { console.error(m); process.exit(1) }

if (!shareUrl) fail('usage: drime-manifest.ts <share-url> [--out file.json]')

// https://app.drime.cloud/drive/s/Northstar76:ODk5MzUyMDQ4fA
const m = shareUrl.match(/\/drive\/s\/([^/:]+):([^/?#]+)/)
if (!m) fail(`could not read a share hash out of ${shareUrl}`)
const linkName = m![1], rootB64 = m![2]
const ORIGIN = new URL(shareUrl).origin

const folderHash = (id: number | string) =>
  `${linkName}:${Buffer.from(`${id}|`).toString('base64').replace(/=+$/, '')}`

const rootId = Buffer.from(rootB64 + '==', 'base64').toString().replace(/\|$/, '')

export interface Entry {
  id: number
  name: string
  type: string
  file_size: number | null
  extension: string | null
  created_at: string | null
  updated_at: string | null
  /** Slash-joined folder names from the share root. */
  dir: string
}

let linkId: number | null = null

async function listFolder(id: number | string): Promise<Entry[]> {
  const all: Entry[] = []
  for (let page = 1; page < 200; page++) {
    const url = `${ORIGIN}/api/v1/shareable-links/${folderHash(id)}?withEntries=true&page=${page}&order=updated_at:desc`
    const r = await fetch(url, { headers: { Accept: 'application/json' } })
    if (!r.ok) throw new Error(`list ${id} page ${page}: HTTP ${r.status}`)
    const j = await r.json() as {
      link?: { id: number }
      folderChildren?: { data: Entry[]; last_page: number }
      entries?: { data: Entry[]; last_page: number }
    }
    if (j.link?.id && linkId == null) linkId = j.link.id
    const box = j.folderChildren || j.entries
    if (!box) break
    all.push(...(box.data || []))
    if (page >= (box.last_page || 1)) break
  }
  return all
}

/** macOS resource forks and Finder droppings. Never real content. */
const junk = (n: string) => n.startsWith('._') || n === '.DS_Store' || n === '.localized'

async function walk(id: number | string, dir: string, out: Entry[], depth = 0): Promise<void> {
  if (depth > 6) return
  const kids = await listFolder(id)
  for (const k of kids) {
    if (junk(k.name)) continue
    if (k.type === 'folder') {
      const sub = dir ? `${dir}/${k.name}` : k.name
      process.stderr.write(`  ${sub}\n`)
      await walk(k.id, sub, out, depth + 1)
    } else {
      out.push({ ...k, dir })
    }
  }
}

async function main() {
  console.error(`walking ${shareUrl}`)
  const entries: Entry[] = []
  await walk(rootId, '', entries)

  writeFileSync(out, JSON.stringify({
    share: shareUrl, origin: ORIGIN, linkName, linkId, rootId,
    fetchedAt: new Date().toISOString(),
    entries,
  }, null, 1))

  // ── what is in there ──────────────────────────────────────────────────────
  const byDir = new Map<string, Entry[]>()
  for (const e of entries) {
    if (!byDir.has(e.dir)) byDir.set(e.dir, [])
    byDir.get(e.dir)!.push(e)
  }
  const GB = (n: number) => (n / 1e9).toFixed(2)
  const sum = (es: Entry[]) => es.reduce((a, e) => a + (e.file_size || 0), 0)

  // The two populations the runbook distinguishes: camera originals are
  // _MG_*.JPG, landscape, 2-6 MB; speed-team compilations are 01.jpg, 02.jpg…,
  // 20-48 MB, portrait, made in PhotoScape.
  const isOriginal = (e: Entry) => /^_MG_.*\.jpe?g$/i.test(e.name)
  const isCompilation = (e: Entry) => /^\d{1,2}\.jpe?g$/i.test(e.name)
  const isDoc = (e: Entry) => /\.(pdf|docx?|xlsx?|pptx?|csv|txt)$/i.test(e.name)

  console.log('')
  console.log('folder                              files   originals  compils    docs     other     size')
  console.log('─'.repeat(95))
  for (const [dir, es] of Array.from(byDir).sort()) {
    const o = es.filter(isOriginal).length
    const c = es.filter(isCompilation).length
    const d = es.filter(isDoc).length
    const other = es.length - o - c - d
    console.log(
      `${(dir || '(root)').padEnd(34)} ${String(es.length).padStart(6)} ${String(o).padStart(11)} ${String(c).padStart(8)} ${String(d).padStart(7)} ${String(other).padStart(9)} ${(GB(sum(es)) + ' GB').padStart(9)}`)
  }
  console.log('─'.repeat(95))
  console.log(`${entries.length} files, ${GB(sum(entries))} GB total — ` +
    `${entries.filter(isOriginal).length} camera originals, ` +
    `${entries.filter(isCompilation).length} compilations, ` +
    `${entries.filter(isDoc).length} documents.`)
  console.log(`\nmanifest → ${out}`)

  // Anything not classified is worth eyeballing before a bulk upload.
  const other = entries.filter(e => !isOriginal(e) && !isCompilation(e) && !isDoc(e))
  if (other.length) {
    console.log(`\n${other.length} files matching none of the three patterns:`)
    const names = new Map<string, number>()
    for (const e of other) {
      const k = e.name.replace(/\d+/g, '#')
      names.set(k, (names.get(k) || 0) + 1)
    }
    for (const [k, n] of Array.from(names).sort((a, b) => b[1] - a[1]).slice(0, 20)) {
      console.log(`  ${String(n).padStart(4)} × ${k}`)
    }
  }
}

main().catch(e => fail(e?.message || String(e)))
