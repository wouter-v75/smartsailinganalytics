#!/usr/bin/env node
// Extracting a hook from a component makes eslint-plugin-react-hooks ask for
// `setX` state setters it used to leave out: it knows a useState setter is
// stable, but cannot tell once that setter arrives as a hook PARAMETER. The
// setters really are stable, so adding them is a no-op at runtime.
//
// Refuses anything that is not a `setSomething` — a genuinely missing
// dependency is a real finding and must not be silently papered over.
import { execFileSync } from 'child_process'
import fs from 'fs'

for (const file of process.argv.slice(2)) {
  let raw
  try {
    raw = execFileSync('npx', ['eslint','--no-eslintrc','--plugin','react-hooks',
      '--parser-options=ecmaVersion:2022,sourceType:module,ecmaFeatures:{jsx:true}',
      '--rule','{"react-hooks/exhaustive-deps":"warn"}','--env','browser,es2022','-f','json', file,
    ], { encoding:'utf8', maxBuffer: 1<<28 })
  } catch (e) { raw = e.stdout }
  const msgs = JSON.parse(raw).flatMap(r => r.messages).filter(m => m.ruleId === 'react-hooks/exhaustive-deps')
  if (!msgs.length) { console.log(`  ${file}: nothing to add`); continue }

  const L = fs.readFileSync(file,'utf8').split('\n')
  for (const m of msgs.sort((a,b) => b.line - a.line)) {
    const names = [...m.message.split('Either')[0].matchAll(/'([\w$]+)'/g)].map(x => x[1])
    const unsafe = names.filter(n => !/^set[A-Z]/.test(n))
    if (unsafe.length) { console.log(`  ${file}:${m.line} NOT a stable setter — leaving for a human: ${unsafe.join(', ')}`); continue }
    for (let i = m.line - 1; i < Math.min(m.line + 200, L.length); i++) {
      const dep = L[i].match(/\},\s*\[([^\]]*)\]\s*\);?\s*$/)
      if (!dep) continue
      const cur = dep[1].split(',').map(s => s.trim()).filter(Boolean)
      const add = names.filter(n => !cur.includes(n))
      if (add.length) {
        L[i] = L[i].replace(`[${dep[1]}]`, '[' + [...cur, ...add].join(', ') + ']')
        console.log(`  ${file}:${i+1} + ${add.join(', ')}`)
      }
      break
    }
  }
  fs.writeFileSync(file, L.join('\n'))
}
