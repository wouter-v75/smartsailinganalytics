# SSA — notes to self

Short, load-bearing things that are expensive to rediscover. Add to it when
something costs you an hour.

## Where things are

| | |
|---|---|
| the repo | `/Users/wouterverbraak/Code/ssa` — `cd` there before any runbook below |
| a day's footage | `/Volumes/SSK SSD/<YYYYMMDD>/Drone` (the card; quote it, the volume name has a space) |
| event + log files | `~/Downloads`, named `Northstar 76_<yymmdd>_<n>.ev.xml` — **a space, not an underscore** |
| clips out | `~/clips` — ONE outbox, not one folder per day. The Upload tab's watcher is pointed at it once; `clips:day` clears whatever the cloud already holds before each encode |

None of this is reachable from Claude Code's sandbox: no `/Volumes`, no
`~/Downloads`, no `ffmpeg`, no database. Anything touching them is handed over
to run on the laptop, and a migration is handed over as a file to paste into the
Supabase SQL editor. Asking where a path is wastes a round trip — it is here.

## Runbooks

| task | how |
|---|---|
| Upload a day's / a week's photos, and speed-team compilations + documents | `npm run media:upload` — **read [docs/uploading-a-days-media.md](docs/uploading-a-days-media.md) first** |
| Re-upload cloud logs whose positions were rounded to 2 dp | `npx vite-node scripts/cloud-log-reupload.ts` — use `--mode patch`, never `reduce` |
| Add lidar from Expedition lidar logs to stored phase stats | `npm run lidar:import` |
| Put a boat's rig model (SailTrim dimensions) in `boats.rig_model` | `npx vite-node scripts/rig-model-seed.ts --boat "Northstar 76" --merge --write` — **`--merge` matters**: without it a boat that already has a stored model is "left alone", so a new measurement never lands. With it, each dimension keeps whichever value is better attested (a designer datum beats a tape). Add **`--supersede`** when a stored value claims a provenance it never earned — the tab stamps `designer` on any typed depth — and an EQUAL claim then goes to the curated model in `rigModel.ts`. It resolves ties only; a better-attested stored value still wins, and a stored reference the code has never heard of is kept |
| Add a RIVAL from its IRC certificate, so SailTrim can measure it | `irc-rigmodel.ts -- <cert.pdf> --out <dir>`, then `rig-model-seed.ts --boat <name> --from <dir>/<boat>.rigmodel.json --create --team <team> --write` |
| Say which boats are IN a photo, so frames are searchable by rival | `npx vite-node scripts/subject-boats-backfill.ts --write` (fills `photos.subject_boat_ids` from sail-geometry measurements) |
| Measure a boat's target DEPTHS from several stern shots (kills the ±2500 mm guess) | `npx vite-node scripts/sailtrim-triangulate.ts --boat "Northstar 76" --around 2026-09-27T11:43 --write` — needs 3+ frames seconds apart spanning 8°+, each with a measured ψ |
| Put a sailmaker's batten sheet on a mainsail's card | `npx vite-node scripts/batten-card-import.ts --sheet northstar76-im2-2026 --write` — the sheet is transcribed IN the script, so v6 is a diff |
| Trim + compress a day's drone/RIB footage into clips | Upload the event file to SSA, **correct the tags there**, then `npm run clips:day -- YYYY-MM-DD` and `--write`. SSA's starts, top marks, gates and finishes are what it cuts on; the event file supplies only the venue offset, the day's bounds and the tacks/gybes. Add `--practice HH:MM:SS` for a practice gun — its start is cut, the milling about after it is not. |
| Add the race's tacks and gybes afterwards | the same `clips:day` line plus `--turns` — identical windows, so finished clips are skipped and only the manoeuvres encode |
| Upload the clips | Upload tab → **Watch clips**. Point it at `~/clips` once; the folder is remembered, so afterwards it is one click and no file dialog. Clips go up as the encoder finishes each one, overlapping the encode — start it while `clips:day --write` is still running. |
| Review the day's drone footage off the card, and tag what is worth keeping | Tags tab → **Review footage**, point it at `<YYYYMMDD>/Drone` on the SSD once. It plays the camera's own `.LRF` proxies (720p, ~1/30th the bytes, written by the drone at record time), HOLD the track to seek there, **G** drops a Grab video tag on the frame being watched. Chrome/Edge only — Safari has no folder picker. Nothing is copied or uploaded; the cutter still cuts the 4K original |
| Check the timeline's times against the clips' own filenames | `npm run clips:check -- YYYY-MM-DD` — read-only; `--write` corrects the rows. The Videos tab reads this device's local record, the TIMELINE reads the cloud row, and the row is written once at upload and never again — so a clip uploaded before its timestamp probe settled keeps its provisional start (the encode time) for ever. Only clips whose NAME carries a stamp can be checked; for a RIB camera that names files `GX010041.MP4`, re-save the start time in the Videos tab instead, which pushes the local record to the row |
| Show where the drone was filming, on the track | `npm run drone:coverage -- YYYY-MM-DD --write` (or `--all`) with the drive connected. Light green = footage exists, dark green = already cut. Needs the venue offset: the session's stored one, else `--tz 2` |
| Tell SSA what a boat's Expedition calls a channel (log-profile aliases) | `npm run log:profile -- --boat "Baraka GP"` then `--write`. Only for channels the built-in defaults miss OR get wrong — Baraka's header gives 44 fields with no profile at all, and needs five. One of the five CORRECTS a mapping rather than adding one: Baraka's `Forestay` channel is the pin LOAD, so the default alias took it into `forestay` (the length/rake reading) and showed a plausible number of the wrong quantity. Naming `forestay: FStayLen` and `fstyPin: Forestay` together is what separates them, and changing either alone puts the load back under the rake. Add `--against <logfile>` to resolve the aliases against a real header first: an alias that matches nothing is a typo whose only other symptom is a field that stays empty for ever. The transcriptions are in `src/lib/boatLogProfiles.ts`; it stores to `boats.specs.log_profile`, which `/api/boats` sends to the Upload tab |
| Join a day's Expedition log that came off the card in PARTS | `npm run log:merge -- "/Volumes/SSK SSD/<folder>"` then `--write`. Text-level join, bytes preserved; refuses parts whose headers differ |
| Watch an encode | `node scripts/clip-progress.mjs ~/clips --watch` — only after `--write`; it needs the `manifest.json` the encode writes. A finished run renames that to `<YYYYMMDD>.manifest.json`, which is what `--full-res` replays. |
| Re-run a debrief SUMMARY without re-recording or re-transcribing | `npx vite-node scripts/debrief-resummarise.ts -- <transcript.txt> --mode debrief` — the transcript is the expensive part and is usually already complete; only the summary stops short. Calls the same `summariseWithContinuation` the route does, so the two cannot drift |
| See what the sail-media **Lidar column** will show for a day, and why a cell is empty | `npx vite-node scripts/sailmedia-lidar-check.ts --date 2026-09-26` — read-only. A cell needs three things at once (a head reported, the sail was up, the phase fell in a band); this says which one is missing without opening every sail |
| Check a day's photographed sail shape against the LIDAR at the same second | `npx vite-node scripts/sailtrim-vs-lidar.ts --date 2026-09-26` — read-only. The twist DIFFERENCE between two stripes is the check (a common zero cancels); a constant offset down the absolute angles with the twists agreeing is a different zero-point, not a different shape |
| Find which stored frames were measured on a datum that has since MOVED | `npx vite-node scripts/sailtrim-audit.ts --stale` — read-only, no `--write`. It names the frames and the size of the shift; the redo itself is Photos → frame → Analyse sail geometry → **Edit points** → Save, because the app is the only implementation of the maths |
| Read a sail's DRAFT % from the same set (run the triangulation first) | `npx vite-node scripts/sailtrim-camber.ts --boat "Northstar 76" --around 2026-09-27T11:43 --sail main --station stripe50 --write` — `--write` puts the answer on every frame in the set |

