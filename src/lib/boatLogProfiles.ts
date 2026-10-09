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
  // These are the ones its labels alone would get wrong. Each is a standard
  // Expedition channel name rather than anything Baraka invented, so they are
  // candidates for promotion into DEFAULT_ALIASES once a second boat logs them
  // under the same name.
  //
  // NOT mapped, deliberately: `D0 P/S` and `D1 P/S` look like the upper and
  // lower deflector percentages, and are not — Baraka has no deflector sensors
  // (Wouter, 9 Oct 2026). Left out so nobody maps them on the strength of the
  // name and reads a trim setting off a channel that measures nothing.
  'Baraka GP': {
    class: 'Baraka GP',
    note: 'Expedition !-header log (log-v3); header read 2026-10-08',
    aliases: {
      // THE FORESTAY PAIR, and it has to be a pair.
      //
      // Baraka logs both `Forestay` and `FStayLen`, and on this boat `Forestay`
      // is the PIN LOAD (Wouter, 9 Oct 2026). SSA's `forestay` field is the
      // length/rake reading and `fstyPin` is the load — so on the defaults
      // alone, `forestay` matched the column called `Forestay` and took the
      // load, the rake reading went nowhere, and `fstyPin` stayed empty. The
      // reading looked right and was the wrong quantity, which is the worst
      // kind of wrong.
      //
      // Naming both is what separates them: each field tries its boat alias
      // before the defaults, and a column one field has claimed is not offered
      // to the next, so `forestay` takes FStayLen and `Forestay` is left for
      // `fstyPin`. Changing either line alone puts the load back under the
      // rake, so they move together.
      forestay: ['FStayLen'],
      fstyPin: ['Forestay'],
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
