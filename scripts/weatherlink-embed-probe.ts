// Check every Davis embeddable station in the registry still answers.
//
//   npx vite-node scripts/weatherlink-embed-probe.ts
//   npx vite-node scripts/weatherlink-embed-probe.ts -- --uuid <uuid>   try a new one
//
// Read-only, KEYLESS — nothing to configure and nothing to --write.
//
// WHY. These feeds belong to clubs and harbours, not to us. A station goes
// offline for the winter, an owner switches their console to mph, a page is
// taken down — and the only symptom in the app is a barb that quietly stops
// appearing. This says which, and why.
//
// It also checks the two things the adapter refuses on, so a new station can be
// vetted BEFORE it goes in lib/windObsEmbeds.ts:
//   the UNIT must be one we recognise (the feed states it — see unitLabel), and
//   a 10-minute mean should exist, because the bare "Wind Speed" is an
//   instantaneous sample that jumps about and is not what a model's 10 m wind
//   should be compared against.

import { parseWeatherLinkEmbed } from '../src/lib/windObs'
import { WEATHERLINK_EMBEDS } from '../src/lib/windObsEmbeds'

const argv = process.argv.slice(2)
const flag = (n: string) => {
  const i = argv.indexOf(`--${n}`)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined
}

const UA = 'SmartSailingAnalytics/1.0 (+https://ssa.wvsailing.co.uk)'
const one = flag('uuid')
const list = one
  ? [{ uuid: one, name: `(trial) ${one.slice(0, 8)}`, lat: 0, lon: 0 }]
  : WEATHERLINK_EMBEDS

async function main() {
  if (!list.length) {
    console.log('No stations in lib/windObsEmbeds.ts yet. Add one, or pass --uuid <uuid>.')
    return
  }
  console.log(`${list.length} station(s)\n`)

  for (const st of list) {
    const url = `https://www.weatherlink.com/embeddablePage/summaryData/${encodeURIComponent(st.uuid)}`
    let payload: unknown
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA } })
      if (!r.ok) { console.log(`  ${st.name.padEnd(28)} HTTP ${r.status} — page removed, or the uuid is wrong`); continue }
      payload = await r.json()
    } catch (e) {
      console.log(`  ${st.name.padEnd(28)} network error: ${(e as Error).message}`); continue
    }

    const vals = Array.isArray((payload as { currConditionValues?: unknown })?.currConditionValues)
      ? (payload as { currConditionValues: Array<Record<string, unknown>> }).currConditionValues : []
    const wind = vals.filter((v) => /wind/i.test(String(v.sensorDataName)))
    const o = parseWeatherLinkEmbed(payload, st)

    if (o) {
      const age = (Date.now() - Date.parse(o.t)) / 60000
      console.log(`  ${st.name.padEnd(28)} ${o.twsKn.toFixed(1).padStart(5)} kn from ` +
        `${String(o.twdDeg ?? '--').padStart(3)}deg` +
        `${o.gustKn != null ? `  gust ${o.gustKn.toFixed(1)}` : '           '}  ${age.toFixed(0).padStart(4)} min old`)
      if (age > 180) console.log('       !! over 3 h old — the station may be down for the season.')
      if (one) console.log(`       position is 0,0 for a trial: put the REAL lat/lon in windObsEmbeds.ts`)
    } else {
      console.log(`  ${st.name.padEnd(28)} PARSED NOTHING`)
      if (!wind.length) console.log('       no wind sensor on this station at all.')
      else {
        console.log('       wind entries it DOES publish:')
        for (const v of wind) console.log(`         ${String(v.sensorDataName).padEnd(26)} ${String(v.value)}  [${String(v.unitLabel)}]`)
        console.log('       If a unit above is not knots/mph/m-s/km-h, the adapter refuses it')
        console.log('       on purpose rather than guessing — add it to UNIT_TO_KN if it is real.')
      }
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