All of these are dry-run by default and need `--write` to do anything. They read
`.env.local` and must run **outside** Claude Code's Bash sandbox.

The clip script is the same: it wants the card mounted and `ffmpeg` on the path,
so it only ever runs on the laptop. Neither the footage nor `/Volumes` exists
inside the sandbox, and nor does the database — a migration is always handed
over to be pasted into the Supabase SQL editor.

Its selection is worth knowing before you wait on an encode. A start is never
merged with anything; roundings merge with each other; a `--at` moment or a
tack inside one of those is DROPPED rather than cut twice. A window the drone
split a recording through comes out as ONE clip: the pieces are cut per file, as
they must be, then concatenated (`--no-join` keeps them apart, `--join SEC` sets
the seam). `--racing` keeps only what falls between a gun and its `--finish`, and
the window is half-open, so a
windward finish — which Expedition records as one more top-mark rounding — does
not come out as a lap that never happened.

## Hand over the CLI, every time

Nothing in this project runs inside Claude Code's sandbox — no card, no
`ffmpeg`, no database, no browser with the real session in it. So the deliverable
of almost every piece of work is a COMMAND Wouter pastes, not a description of
one. Give it complete and copy-pasteable, with the `cd` in it, whether or not he
asked: "pull and redeploy", "run the dry run", "check the clips" all mean the
same thing — the exact line.

| | |
|---|---|
| pull | `cd /Users/wouterverbraak/Code/ssa && git pull` |
| local dev, after a pull that adds a route | `rm -rf .next && npm run dev` — a running dev server has already built its route manifest and serves stale chunks for a new one |
| production | nothing to run. `vercel.json` has no deploy hook; Vercel builds from `main` on push. Then hard-reload the tab (Cmd-Shift-R) — a warm tab keeps the old client bundle and the fix looks unshipped |
| before pushing | `npm run verify` (tsc → next lint → lint:undef → vitest → next build) |

## Docs are delivered as PDF, never as `.md`

The Markdown in `docs/` is the editable **source**. What gets handed over — to
Wouter, to a coach, to anyone — is **the PDF**. Nobody reads a `.md` in a
terminal, and these docs are mostly wide tables, which are unreadable raw. Write
the Markdown, then always produce and deliver the PDF alongside it:

