#!/usr/bin/env node
// One-shot refactor tool: move top-level declarations out of a big module into a
// new one, carrying their leading comments and rewiring imports both ways.
//
// Not a general bundler — it understands exactly the shapes this file uses:
//   import D from 'm' / import * as N from 'm' / import { a, b as c } from 'm'
// and top-level `function|const|let|class NAME`.
import fs from 'fs'
import path from 'path'

const HOST = 'src/components/SmartSailingAnalytics_UI.jsx'

function read(f) { return fs.readFileSync(f, 'utf8').split('\n') }

// ── parse the host's import block ───────────────────────────────────────────
// Returns { bySymbol: Map<name,{spec,kind,local,imported}>, lastLine }
function parseImports(lines) {
  const bySymbol = new Map()
  let last = -1
  for (let i = 0; i < lines.length; i++) {
    if (!/^import\s/.test(lines[i])) continue
    // join continuation lines until we see the closing quote+;
    let stmt = lines[i], j = i
    while (!/from\s+['"][^'"]+['"]\s*;?\s*$/.test(stmt) && !/^import\s+['"]/.test(stmt) && j + 1 < lines.length) {
      stmt += '\n' + lines[++j]
    }
    last = Math.max(last, j)
    const m = stmt.match(/from\s+['"]([^'"]+)['"]/)
    if (!m) { i = j; continue }           // bare `import 'x'`
    const spec = m[1]
    const clause = stmt.slice(stmt.indexOf('import') + 6, stmt.lastIndexOf('from')).trim()
    const named = clause.match(/\{([\s\S]*)\}/)
    if (named) {
      for (const part of named[1].split(',')) {
        const p = part.trim(); if (!p) continue
        const [imported, local] = p.split(/\s+as\s+/).map(s => s.trim())
        bySymbol.set(local || imported, { spec, kind: 'named', imported, local: local || imported })
      }
    }
    const head = clause.replace(/\{[\s\S]*\}/, '').replace(/,\s*$/, '').trim()
    if (head) {
      const star = head.match(/^\*\s+as\s+(\w+)$/)
      if (star) bySymbol.set(star[1], { spec, kind: 'star', local: star[1] })
      else if (/^\w+$/.test(head)) bySymbol.set(head, { spec, kind: 'default', local: head })
    }
    i = j
  }
  return { bySymbol, lastLine: last }
}

// ── find top-level declarations, with their leading comment block ───────────
function findDecls(lines) {
  const re = /^(?:export\s+)?(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/
  const out = []
  lines.forEach((l, i) => { const m = l.match(re); if (m) out.push({ name: m[1], code: i }) })
  out.forEach((d, k) => {
    // body runs to the line before the next decl's own leading comments
    let end = k + 1 < out.length ? out[k + 1].code - 1 : lines.length - 1
    while (end > d.code && (/^\s*\/\//.test(lines[end]) || /^\s*$/.test(lines[end]))) end--
    d.end = end
    // leading comments: contiguous `//` lines directly above
    let s = d.code
    while (s > 0 && /^\s*\/\//.test(lines[s - 1])) s--
    d.start = s
  })
  return out
}

function identsIn(text) {
  const out = new Set()
  // strip strings and comments so their words do not count as references
  const clean = text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/`(?:\\.|\$\{[^}]*\}|[^`\\])*`/g, m => m.replace(/[^$\{\}\w]/g, ' '))
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
  for (const m of clean.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)/g)) out.add(m[1])
  return out
}

function relSpec(fromFile, spec) {
  if (!spec.startsWith('.')) return spec
  const abs = path.resolve(path.dirname(HOST), spec)
  let r = path.relative(path.dirname(fromFile), abs)
  if (!r.startsWith('.')) r = './' + r
  return r
}

// ── main ────────────────────────────────────────────────────────────────────
const [, , targetFile, ...names] = process.argv
if (!targetFile || !names.length) { console.error('usage: extract.mjs <target> <Name...>'); process.exit(1) }

const lines = read(HOST)
const { bySymbol } = parseImports(lines)
const decls = findDecls(lines)
const want = decls.filter(d => names.includes(d.name))
const missing = names.filter(n => !want.some(d => d.name === n))
if (missing.length) { console.error('not found: ' + missing.join(', ')); process.exit(1) }

// contiguity check — we only move blocks that sit together, so line ranges stay sane
want.sort((a, b) => a.start - b.start)

const movedNames = new Set(names)
let body = want.map(d => lines.slice(d.start, d.end + 1).join('\n')).join('\n\n')
// Dynamic `import('./x')` specifiers are relative to the HOST's directory too —
// tsc never sees them (checkJs is off), so rewrite them here or they silently
// resolve against the new file's directory and only fail at build time.
body = body.replace(/(\bimport\(\s*)(['"])(\.[^'"]+)\2/g, (_m, pre, q, spec) => `${pre}${q}${relSpec(targetFile, spec)}${q}`)
const used = identsIn(body)

// external imports this body needs
const needed = new Map()   // spec -> {def, star, named:Set}
for (const id of used) {
  const imp = bySymbol.get(id)
  if (!imp) continue
  const spec = relSpec(targetFile, imp.spec)
  const e = needed.get(spec) || { def: null, star: null, named: new Set() }
  if (imp.kind === 'default') e.def = imp.local
  else if (imp.kind === 'star') e.star = imp.local
  else e.named.add(imp.imported === imp.local ? imp.imported : `${imp.imported} as ${imp.local}`)
  needed.set(spec, e)
}
// host-local symbols this body still needs (already moved out, or staying behind)
const hostLocal = decls.filter(d => !movedNames.has(d.name) && used.has(d.name)).map(d => d.name)

const needsReact = /React\.|<[A-Z]|<\/|use[A-Z]/.test(body)
const out = []
if (/use[A-Z]|<[A-Z]|React\./.test(body)) out.push("'use client'")
const reactHooks = ['useState','useEffect','useRef','useCallback','useMemo'].filter(h => used.has(h))
if (needsReact || reactHooks.length) {
  out.push(`import React${reactHooks.length ? `, { ${reactHooks.join(', ')} }` : ''} from "react";`)
}
for (const [spec, e] of [...needed].sort()) {
  if (spec === 'react') continue
  const parts = []
  if (e.def) parts.push(e.def)
  if (e.star) parts.push(`* as ${e.star}`)
  if (e.named.size) parts.push(`{ ${[...e.named].sort().join(', ')} }`)
  out.push(`import ${parts.join(', ')} from '${spec}';`)
}
if (hostLocal.length) out.push(`/* STILL-IN-HOST: ${hostLocal.join(', ')} */`)
out.push('', body, '')

// export every moved name that is not already exported
const exportsNeeded = want.filter(d => !/^export\s/.test(lines[d.code])).map(d => d.name)
if (exportsNeeded.length) out.push(`export { ${exportsNeeded.join(', ')} };`)

fs.mkdirSync(path.dirname(targetFile), { recursive: true })
fs.writeFileSync(targetFile, out.join('\n'))

// ── rewrite the host: delete moved lines, import them back ──────────────────
const drop = new Set()
want.forEach(d => { for (let i = d.start; i <= d.end; i++) drop.add(i) })
const kept = lines.filter((_, i) => !drop.has(i))
const hostSpec = (() => {
  let r = path.relative(path.dirname(HOST), targetFile).replace(/\.jsx?$/, '')
  return r.startsWith('.') ? r : './' + r
})()
// insert the new import after the last import line of the host
const { lastLine } = parseImports(kept)
kept.splice(lastLine + 1, 0, `import { ${names.join(', ')} } from '${hostSpec}';`)
fs.writeFileSync(HOST, kept.join('\n'))

console.log(`→ ${targetFile}: ${names.length} decls, ${body.split('\n').length} lines`)
if (hostLocal.length) console.log(`  ⚠ still references host-local: ${hostLocal.join(', ')}`)
