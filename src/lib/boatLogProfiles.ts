// src/lib/boatLogProfiles.ts
// ─────────────────────────────────────────────────────────────────────────────
// Boat log profiles, transcribed — the channel-label aliases that map a
// particular boat's Expedition channel names onto SSA's fields.
//
// The authoritative copy of a boat's profile is on the boat
// (`boats.specs.log_profile`, which `/api/boats` sends to the Upload tab). This
// file is what SEEDS it: `npm run log:profile -- --boat "<name>" --write`
// stores one of these, and the transcription lives in the repo so a new channel
// is a reviewable diff rather than something somebody typed into a form once
// and nobody can audit.
//
// Only channels the DEFAULTS DO NOT ALREADY FIND belong here. Adding a label
// `DEFAULT_ALIASES` knows is harmless but misleading: it reads as though the
// boat needed it.
// ─────────────────────────────────────────────────────────────────────────────

import type { BoatLogProfile } from './logProfile'

export const BOAT_LOG_PROFILES: Record<string, BoatLogProfile> = {
  // ── Baraka GP ─────────────────────────────────────────────────────────────
  // Expedition 12.9.x, `!`-header log (log-v3). Header read 2026-10-08: 352
  // channel labels, of which the built-in defaults already match 44 SSA fields
  // — the whole wind set, position, heel, trim, rudder, forestay, vang, the
  // batten positions, the start burns, air and sea temperature, RH and baro.
  //
  // These three are the only ones its labels alone would lose. Each is a
  // standard Expedition channel name rather than anything Baraka invented, so
  // they are candidates for promotion into DEFAULT_ALIASES once a second boat
  // logs them under the same name.
  'Baraka GP': {
    class: 'Baraka GP',
    note: 'Expedition !-header log (log-v3); header read 2026-10-08',
    aliases: {
      // Rudder toe-in. The N76 export calls the same quantity `ToeIn`.
      toeIn: ['RudderToe'],
      // Forestay + jib-tack load summed by the boat — "Comb HS" on the rig
      // card, logged rather than derived. The N76 calls it `FstyJibTk`.
      fstyJibTk: ['FStay+Tack'],
      // BSP as a percentage of target. The N76 calls it `VsTarg%`.
      vsTargPct: ['TargBsp%'],
    },
  },
}
