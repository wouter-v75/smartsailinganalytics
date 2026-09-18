#!/usr/bin/env node
// What does a set of line ranges in a component need from its scope, and what
// does the rest of the component need back? Prints the candidate hook interface.
//   coupling.mjs <file> <a-b,c-d,…>
import fs from 'fs'
const [,, FILE, RANGES] = process.argv
const L = fs.readFileSync(FILE,'utf8').split('\n')
const blocks = RANGES.split(',').map(r=>r.split('-').map(Number))
const inB = n => blocks.some(([a,b]) => n>=a && n<=b)

const declared = new Map()
L.forEach((l,i) => {
  let m
  if ((m = l.match(/^  const\s*\[\s*([\w$]+)\s*,\s*([\w$]+)\s*\]/))) { declared.set(m[1],i+1); declared.set(m[2],i+1) }
  else if ((m = l.match(/^  (?:const|let|var)\s+([\w$]+)/))) declared.set(m[1],i+1)
  else if ((m = l.match(/^  (?:async\s+)?function\s+([\w$]+)/))) declared.set(m[1],i+1)
})
const idsOf = t => { const s=new Set(); for (const m of t.replace(/\.\.\./g,' ').matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)/g)) s.add(m[1]); return s }

const inside  = idsOf(blocks.map(([a,b])=>L.slice(a-1,b).join('\n')).join('\n'))
const outside = idsOf(L.filter((_,i)=>!inB(i+1)).join('\n'))

const needs   = [...declared].filter(([n,ln]) => inside.has(n)  && !inB(ln)).sort((a,b)=>a[1]-b[1])
const exposes = [...declared].filter(([n,ln]) => inB(ln) && outside.has(n)).sort((a,b)=>a[1]-b[1])
const private_= [...declared].filter(([n,ln]) => inB(ln) && !outside.has(n)).length

console.log(`lines moved: ${blocks.reduce((s,[a,b])=>s+b-a+1,0)}`)
console.log(`\nINPUTS (${needs.length}) — declared outside, used inside:`)
console.log('  ' + needs.map(([n,l])=>`${n}@${l}`).join(', '))
console.log(`\nOUTPUTS (${exposes.length}) — declared inside, used outside:`)
console.log('  ' + exposes.map(([n,l])=>`${n}@${l}`).join(', '))
console.log(`\nprivate to the block: ${private_}`)
console.log(`\nin:${needs.map(n=>n[0]).join(',')}`)
console.log(`out:${exposes.map(n=>n[0]).join(',')}`)
