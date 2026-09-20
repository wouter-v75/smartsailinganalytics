#!/usr/bin/env node
// scripts/md2pdf.mjs
// ─────────────────────────────────────────────────────────────────────────────
// docs/<name>.md  →  docs/<name>.pdf. The Markdown stays the editable source;
// the PDF is what gets handed to anyone.
//
// pandoc / weasyprint / wkhtmltopdf are NOT installed on this machine, so this
// renders Markdown → HTML → PDF through headless Google Chrome. Two traps, both
// paid for once already:
//   • Must run OUTSIDE Claude Code's Bash sandbox. Seatbelt blocks Chrome's
//     ProcessSingleton unix socket ("Failed to create socket directory") and it
//     aborts before it renders anything.
//   • Chrome does NOT exit after --print-to-pdf. We wait for the output file to
//     stop growing, then kill it. Don't remove that.
//
// The Markdown subset handled is what these docs actually use: ATX headings,
// fenced code, pipe tables, single-level lists, blockquotes, hr, and inline
// code/bold/italic/links. It is deliberately not a general CommonMark parser.
//
// Usage: npm run docs:pdf docs/<name>.md [-- --out other.pdf]
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'

const CHROME = process.env.CHROME_BIN ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const args = process.argv.slice(2)
const inPath = args.find(a => !a.startsWith('--'))
const outFlag = args.indexOf('--out')
if (!inPath) {
  console.error('usage: npm run docs:pdf docs/<name>.md')
  process.exit(1)
}
const outPath = outFlag > -1 ? args[outFlag + 1] : inPath.replace(/\.md$/, '.pdf')

// ── Markdown → HTML ──────────────────────────────────────────────────────────

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// Code spans are protected first so bold/italic/link rules can't reach inside.
function inline(raw) {
  const code = []
  let s = raw.replace(/`([^`]+)`/g, (_, c) => `\u0000${code.push(c) - 1}\u0000`)
  s = esc(s)
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, u) => `<a href="${u}">${t}</a>`)
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  s = s.replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(code[+i])}</code>`)
}

// Split a table row on pipes, ignoring pipes inside code spans (`number|null`).
function cells(line) {
  const parts = []
  let cur = '', tick = false
  for (const ch of line.trim().replace(/^\|/, '').replace(/\|$/, '')) {
    if (ch === '`') tick = !tick
    if (ch === '|' && !tick) { parts.push(cur); cur = '' } else cur += ch
  }
  parts.push(cur)
  return parts.map(c => c.trim())
}

