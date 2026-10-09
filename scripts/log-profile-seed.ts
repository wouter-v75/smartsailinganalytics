// Put a boat's LOG PROFILE on its record: the channel-label aliases that map
// that boat's Expedition channel names onto SSA's fields.
//
//   npx vite-node scripts/log-profile-seed.ts --boat "Baraka GP"
//   …same, plus --write, to actually store it
//   npx vite-node scripts/log-profile-seed.ts --boat "Baraka GP" --clear --write
//
// WHY THIS EXISTS. The log FORMAT is detected from the file, so a boat's log
// parses with no setup at all — 44 of SSA's 77 fields come straight off
// Baraka's header on the built-in defaults. What needs saying per boat is the
// handful of channels its Expedition names differently: `RudderToe` where the
// N76 says `ToeIn`. That belonged on the boat from the day the profile was
// designed (`boats.specs.log_profile`), but the only editor wrote it to one
// device-wide localStorage key, so it had to be typed into every laptop and
// then applied to every other boat that laptop uploaded. Stored here, it
// travels with the boat and arrives with `/api/boats`.
//
// The profiles are transcribed in src/lib/boatLogProfiles.ts, so a new channel
// is a reviewable diff rather than a form somebody filled in once.
//
// Dry run by default: it prints what the aliases would resolve to against the
// boat's real header, and changes nothing. Reads .env.local, and must run
// OUTSIDE Claude Code's Bash sandbox.

import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'
import { retryingFetch, why } from './lib/netFetch'
import {
  effectiveAliases, resolveHeaderIndices, getBoatLogProfile,
  type LogField,
} from '../src/lib/logProfile'
// The transcriptions live in src/lib so the tests can check them against a
// real header without importing this script and its side effects.
import { BOAT_LOG_PROFILES } from '../src/lib/boatLogProfiles'

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const WRITE = process.argv.includes('--write')
const CLEAR = process.argv.includes('--clear')
const BOAT = arg('boat')
/** Optional: a log file (or just its header lines) to resolve the aliases against. */
const AGAINST = arg('against')

const fail: (m: string) => never = (m) => { console.error(`✕ ${m}`); process.exit(1) }

const env = Object.fromEntries(
  readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    .split('\n').filter((l) => /^[A-Z0-9_]+=/.test(l))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')] }),
)
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
  global: { fetch: retryingFetch },
})

/** Header labels from a log file — the `!Boat,…` line, or a plain CSV header. */
function headerLabels(text: string): string[] {
  const first = text.replace(/\r/g, '').split('\n').find((l) => l.trim()) || ''
  const cols = first.replace(/^!/, '').split(',').map((s) => s.trim())
  // `!Boat` / `!boat` is a token, not a channel.
  return /^boat$|^vessel$/i.test(cols[0]) ? cols.slice(1) : cols
}

const main = async () => {
  if (!BOAT) fail(`--boat is required. Transcribed here: ${Object.keys(BOAT_LOG_PROFILES).map((b) => `"${b}"`).join(', ')}`)
  const profile = CLEAR ? {} : BOAT_LOG_PROFILES[BOAT]
  if (!profile) {
    fail(`no profile transcribed for "${BOAT}". Add one to src/lib/boatLogProfiles.ts, `
       + `or pass --clear to remove the stored one.`)
  }

  const { data: boats, error } = await sb.from('boats').select('id, name, team_id, specs').ilike('name', BOAT)
  if (error) fail(`could not read boats: ${why(error)}`)
  if (!boats || !boats.length) fail(`no boat called "${BOAT}"`)
  if (boats.length > 1) fail(`${boats.length} boats are called "${BOAT}" — this script will not guess which`)
  const boat = boats[0]

  const before = getBoatLogProfile(boat.specs)
  const beforeN = Object.keys(before.aliases || {}).length
  console.log(`\n${boat.name}`)
  console.log(`  stored now: ${beforeN ? `${beforeN} alias field(s)` : '— nothing —'}`)
  if (CLEAR) {
    console.log('  after:      — nothing — (--clear)')
  } else {
    for (const [f, labels] of Object.entries(profile.aliases || {})) {
      console.log(`  ${f.padEnd(12)} ← ${(labels || []).join(', ')}`)
    }
  }

  // Resolve against a real header when one is offered: an alias that matches
  // nothing is a typo, and this is the only place it can be caught before the
  // next upload quietly leaves the field empty.
  if (AGAINST) {
    const labels = headerLabels(readFileSync(AGAINST, 'utf8'))
    const base = resolveHeaderIndices(labels, effectiveAliases(null))
    const now = resolveHeaderIndices(labels, effectiveAliases(profile))
    const gained = (Object.keys(now) as LogField[]).filter((f) => base[f] == null)
    console.log(`\n  against ${AGAINST} (${labels.length} columns):`)
    console.log(`    defaults alone match ${Object.keys(base).length} field(s)`)
    if (gained.length) {
      for (const f of gained) console.log(`    + ${f} = ${labels[now[f] as number]}`)
    } else {
      console.log('    + nothing — every alias above already matched, or matched nothing at all')
    }
    for (const [f, ls] of Object.entries(profile.aliases || {})) {
      if (now[f as LogField] == null) console.log(`    ⚠ ${f}: none of [${(ls || []).join(', ')}] is in that header`)
    }
  }

  if (!WRITE) {
    console.log('\n  DRY RUN — nothing written. Add --write.\n')
    return
  }
  // specs is a shared JSONB blob: read, replace the one key, write back.
  const specs = (boat.specs && typeof boat.specs === 'object' ? { ...(boat.specs as object) } : {}) as Record<string, unknown>
  if (CLEAR) delete specs.log_profile
  else specs.log_profile = profile
  const { error: upErr } = await sb.from('boats').update({ specs }).eq('id', boat.id)
  if (upErr) fail(`could not write the profile: ${why(upErr)}`)
  console.log(`\n  ✓ stored on ${boat.name}. It applies to the NEXT log upload with that boat open.\n`)
}

main().catch((e) => fail(why(e)))
