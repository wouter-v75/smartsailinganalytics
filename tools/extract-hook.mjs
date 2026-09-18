#!/usr/bin/env node
// Move a set of line ranges out of a component into a custom hook, keeping the
// moved lines byte-identical and rewiring imports.
//
//   extract-hook.mjs <host> <hookPath> <hookName> <a-b,c-d,…> <in:X,Y> <out:Z,W>
//
// Ranges are 1-based inclusive and are taken from the host AS IT IS NOW, so
// re-measure between runs. The hook call replaces the first range in place.
import fs from 'fs'
import path from 'path'

const [,, HOST, HOOK, NAME, RANGES, INS, OUTS] = process.argv
if (!OUTS) { console.error('usage: extract-hook.mjs <host> <hookPath> <hookName> <a-b,…> <in:…> <out:…>'); process.exit(1) }
const blocks = RANGES.split(',').map(r => r.split('-').map(Number)).sort((a,b)=>a[0]-b[0])
const inputs  = INS.replace(/^in:/,'').split(',').filter(Boolean)
const outputs = OUTS.replace(/^out:/,'').split(',').filter(Boolean)

const L = fs.readFileSync(HOST,'utf8').split('\n')
const body = blocks.map(([a,b]) => L.slice(a-1,b).join('\n')).join('\n\n')

function parseImports(lines){
  const by=new Map(); let last=-1
  for(let i=0;i<lines.length;i++){
    if(!/^import\s/.test(lines[i]))continue
    let s=lines[i],j=i
    while(!/from\s+['"][^'"]+['"]\s*;?\s*$/.test(s)&&!/^import\s+['"]/.test(s)&&j+1<lines.length)s+='\n'+lines[++j]
    last=Math.max(last,j)
    const m=s.match(/from\s+['"]([^'"]+)['"]/); if(!m){i=j;continue}
    const spec=m[1], clause=s.slice(s.indexOf('import')+6,s.lastIndexOf('from')).trim()
    const named=clause.match(/\{([\s\S]*)\}/)
    if(named)for(const p of named[1].split(',')){const t=p.trim();if(!t)continue
      const[imp,loc]=t.split(/\s+as\s+/).map(x=>x.trim()); by.set(loc||imp,{spec,kind:'named',imported:imp,local:loc||imp})}
    const head=clause.replace(/\{[\s\S]*\}/,'').replace(/,\s*$/,'').trim()
    if(head&&/^\w+$/.test(head))by.set(head,{spec,kind:'default',local:head})
    i=j
  }
  return {by,last}
}
const {by} = parseImports(L)

const ids = new Set()
for (const m of body.replace(/\.\.\./g,' ').matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)/g)) ids.add(m[1])

const rel = spec => spec.startsWith('.')
  ? (r => r.startsWith('.') ? r : './'+r)(path.relative(path.dirname(HOOK), path.resolve(path.dirname(HOST), spec)))
  : spec
const need = new Map()
for (const id of ids) {
  const im = by.get(id); if (!im) continue
  const spec = rel(im.spec)
  const e = need.get(spec) || {def:null, named:new Set()}
  if (im.kind==='default') e.def = im.local
  else e.named.add(im.imported===im.local ? im.imported : `${im.imported} as ${im.local}`)
  need.set(spec, e)
}

const hooks = ['useState','useEffect','useRef','useCallback','useMemo'].filter(h=>ids.has(h))
const out = [`'use client'`, `import React, { ${hooks.join(', ')} } from "react";`]
for (const [spec,e] of [...need].sort()) {
  if (spec==='react') continue
  const parts = []; if (e.def) parts.push(e.def); if (e.named.size) parts.push(`{ ${[...e.named].sort().join(', ')} }`)
  out.push(`import ${parts.join(', ')} from '${spec}';`)
}
out.push('', `export function ${NAME}({`, `  ${inputs.join(', ')},`, `}) {`, body, '',
  `  return { ${outputs.join(', ')} };`, '}')
fs.mkdirSync(path.dirname(HOOK), {recursive:true})
fs.writeFileSync(HOOK, out.join('\n')+'\n')

const drop = new Set()
for (const [a,b] of blocks) for (let i=a;i<=b;i++) drop.add(i)
const call = [
  `  const {`, `    ${outputs.join(', ')},`, `  } = ${NAME}({`, `    ${inputs.join(', ')},`, `  });`,
].join('\n')
const kept = []
L.forEach((l,i) => { const n=i+1; if (n===blocks[0][0]) kept.push(call); if (!drop.has(n)) kept.push(l) })
let spec = path.relative(path.dirname(HOST), HOOK).replace(/\.jsx?$/,'')
if (!spec.startsWith('.')) spec = './'+spec
kept.splice(parseImports(kept).last+1, 0, `import { ${NAME} } from '${spec}';`)
fs.writeFileSync(HOST, kept.join('\n'))
console.log(`${NAME}: moved ${body.split('\n').length} lines → ${HOOK}; host ${L.length} → ${kept.length}`)