```bash
npm run docs:pdf docs/<name>.md      # writes docs/<name>.pdf next to it
```

`pandoc`, `weasyprint` and `wkhtmltopdf` are **not installed**; the script goes
Markdown → HTML → PDF through headless Google Chrome. Two traps:

- **It must run outside Claude Code's Bash sandbox.** Seatbelt blocks Chrome's
  ProcessSingleton unix socket — "Failed to create socket directory" — and it
  aborts before rendering anything.
- **Chrome does not exit after `--print-to-pdf`.** The script waits for the file
  to stop growing and then kills it. That kill is load-bearing; without it the
  command hangs until it is timed out and backgrounded.

## Traps that have each cost a day

**Clocks are local wall-time even when something calls them UTC.** The log
exports' time column, EXIF `DateTimeOriginal`, and Drime's `captured_at` (which
is literally suffixed `Z`) are all venue-local. Read any of them as UTC and the
day is shifted by the venue offset — wrong calendar day, wrong log rows, wrong
overlay. Convert explicitly, and say which offset you used.

**`tsc` does not check a single `.jsx` file here** — `allowJs` without
`checkJs`. A clean typecheck says nothing about the components. What bites for
those: `npm run lint:undef` (scope-aware `no-undef`) and `next build` (module
resolution).

**`next build` while `next dev` is running corrupts the dev server.** Both write
`.next/`; every page then 500s with `Cannot find module './NNNN.js'`, including
pages you never touched. Stop the server, `rm -rf .next`, restart. To build
without stopping dev, copy the tree to `$TMPDIR` (excluding `.next` and
`.git`), symlink `node_modules`, and build there — it gets its own `.next`.

**Nothing but `next build` sees the ROUTE TREE, so it has its own test.** A
commit added `api/videos/[id]/share` beside the existing `[videoId]/share`;
tsc, vitest, `next lint` and `lint:undef` were all green and Vercel died in
1.1 s with *"You cannot use different slug names for the same dynamic path"*.
It is a property of the directory layout, not of any file, so no file-based
check can catch it. `src/lib/__tests__/appRoutes.test.ts` now asserts one slug
name per level and one `route.ts` per resolved URL. Two dirs differing only in
slug name resolve to the SAME URL — so even where Next tolerates it, one of
them is silently unreachable.

**`localStore.js` owns the `ssa-db` schema and is the only file allowed to name
a version.** Everything else opens `indexedDB.open('ssa-db')` versionless. A
hardcoded version elsewhere dies the moment `DB_VER` is bumped — that is how
photo import, SailScan and SquashShots were all silently dead for a day
(fixed in `b12a7c6`).

**And `DB_VER` must not MOVE for anything that is not a day's data.** The rule
above is not the whole rule, and reading it as "just don't name a version
elsewhere" cost an evening: `DB_VER` went 5 → 6 to add a `prefs` store, nothing
named a version anywhere, and after a reload no video played at all. Those
versionless opens — SailScanTab, PhotosTab, AdminTab, photoStore, the admin
backfill panel — never listen for `versionchange`, so none of them CLOSES when
an upgrade is needed. IndexedDB then blocks the upgrade until every other
connection goes away, and `openDb()` never resolves: no error, no rejection, a
promise that hangs, and every read behind it waiting for ever. The failure is
not the new feature not working; it is everything else silently stopping.

So a bump is only ever for the day's own stores, and only worth its risk for
them. Anything else — a remembered folder, a UI preference — gets its OWN
database (`ssa-prefs`, `src/lib/prefsStore.js`): separate version, separate
upgrade, nothing else connected to block it, and it closes itself on
`versionchange` rather than becoming the same trap one level down.

**A photo's instrument data only reaches the cloud at import.** Enrichment reads
the day's log from IndexedDB, which only exists on the machine that imported
that day's CSV. `PhotosTab` re-derives the overlay on screen for the viewer, so
a broken photo looks fine to whoever imported it and blank to everyone else.
Use `media:upload`, which reads the log from the cloud instead.

**Re-importing a day's CSV through the Upload tab rewrites its cloud log.** That
is the `reduce` path: on 09-08 it halved 6,895 rows to 3,448 and dropped
`pBurn`/`sBurn`. Never do it to get photo tags — the script exists for that.

## Layout

`SmartSailingAnalytics_UI.jsx` is a 20-line compatibility barrel, not the app.
The shell is `components/SSAApp.jsx`, composing hooks in `components/ssa/`
(`useCloudSync`, `useBatchActions`, `useClipPlayback`, `useClipMetadata`,
`useWorkspaceIdentity`). Components live in `components/{video,sync,charts,mobile}/`
and pure logic in `lib/`. Import from a component's own file, not the barrel.

## Bunny credentials

`BUNNY_STORAGE_API_KEY` is **read-only**; `BUNNY_STORAGE_WRITE_KEY` is the
read/write zone password and the only thing that can upload. Leaving the write
key out of `.env.local` makes the app and scripts structurally read-only against
Bunny, which is a sensible default for a laptop that is not uploading.
`.env.example` lists all ten `BUNNY_*` variables and where each comes from.
