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
  // ── Solent ────────────────────────────────────────────────────────────────
  // All six verified against weatherlink.com on 22 Oct 2026: live, reporting,
  // and in a unit the adapter recognises. THREE OTHERS IN THE SAME AREA WERE
  // REJECTED, which is why each one is checked rather than listed:
  //   Poole YC and Trafalgar Shipyard return an empty shell — no live wind.
  //   (Trafalgar's id is the dashed "bulletin" form, which is not an embed id
  //   at all; National Coastwatch's own directory links are the same dead form.)
  //   Sea View YC last reported TEN DAYS ago.
  // An unverified station is not a gap in the map, it is a silent absence, and
  // nothing would ever have said which.
  //
  // They are `beacon` rather than the default `pws`: a sailing club's station
  // on the shore is what OBS_SOURCES describes as a spot beacon — close to the
  // water and often the only thing on the right beach, but sited for the sport
  // rather than for measurement. `pws` stays for a Davis in a garden we know
  // nothing about.
  //
  // Positions are placed by hand and worth a glance against a chart: a barb in
  // the wrong place says the breeze is somewhere it is not.
  {
    uuid: 'd9d55b9a07e34133a398f6d7ccbcd570',
    name: 'NCI Lee-on-the-Solent', lat: 50.80063, lon: -1.20316, source: 'beacon',
  },
  {
    uuid: 'abbadd952bd14f04ac1ea0435579bd12',
    name: 'NCI Gosport (Portsmouth entrance)', lat: 50.78954, lon: -1.11199, source: 'beacon',
  },
  {
    uuid: '64e7af4654054cd1b0e153209b43213b',
    name: 'NCI Stone Point (Lepe)', lat: 50.78429, lon: -1.35340, source: 'beacon',
  },
  {
    // The one actually at Cowes, on the beach west of the harbour entrance.
    uuid: '9815a6edbd224d2d9128d44b98712940',
    name: 'Gurnard Sailing Club', lat: 50.76035, lon: -1.32501, source: 'beacon',
  },
  {
    // Reports in MPH where the others report knots — the owner's display
    // choice, carried in the payload, which is why nothing here guesses units.
    uuid: 'c47713b04e1a4871b304e418b19f1d02',
    name: 'Hamble River Harbour Master', lat: 50.85282, lon: -1.30721, source: 'beacon',
  },
  {
    uuid: 'bcc60088b3cf4ed68cedcd3445f73169',
    name: 'Royal Motor Yacht Club (Poole)', lat: 50.68900, lon: -1.94657, source: 'beacon',
  },
]
