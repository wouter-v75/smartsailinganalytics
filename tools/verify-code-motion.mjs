import { execFileSync } from 'child_process'
import fs from 'fs'

// Every file this branch added, plus the (now barrel) host.
const changed = execFileSync('git',['diff','--name-only','a8fe353','--','src/'],{encoding:'utf8'})
  .split('\n').filter(Boolean)
const untracked = execFileSync('git',['ls-files','--others','--exclude-standard','src/'],{encoding:'utf8'})
  .split('\n').filter(Boolean)
const news = [...new Set([...changed,...untracked])].filter(f=>/\.jsx?$/.test(f))

// Body = everything that is not an import line, not blank, not 'use client',
// and not an export-list the extraction tool appended.
function body(text){
  const lines = text.split('\n')
  let last=-1
  for(let i=0;i<lines.length;i++){
    if(!/^import\s/.test(lines[i])) continue
    let j=i, s=lines[i]
    while(!/from\s+['"][^'"]+['"]\s*;?\s*$/.test(s) && !/^import\s+['"]/.test(s) && j+1<lines.length) s+='\n'+lines[++j]
    last=Math.max(last,j); i=j
  }
  return lines.slice(last+1)
    .filter(l=>l.trim())
    .filter(l=>!/^'use client'$/.test(l.trim()))
    .filter(l=>!/^export\s*\{[^}]*\}\s*;?$/.test(l.trim()))
    .filter(l=>!/^export\s*\{[^}]*\}\s*from\s*'[^']*'\s*;?$/.test(l.trim()))
    .filter(l=>!/^export\s*\{\s*default\s*\}\s*from/.test(l.trim()))
    .map(l=>l.trimEnd())
}

const origBody = body(execFileSync('git',['show','a8fe353:src/components/SmartSailingAnalytics_UI.jsx'],{encoding:'utf8',maxBuffer:1<<28}))
const newBody  = news.flatMap(f=>body(fs.readFileSync(f,'utf8')))

const count = a => a.reduce((m,l)=>m.set(l,(m.get(l)||0)+1), new Map())
const A=count(origBody), B=count(newBody)
const onlyOrig=[], onlyNew=[]
for(const [l,n] of A){ const d=n-(B.get(l)||0); if(d>0) onlyOrig.push([l,d]) }
for(const [l,n] of B){ const d=n-(A.get(l)||0); if(d>0) onlyNew.push([l,d]) }

console.log(`files compared:        ${news.length}`)
console.log(`original body lines:   ${origBody.length}`)
console.log(`new body lines:        ${newBody.length}`)
console.log(`\nONLY IN ORIGINAL (lost): ${onlyOrig.length}`)
onlyOrig.slice(0,999).forEach(([l,n])=>console.log(`  x${n} ${l.slice(0,120)}`))
console.log(`\nONLY IN NEW (added):     ${onlyNew.length}`)
onlyNew.slice(0,25).forEach(([l,n])=>console.log(`  x${n} ${l.slice(0,120)}`))
