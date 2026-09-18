# SSA — notes to self

Short, load-bearing things that are expensive to rediscover. Add to it when
something costs you an hour.

## Runbooks

| task | how |
|---|---|
| Upload a day's / a week's photos, and speed-team compilations + documents | `npm run media:upload` — **read [docs/uploading-a-days-media.md](docs/uploading-a-days-media.md) first** |
| Re-upload cloud logs whose positions were rounded to 2 dp | `npx vite-node scripts/cloud-log-reupload.ts` — use `--mode patch`, never `reduce` |
| Add lidar from Expedition lidar logs to stored phase stats | `npm run lidar:import` |

All of these are dry-run by default and need `--write` to do anything. They read
`.env.local` and must run **outside** Claude Code's Bash sandbox.

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
pages you never touched. Stop the server, `rm -rf .next`, restart.

**`localStore.js` owns the `ssa-db` schema and is the only file allowed to name
a version.** Everything else opens `indexedDB.open('ssa-db')` versionless. A
hardcoded version elsewhere dies the moment `DB_VER` is bumped — that is how
photo import, SailScan and SquashShots were all silently dead for a day
(fixed in `b12a7c6`).

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
