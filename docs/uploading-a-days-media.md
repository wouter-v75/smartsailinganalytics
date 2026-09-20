# Uploading a day's photos and speed-team material

How to get a sailing day's photos, and the speed-team meeting's compilations and
documents, into SSA — on the evening of the day, or for a whole regatta week
afterwards.

**Use the script.** `npm run media:upload`. Read "Why not just drag them into
the Upload tab" below before deciding otherwise; the browser import has a trap
in it that is invisible until someone else opens the app.

---

## The short version

```bash
# one day, or a folder of days — dry run first, it lists what it would do
npm run media:upload -- ~/Downloads/PortoCervo/photos

# then for real
npm run media:upload -- ~/Downloads/PortoCervo/photos --write

# the speed-team meeting's compilations and PDFs, for the MEETING's date
npm run media:upload -- ~/Downloads/20260905/compilations --speed 2026-09-06 --write
```

Photos file themselves by their own EXIF capture time, so one folder can hold a
whole week and each photo still lands on the right day. Re-running is safe: a
photo already in the day (same byte size *and* same capture second) is skipped.

`npm run media:upload -- --help` has every flag.

---

## The two conventions that are easy to get wrong

**1. Speed-team material belongs to the NEXT day's notes.** The speed-team
meeting on the morning of day N+1 discusses day N. So the compilations made
from Saturday's sailing go to Sunday's notes. `--speed` takes the **meeting's**
date, not the sailing date. Name the folders by destination and there is nothing
to remember:

```
speedteam/notes-2026-09-06/     ← made from 5 Sept sailing
```

**2. EXIF has no timezone.** The camera writes `2026-09-10 14:26:41` with no
zone at all. The script reads it as venue-local and converts, defaulting to
**+120** (CEST). At a venue on another offset, pass `--tz`. Get this wrong and
every photo is shifted: the wrong calendar day, and matched against the wrong
log rows. Drime, incidentally, reports the same stamp as `…T14:26:41.000000Z` —
the `Z` is wrong, it is local wall-clock. Same trap as the log exports (see
`docs/` notes on the `Utc` column).

---

## What a speed-team compilation looks like

2–4 mainsail shots side by side, each with an instrument overlay burned in
(time, TWS, SOG, BSP, TargetBoatSpeed, VMG, TWA, AWA, heel, keel, forestay…).
Made in PhotoScape, so they are large: **20–48 MB, up to 170 megapixels**,
portrait because the frames are stacked. In a Drime day folder they are the
files named `01.jpg`, `02.jpg`… — the camera originals are `_MG_*.JPG`,
landscape, 2–6 MB.

They are slow to upload (≈2 min each — the thumbnail alone decodes 170 MP). That
is not a hang; let it run.

---

## Why not just drag them into the Upload tab

You can, **but only on the laptop that imported that day's log CSV.**

The browser import tags each photo with the boat's instruments by reading the
day's log out of **IndexedDB**. `saveLogData` only ever runs when someone
imports a CSV in the Upload tab — opening a day from the cloud does *not* cache
it locally. So on any other machine the log is not there, and every photo lands
with an empty `analysis_data`.

That failure is close to invisible, which is what makes it dangerous:

- the person who imported them **sees the instruments**, because `PhotosTab`
  re-derives them on screen from the loaded log every time it renders;
- `analysis_data` in Supabase stays empty, and that is what the Timeline
  (`DayMedia`, `DayTimeline`) and **every other device** read;
- so the photos look right to exactly one person and blank to the team.

This is what happened to the whole Porto Cervo week and was found on 18 Sept
2026. (A related bug — `PhotosTab.enrichPhoto` setting the flat display fields
but never rebuilding `analysis` — was fixed the same day in `96d5c31`. Even with
that fix, a device without the log locally still has nothing to enrich *from*.)

**The script sidesteps all of it by reading the log from the cloud**, so it does
not matter which machine runs it or how long ago the day was sailed.

---

## What the script does

For each image:

1. `exiftool` → `DateTimeOriginal` (local wall clock)
2. + `--tz` → true UTC → the venue-local calendar day
3. skip if that day already holds a photo with the same bytes and capture second
4. `ffmpeg` → 480 px thumbnail
5. PUT original + thumbnail to Bunny at `sessions/<date>/photos/p_<ts>_<rand>[_thumb].jpg`
6. read `sessions/<date>/log.json` + `events.json` from Bunny, take the nearest
   log row **within 5 minutes** and the sails up at that moment
7. insert the `photos` row with `analysis_data` filled in

With `--speed` it instead PUTs to `campaign/speed/<date>/…` and appends to the
debrief's `documents[]` with `scope: 'speed'` — images as Pictures, everything
else as Documents.

A photo with **no log match** is normal, not a failure: a shot taken at the dock
before the boat sails is outside the day's on-water window and correctly gets no
instruments. The script says so per file.

## Requirements

- `.env.local` with the Supabase URL + service key, and **`BUNNY_STORAGE_WRITE_KEY`**
  — the read/write password from Bunny → Storage → your zone → FTP & API Access.
  `BUNNY_STORAGE_API_KEY` is the read-only one and cannot upload. If the write
  key is absent the app and this script are structurally read-only against
  Bunny, which is a reasonable way to leave a laptop when not uploading.
- `exiftool` and `ffmpeg` on PATH (`brew install exiftool ffmpeg`).
- Run it outside Claude Code's Bash sandbox (it needs the network and `~/Downloads`).

## Checking a day afterwards

```bash
# how many photos the day has, and how many carry instruments
curl -s "$APP/api/teams/$TEAM/boats/$BOAT/photos?date=2026-09-06" | \
  jq '[.[] | select(.analysis_data.inst.tws != null)] | length'
```

Or open the day in the app: the Photos tab shows a banner —
*"No log loaded — instrument data won't be available"* — whenever the overlay
would be empty for the viewer.
