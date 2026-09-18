#!/usr/bin/env node
// Prove a hook extraction moved lines rather than rewrote them.
//   verify-hook-move.mjs <gitref> <hostPath> <hookPath> <a-b,c-d,…>
import { execFileSync } from 'child_process'
import fs from 'fs'
const [,, REF, HOST, HOOK, RANGES] = process.argv
const before = execFileSync('git',['show',`${REF}:${HOST}`],{encoding:'utf8',maxBuffer:1<<28}).split('\n')
const moved = RANGES.split(',').map(r=>r.split('-').map(Number))
  .map(([a,b]) => before.slice(a-1,b).join('\n')).join('\n\n')
const hook = fs.readFileSync(HOOK,'utf8')
const ok = hook.includes(moved)
console.log(`moved ${moved.split('\n').length} lines — verbatim in ${HOOK}: ${ok}`)
if (!ok) {
  const h = hook.split('\n'), m = moved.split('\n')
  const s = h.findIndex(l => l === m[0])
  for (let i = 0; i < m.length; i++) if (h[s+i] !== m[i]) {
    console.log(`first difference at moved line ${i+1}:\n  was: ${JSON.stringify(m[i])}\n  now: ${JSON.stringify(h[s+i])}`)
    break
  }
  process.exit(1)
}