const isSep = l => /^\|[\s:|-]+\|?$/.test(l.trim()) && l.includes('-')
const isBreak = l =>
  /^(\s*)([-*]|\d+\.)\s+/.test(l) || /^```/.test(l) || /^\|/.test(l) ||
  /^#{1,4}\s/.test(l) || /^>\s?/.test(l) || /^---+\s*$/.test(l)

function toHtmlBody(src) {
  const lines = src.split('\n')
  const out = []
  let i = 0, listType = null
  const closeList = () => { if (listType) { out.push(`</${listType}>`); listType = null } }

  while (i < lines.length) {
    const line = lines[i]

    if (/^```/.test(line)) {
      closeList()
      const lang = line.slice(3).trim()
      const body = []
      i++
      while (i < lines.length && !/^```/.test(lines[i])) body.push(lines[i++])
      i++
      out.push(`<pre class="code${lang ? ' lang-' + lang : ''}"><code>${esc(body.join('\n'))}</code></pre>`)
      continue
    }

    if (/^\|/.test(line) && i + 1 < lines.length && isSep(lines[i + 1])) {
      closeList()
      const head = cells(line)
      i += 2
      const rows = []
      while (i < lines.length && /^\|/.test(lines[i])) rows.push(cells(lines[i++]))
      out.push('<table>')
      out.push('<thead><tr>' + head.map(c => `<th>${inline(c)}</th>`).join('') + '</tr></thead>')
      out.push('<tbody>' + rows.map(r =>
        '<tr>' + r.map(c => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') + '</tbody>')
      out.push('</table>')
      continue
    }

    if (/^---+\s*$/.test(line)) { closeList(); out.push('<hr>'); i++; continue }

    const h = line.match(/^(#{1,4})\s+(.*)$/)
    if (h) { closeList(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); i++; continue }

    if (/^>\s?/.test(line)) {
      closeList()
      const body = []
      while (i < lines.length && /^>\s?/.test(lines[i])) body.push(lines[i++].replace(/^>\s?/, ''))
      out.push(`<blockquote>${inline(body.join(' '))}</blockquote>`)
      continue
    }

    const li = line.match(/^(\s*)([-*]|\d+\.)\s+(.*)$/)
    if (li) {
      const want = /^\d+\./.test(li[2]) ? 'ol' : 'ul'
      if (listType !== want) { closeList(); out.push(`<${want}>`); listType = want }
      let text = li[3]
      i++
      while (i < lines.length && lines[i].trim() && !isBreak(lines[i])) text += ' ' + lines[i++].trim()
      out.push(`<li>${inline(text)}</li>`)
      continue
    }

    if (!line.trim()) { closeList(); i++; continue }

    const para = [line]
    i++
    while (i < lines.length && lines[i].trim() && !isBreak(lines[i])) para.push(lines[i++])
    out.push(`<p>${inline(para.join(' '))}</p>`)
  }
  closeList()
  return out.join('\n')
}

const CSS = `
  @page { size: A4; margin: 17mm 15mm 16mm; }
  :root {
    --ink:#1a1d21; --muted:#5b6470; --rule:#d4d9e0;
    --accent:#14526b; --codebg:#f4f6f8; --headbg:#eef1f5;
  }
  * { box-sizing:border-box; }
  body { font:9.7pt/1.48 "Helvetica Neue",Helvetica,Arial,sans-serif; color:var(--ink);
         margin:0; -webkit-font-smoothing:antialiased; }
  p { margin:0 0 .55em; orphans:3; widows:3; }
  a { color:var(--accent); text-decoration:none; border-bottom:.4pt solid #b9ccd6; }
  h1,h2,h3,h4 { break-after:avoid; page-break-after:avoid; color:#10161c; }
  h1 { font-size:19pt; line-height:1.2; margin:0 0 .2em; letter-spacing:-.2pt;
       border-bottom:2.2pt solid var(--accent); padding-bottom:.25em; }
  h1 + p { color:var(--muted); font-size:10pt; }
  h1:not(:first-of-type) { break-before:page; page-break-before:always; margin-top:0; }
  h2 { font-size:13pt; margin:1.5em 0 .45em; letter-spacing:-.15pt;
       border-bottom:.6pt solid var(--rule); padding-bottom:.2em; }
  h3 { font-size:10.6pt; margin:1.15em 0 .35em; color:var(--accent); }
  h4 { font-size:9.8pt; margin:1em 0 .3em; }
  hr { border:0; border-top:.6pt solid var(--rule); margin:1.3em 0; }
  ul,ol { margin:0 0 .6em; padding-left:1.35em; }
  li { margin:0 0 .25em; break-inside:avoid; }
  blockquote { margin:.6em 0 .8em; padding:.5em .8em; border-left:2.5pt solid var(--accent);
               background:#f6f9fb; color:#26313b; font-style:italic; break-inside:avoid; }
  code { font:8.6pt/1.3 "SF Mono",Menlo,Consolas,monospace; background:var(--codebg);
         padding:.08em .3em; border-radius:2px; color:#0f3d4f; word-break:break-word; }
  pre.code { background:var(--codebg); border:.5pt solid var(--rule);
             border-left:2.5pt solid #9db4c0; padding:.6em .8em; margin:.6em 0 .9em;
             border-radius:3px; break-inside:avoid; page-break-inside:avoid;
             overflow-wrap:anywhere; }
  pre.code code { background:none; padding:0; font-size:8.2pt; line-height:1.42;
                  color:#1d2a33; white-space:pre-wrap; }
  table { width:100%; border-collapse:collapse; margin:.55em 0 1em; font-size:8.3pt;
          line-height:1.34; }
  thead { display:table-header-group; }
  tr { break-inside:avoid; page-break-inside:avoid; }
  th,td { border:.5pt solid var(--rule); padding:3.4pt 5pt; text-align:left;
          vertical-align:top; }
  th { background:var(--headbg); font-weight:600; color:#101820; }
  tbody tr:nth-child(even) td { background:#fafbfc; }
  td code, th code { font-size:7.9pt; background:#e9edf1; }
  td a, th a { word-break:break-word; }
`

// ── render ───────────────────────────────────────────────────────────────────

const src = fs.readFileSync(inPath, 'utf8')
const title = (src.match(/^#\s+(.*)$/m) || [, path.basename(inPath, '.md')])[1].replace(/[`*]/g, '')
const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>${CSS}</style></head><body>
${toHtmlBody(src)}
</body></html>`

const tmpHtml = path.join(os.tmpdir(), `md2pdf-${process.pid}.html`)
const profile = path.join(os.tmpdir(), `md2pdf-chrome-${process.pid}`)
fs.writeFileSync(tmpHtml, html)

if (!fs.existsSync(CHROME)) {
  console.error(`Chrome not found at ${CHROME}. Set CHROME_BIN.`)
  process.exit(1)
}

const abs = path.resolve(outPath)
fs.rmSync(abs, { force: true })

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--disable-crash-reporter',
  `--user-data-dir=${profile}`,
  '--no-pdf-header-footer', '--print-to-pdf-no-header',
  '--run-all-compositor-stages-before-draw', '--virtual-time-budget=10000',
  `--print-to-pdf=${abs}`, `file://${tmpHtml}`,
], { stdio: 'ignore' })

// Chrome won't exit on its own: wait for the PDF to stop growing, then kill it.
const started = Date.now()
let lastSize = -1, stable = 0
const poll = setInterval(() => {
  const size = fs.existsSync(abs) ? fs.statSync(abs).size : -1
  if (size > 0 && size === lastSize) stable++; else stable = 0
  lastSize = size

  if (stable >= 2 || Date.now() - started > 90_000) {
    clearInterval(poll)
    try { chrome.kill('SIGKILL') } catch {}
    // Best-effort: the just-killed Chrome may still be writing into the profile
    // dir, so a failed cleanup must never fail the run (ENOTEMPTY).
    try { fs.rmSync(tmpHtml, { force: true }) } catch {}
    try {
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch {}
    if (lastSize > 0) {
      console.log(`${outPath}  (${(lastSize / 1024).toFixed(0)} kB)`)
    } else {
      console.error('Chrome produced no PDF — are you running inside the Bash sandbox?')
      process.exit(1)
    }
  }
}, 400)
