#!/usr/bin/env node
// Remove import specifiers that nothing in the file uses.
//
// extract.mjs detects references naively (see identsIn), so a name mentioned
// only in a comment still gets imported. ESLint actually parses the file, so
// let it be the judge rather than another hand-rolled regex.
import { execFileSync } from 'child_process'
import fs from 'fs'

const files = process.argv.slice(2)
if (!files.length) { console.error('usage: prune-imports.mjs <file...>'); process.exit(1) }

let raw
try {
  raw = execFileSync('npx', ['eslint', '--no-eslintrc',
    '--parser-options=ecmaVersion:2022,sourceType:module,ecmaFeatures:{jsx:true}',
    // react/jsx-uses-vars + jsx-uses-react are ESSENTIAL: without them
    // no-unused-vars cannot see that <VideoPlayer/> uses VideoPlayer, and the
    // pruner cheerfully deletes React and every component import in the file.
    '--plugin', 'react',
    '--rule', '{"no-unused-vars":["error",{"args":"none","varsIgnorePattern":"^_"}],"react/jsx-uses-vars":"error","react/jsx-uses-react":"error"}',
    '--env', 'browser,node,es2022', '--no-inline-config', '-f', 'json', ...files,
  ], { encoding: 'utf8', maxBuffer: 1 << 28 })
} catch (e) { raw = e.stdout }             // eslint exits non-zero when it reports

for (const res of JSON.parse(raw)) {
  const lines = fs.readFileSync(res.filePath, 'utf8').split('\n')
  // last line of the import block — only touch specifiers above it
  let lastImport = -1
  lines.forEach((l, i) => { if (/^import\s|^\s*\}\s*from\s|^\s{2}[\w{]/.test(l) && /^import\s/.test(lines[Math.min(i, lines.length - 1)]) || /^import\s/.test(l)) lastImport = Math.max(lastImport, i) })
  const dead = new Set(res.messages
    .filter(m => m.ruleId === 'no-unused-vars' && m.line <= lastImport + 1)
    .map(m => (m.message.match(/^'([^']+)'/) || [])[1]).filter(Boolean))
  if (!dead.size) { console.log(`  ${res.filePath}: nothing to prune`); continue }

  const out = lines.map((l, i) => {
    if (i > lastImport || !/^import\s/.test(l)) return l
    const named = l.match(/\{([^}]*)\}/)
    if (named) {
      const kept = named[1].split(',').map(s => s.trim()).filter(Boolean)
        .filter(sp => !dead.has((sp.split(/\s+as\s+/)[1] || sp).trim()))
      if (!kept.length) {
        const head = l.slice(0, l.indexOf('{')).replace(/import\s*/, '').replace(/,\s*$/, '').trim()
        if (!head || dead.has(head)) return null                      // whole line goes
        return l.replace(/\s*,?\s*\{[^}]*\}/, '')
      }
      l = l.replace(/\{[^}]*\}/, `{ ${kept.join(', ')} }`)
    }
    const def = l.match(/^import\s+(\w+)\s*(,|from)/)
    if (def && dead.has(def[1])) {
      if (def[2] === ',') l = l.replace(/^import\s+\w+\s*,\s*/, 'import ')
      else return null
    }
    return l
  }).filter(l => l !== null)

  fs.writeFileSync(res.filePath, out.join('\n'))
  console.log(`  ${res.filePath}: pruned ${[...dead].join(', ')}`)
}
