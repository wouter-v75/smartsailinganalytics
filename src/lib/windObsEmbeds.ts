// The Davis WeatherLink EMBEDDABLE stations we read, and where they are.
//
// A station's embed feed (weatherlink.com/embeddablePage/summaryData/<uuid>)
// carries its readings and their units but NOT its name or position, so those
// live here. Keyless: no API account, no share, no Pro upgrade, no fee.
//
// HOW TO ADD ONE. A club or harbour that puts its Davis station on its own
// website is already using an embeddable page. Open their weather page, find
// the weatherlink.com/embeddablePage/show/<uuid>/summary URL behind it, and add
// a row below with the station's real position — then `npx vite-node
// scripts/weatherlink-embed-probe.ts` to check it answers and that its units
// are ones we recognise.
//
// POSITION MATTERS MORE THAN THE NAME. These are placed by hand, and a barb at
// the wrong spot is worse than no barb: it says the breeze is somewhere it is
// not. Take the coordinates from the club's own page or a chart, not a guess
// from the town name.
//
// WHY THIS LIST IS SHORT AND OURS. The technique was found by looking at how
// Windycator (weather.ianmillard.com/windycator) covers the Solent — it reads
// two dozen stations this way. Its curated list of stations is its author's own
// work and is deliberately NOT copied. This one grows from stations we verify
// ourselves or that an owner points us at.

import type { EmbedStation } from './windObs'

export const WEATHERLINK_EMBEDS: EmbedStation[] = [
  // Verified 22 Oct 2026: answers JSON, reports in knots, 10-minute means.
  // National Coastwatch Institution lookout on the shore at Lee-on-the-Solent.
  {
    uuid: 'd9d55b9a07e34133a398f6d7ccbcd570',
    name: 'NCI Lee-on-the-Solent',
    lat: 50.80063,
    lon: -1.20316,
  },
]
