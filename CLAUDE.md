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
| Put the LENS on photos already in SSA, so SailTrim stops skipping the depth correction | `npx vite-node scripts/photo-lens-backfill.ts -- "/path/to/originals" --date 2026-09-05 --analysed` — add **`--analysed`** or it asks after 19 rows when only 6 were ever measured; a photo nobody measured needs no focal. With no `--tz`/`--shift` it **measures** the clock shift: each row's nearest original, deltas tallied, and one value most rows agree on IS the shift. Whole hours are not enough — 5 Sept is +2h exactly, 4 Sept is **ten seconds**, because a camera clock set by hand is not on the hour. It only says "these are not the right files" when no shift is shared by even two rows. Matching is on the EXACT second (`--tol 0`): both sides came from the SAME EXIF field, so slack only invents ambiguity — a 2 s window pulled in 34 originals spanning a 109→118 mm zoom. Each frame also reports what it was MEASURED on, by backing the focal out of the range its annotation stored, so the output is a list of frames to REDO. Why it matters: the focal turns a scale into a RANGE, and without one the depth correction and ψ's effective separation are **skipped, not approximated**, while the frame still produces numbers. Its PRESENCE is worth ~10 % on N76's boom; its precision is worth 3.5 % of that, so 114 vs 118 is a few mm and a blank box is ~150. It cannot come from the cloud copy — those are re-exports with the EXIF **stripped**. `media:upload` records it at import now, so this is only for what is already up |
| Upload a day's / a week's photos, and speed-team compilations + documents | `npm run media:upload` — **read [docs/uploading-a-days-media.md](docs/uploading-a-days-media.md) first** |
| Re-upload cloud logs whose positions were rounded to 2 dp | `npx vite-node scripts/cloud-log-reupload.ts` — use `--mode patch`, never `reduce` |
| Add lidar from Expedition lidar logs to stored phase stats | `npm run lidar:import -- "/Users/wouterverbraak/Downloads/oppositetack-log-20260928-104405.1s_clean_LSB.csv"` then `--write`. **The lidar is only in the `_LSB` log variants.** The plain `oppositetack-log-<date>.1s_clean.csv` for the same day has NO lidar columns and is skipped — two of those were imported hopefully before anyone noticed the filename was the whole signal. As of 15 Oct 2026 the LSB days are **26, 28 and 29 Sept**; 26 Sept is Main only, 28 and 29 carry Main AND Jib. It merges onto whatever phases that day already has, so **build the phases first** — and run it AFTER any `stats:backfill`, whose own header warns that a naive recompute wipes the lidar off every day it touches (`carryLidar()` is what stops it). **Validating photographed twist needs a day with BOTH an LSB log and stern shots, and as of 15 Oct only 26 Sept has both** — 27 Sept has three good frames and no lidar log, 28 Sept has Main+Jib lidar and no usable stern shots, 29 Sept has lidar and no photos. So the jib has never been checked against lidar at all. Worth shooting stern shots on any day the lidar is running, square astern if possible (ψ ≈ 0 is where the depth term drops out and the frame is exact) and with the boom or clew in frame, since that is the twist datum |
| Put a boat's rig model (SailTrim dimensions) in `boats.rig_model` | `npx vite-node scripts/rig-model-seed.ts --boat "Northstar 76" --merge --write` — **`--merge` matters**: without it a boat that already has a stored model is "left alone", so a new measurement never lands. With it, each dimension keeps whichever value is better attested (a designer datum beats a tape). Add **`--supersede`** when a stored value claims a provenance it never earned — the tab stamps `designer` on any typed depth — and an EQUAL claim then goes to the curated model in `rigModel.ts`. It resolves ties only; a better-attested stored value still wins, and a stored reference the code has never heard of is kept |
| Add a RIVAL from its IRC certificate, so SailTrim can measure it | `irc-rigmodel.ts -- <cert.pdf> --out <dir>`, then `rig-model-seed.ts --boat <name> --from <dir>/<boat>.rigmodel.json --create --team <team> --write` |
| Say which boats are IN a photo, so frames are searchable by rival | `npx vite-node scripts/subject-boats-backfill.ts --write` (fills `photos.subject_boat_ids` from sail-geometry measurements) |
| Measure a boat's target DEPTHS from several stern shots (kills the ±2500 mm guess) | `npx vite-node scripts/sailtrim-triangulate.ts --boat "Northstar 76" --around 2026-09-27T11:43 --write` — needs 3+ frames seconds apart, each with a measured ψ. A depth is stored on its own UNCERTAINTY, not on the camera's spread: **σ = residual × 1/sin(span)**, because D comes out of the difference between views divided by sin(span), so a millimetre of marking error becomes 7 mm at 8°, 8 mm at 7.2°, 14 mm at 4°. Default bar ±250 mm (`--max-depth-sigma`), which keeps a stored depth's own contribution — d·sinψ — around 26 mm at ψ 6°, and is 6-10× better than the ±1500-2500 mm guesses it replaces. The old 8° bar was never derived: it was the spread of the first set that worked, and that spread was itself ~10 % inflated by the ψ bug, so the set that defined it no longer met it. A span also says nothing about agreement — 9° fitting to 40 mm is worse than 5° fitting to 3 mm. The residual is floored at 5 mm first: three views over two unknowns leave ONE degree of freedom, so a tiny rms is luck as much as accuracy. **Two views are refused outright** — their residual is zero by construction, so the sigma would come out at the floor and claim to be the best number in the table. **ONE TACK and ONE SCALE REFERENCE per solve**: `--around` matches the CLOCK, so a window can straddle a tack, and the stored mm is leeward-positive, which makes two tacks a boat fitted against its own mirror image. It now drops the minority tack and names it. Mixing scale references is not invalid in the same way but a reference whose depth is wrong scales ψ, and the solve absorbs that into the DEPTH — on Baraka, 101 % of her E off P against 88 % off the stern rail, residuals of 7 and 12 mm, and the mixed set worst of all at 74 %. **`--exclude 08:22:06`** drops a frame that cannot be fixed, e.g. one where P's upper black band is out of shot. Read the frame list before the numbers: four separate single-frame faults have spoiled sets here (a mis-marked P scale reading a 110 m range beside neighbours at 33, a ψ solved against the wrong baseline, a frame shot mid-tack, and a boom clicked 600 mm further forward along the spar) and every one of them produced a small residual |
| Put a sailmaker's batten sheet on a mainsail's card | `npx vite-node scripts/batten-card-import.ts --sheet northstar76-im2-2026 --write` — the sheet is transcribed IN the script, so v6 is a diff |
| Trim + compress a day's drone/RIB footage into clips | Upload the event file to SSA, **correct the tags there**, then `npm run clips:day -- YYYY-MM-DD` and `--write`. SSA's starts, top marks, gates and finishes are what it cuts on; the event file supplies only the venue offset, the day's bounds and the tacks/gybes. Add `--practice HH:MM:SS` for a practice gun — its start is cut, the milling about after it is not. |
| Add the race's tacks and gybes afterwards | the same `clips:day` line plus `--turns` — identical windows, so finished clips are skipped and only the manoeuvres encode |
| Upload the clips | Upload tab → **Watch clips**. Point it at `~/clips` once; the folder is remembered, so afterwards it is one click and no file dialog. Clips go up as the encoder finishes each one, overlapping the encode — start it while `clips:day --write` is still running. |
| Review the day's drone footage off the card, and tag what is worth keeping | Tags tab → **Review footage**, point it at `<YYYYMMDD>/Drone` on the SSD once. It plays the camera's own `.LRF` proxies (720p, ~1/30th the bytes, written by the drone at record time), HOLD the track to seek there, **G** drops a Grab video tag on the frame being watched. Chrome/Edge only — Safari has no folder picker. Nothing is copied or uploaded; the cutter still cuts the 4K original |
| Check the timeline's times against the clips' own filenames | `npm run clips:check -- YYYY-MM-DD` — read-only; `--write` corrects the rows. The Videos tab reads this device's local record, the TIMELINE reads the cloud row, and the row is written once at upload and never again — so a clip uploaded before its timestamp probe settled keeps its provisional start (the encode time) for ever. Only clips whose NAME carries a stamp can be checked; for a RIB camera that names files `GX010041.MP4`, re-save the start time in the Videos tab instead, which pushes the local record to the row |
| Show where the drone was filming, on the track | `npm run drone:coverage -- YYYY-MM-DD --write` (or `--all`) with the drive connected. Light green = footage exists, dark green = already cut. Needs the venue offset: the session's stored one, else `--tz <hours>` — **the venue is not always the Med.** `2` is CEST (Porto Cervo, St Tropez); the UK is `1` in BST and `0` in GMT, and a day sailed in the UK with `--tz 2` is shifted an hour |
| Tell SSA what a boat's Expedition calls a channel (log-profile aliases) | `npm run log:profile -- --boat "Baraka GP"` then `--write`. Only for channels the built-in defaults miss OR get wrong — Baraka's header gives 44 fields with no profile at all, and needs five. One of the five CORRECTS a mapping rather than adding one: Baraka's `Forestay` channel is the pin LOAD, so the default alias took it into `forestay` (the length/rake reading) and showed a plausible number of the wrong quantity. Naming `forestay: FStayLen` and `fstyPin: Forestay` together is what separates them, and changing either alone puts the load back under the rake. Add `--against <logfile>` to resolve the aliases against a real header first: an alias that matches nothing is a typo whose only other symptom is a field that stays empty for ever. The transcriptions are in `src/lib/boatLogProfiles.ts`; it stores to `boats.specs.log_profile`, which `/api/boats` sends to the Upload tab |
| Find out why the TAGGER shows no tacks, gybes or roundings for a day | `npm run tagger:check -- --date 2026-10-09 --boat "Baraka GP"` — read-only, no `--write`. Runs the app's own `detectDay()` against the stored log and names which of the four causes it is: no rows, no `twa`/`bsp` (a log-profile gap), TWA logged 0-180 so nothing ever changes sign, or nothing above the 6 kn floor. It also sweeps minBsp, which separates "it was light" from "it is broken". **A race START no longer needs an event file**: `TmToGun`, the log's own countdown, is carried onto the row as `tmGun`, and `utc + tmGun` IS the gun (`src/lib/tagging/gunFromLog.ts`). Every row of the sequence names the same instant, which is what makes it self-verifying — a countdown running the other way, or a timer left frozen, names a different instant every row and is refused rather than guessed at. The derived guns also SHAPE the day: without them segmentDay leaves one undivided "Session" and every tag in it is filed under nothing. The day's two ends and sail changes still need the file. And detections are INVISIBLE until synced: the track and the list draw stored tags, and the Sync bar is what turns one into the other |
| Find out which of a day's log channels went BLANK but kept being logged | `npx vite-node scripts/log-frozen-check.ts --date 2026-10-11` — read-only, nothing to `--write`: the readings were never recorded. **Baraka's instruments blanked for periods** (Wouter, 15 Oct: "we had instrument issues with them going blank"), and a blanked channel keeps being written at its LAST value, which is worse than a gap because everything downstream treats it as a reading. On 11 Oct `twa/tws/awa/aws/twd/vmg` all held exactly 08:21:00's values until 08:26:30 — **five minutes, 152 rows, across a tack** — then twa jumped 100° in one step. **HEEL is the witness**: it is directly sensed off the IMU, not calculated from the masthead, so it keeps going no matter what — it tracked that tack through 26.7°, and it is the only reason anything noticed. So the test is a channel bit-identical for longer than a helmsman holds it WHILE heel proves the boat was moving; the script says `DEAD FEED` when heel moved and `may just be steady` when it did not (bsp = 0 for ten minutes with the boat stopped is not a fault). What it cost: SailTrim takes the TACK from the sign of that stale twa, so 08:26:25 was measured as port when the sails were on starboard — **flipping the sign of every millimetre on the frame**, and then, because the triangulation drops the minority tack, cutting that set from four frames spanning 8.7° to three spanning 4.2°. It also means manoeuvre detection reports a tack where the FEED RESUMED, not where the boat turned, and a phase mean across the span averages one value repeated. Three wrong explanations preceded this (a mid-tack TWA sample, instrument lag, a mis-matched enrichment row); only two sensors that fail independently, side by side, show it |
| Find a tag that was pressed and never appeared | `npm run tags:find -- --slug race-finish --boat "Baraka GP"` — read-only. A tag carries TWO times and nothing keeps them in step: `t0` (when the button was pressed, always right) and `session_date` (**the day the app happened to be showing**). Press a tag on a phone showing yesterday and it is filed under yesterday — stored, correctly timed, never rejected, invisible on the day it belongs to. 0095 refiled a batch of these but only the FUTURE-dated ones, because a tag filed a day EARLY is indistinguishable from a legitimate tag in a session that ran through local midnight. This lists every tag with where it is filed against where its `t0` says it belongs. An empty list means the press never reached the database at all, which is a different problem. A third cause: the tagger OPENS ON TODAY, so tagging an earlier day's race on the phone files it under today at the moment you pressed it — `t0` and `session_date` agree, both are wrong, and no check can tell. Pick the day FIRST, then press on the track, where a press means the moment you are pointing at. A press is now clamped to the day's own data window (`src/lib/tagging/pressAt.ts`), and a day with no log and no video says so before you press |
| Join a day's Expedition log that came off the card in PARTS | `npm run log:merge -- "/Volumes/SSK SSD/<folder>"` then `--write`. Text-level join, bytes preserved; refuses parts whose headers differ |
| Watch an encode | `node scripts/clip-progress.mjs ~/clips --watch` — only after `--write`; it needs the `manifest.json` the encode writes. A finished run renames that to `<YYYYMMDD>.manifest.json`, which is what `--full-res` replays. |
| Work out why a boat that EXISTS does not appear in the app | `npx vite-node scripts/boat-access-check.ts --email <you> --boat "Baraka GP"` — read-only. Every script here uses the service key, which is blind to RLS, so a boat can be present and correct and still invisible. It checks `has_boat_access`'s four conditions one at a time; the usual culprit is a membership scoped to ONE boat, which hides every other boat in the same team and looks entirely normal |
| Find why one target reads differently on two frames of the SAME trim | `npx vite-node scripts/sailtrim-frame-dump.ts --date 2026-10-11 --target boom --why` — read-only. Prints every frame's stored annotation side by side, then takes each millimetre apart into its four inputs: the clicked pixel, the mm/px at that target's depth, the **ψ term** (`d·sinψ·cos heel`) and `1/cos ψ`. The ψ term is the one that bites — on a clew at E it is 107 mm at ψ = 1.1° and **482 mm at ψ = 5.0°**, so an answer of 310 mm can be mostly correction. The `from` column says whether ψ was MEASURED off a marked centreplane baseline or **inferred** from heel foreshortening, which `psiFromHeelShortening` itself documents as indicative only and "not for correcting anything" — an inferred ψ also has no SIDE, so its sign is not pinned by the photograph. Reasoning about two numbers on a screen produced three wrong explanations here before this existed |
| Put the day's TWS/TWA on sail scans filed as "TWS unknown" | `npx vite-node scripts/sailscan-conditions-backfill.ts --boat "Baraka GP"` then `--write`. **TWO causes, not one.** The import leaves `tws_kn`/`twa_deg` NULL on purpose (the report's own wind is wrong on at least one page) for the log to fill — and nothing filled it. AND the scans carry **no `session_id`**, so nothing could find the day's log to fill it from: `enrichScan` derives a 120 s window average perfectly well, but it is PURE and the caller hands it the rows, which in the browser come from IndexedDB — so the panel shows a TWS to whoever imported that day's CSV and "unknown" to everyone else. The same trap as a photo's instrument data. This reads the CLOUD log instead and stores the answer where every reader sees it, setting `session_id` too, which is what lets the app re-derive point-of-sail and sails-up for itself. It **drops rows where the wind feed was DEAD** first (`frozenReport`, heel as the witness): Baraka's instruments dropped out on 10-11 and four of her scans sit at 08:27-08:32, so a window centred there reaches back into a blanked span — 193 rows, and it moves 08:27 from 4.8 to 4.5 kn. Only the WIND channels count for that, and only spans heel says are dead: `bsp`/`vmg` held at exactly 0 for 698 rows on 10-10 is a boat lying in a swell, and dropping those rows threw away a fifth of the day's live wind readings. Uses `computeScanWindow`, the app's own function, so the two cannot drift |
| Import a **Sail Vision** sail-scan report (Baraka's analyst — one A4 page per scan) | `npx vite-node scripts/sailscan-import.ts -- ~/Downloads/<report>.pdf --boat "Baraka GP" --tz Europe/London` then `--write`. A third report format beside North's and thesailcloud's, auto-detected on "Sail Vision analysis report". **Only the SHAPE is imported** — draft, camber, entry, exit, twist per stripe, plus the trimmer's notes. Every instrument on the page (boat speed, wind, upwind angle, runner and tack load) is left out because the log has better, and the report's wind is actively wrong on at least one page ("Boat speed 8.6 kn Wind strength 0.0 kn"); `tws_kn`/`twa_deg` stay NULL so the log fills them. **The stripe heights are not in the report**: Baraka's are 25/50/75 (3-stripe jib) and 25/50/75/87 (4-stripe main) counted FROM THE BOTTOM, applied by convention and flagged `stripe_pos_from_convention`. **Photos come in with the scans** — one per page, image *i* onto scan *i*; that needs `BUNNY_STORAGE_WRITE_KEY` in `.env.local` (the read/write zone password — `BUNNY_STORAGE_API_KEY` is read-only and 401s), and the script says so plainly when it is missing rather than importing silently without pictures. Add **`--backfill-photos`** to attach them to scans ALREADY in the table, matched on image name + capture time, so a set imported before the photos could be read needs no delete-and-redo. `--tz` is load-bearing — "Captured 09:51" is venue-local, Baraka's October days are UK (BST), **not** the Med default. The report's own `Twist (total)` equals the sum of its pairwise twists, so it checks the parse: a dropped stripe row turns a 4-stripe main into a plausible 3-stripe one and ONLY that arithmetic notices. Needs `0100_sail_scans_sailvision.sql` pasted first, or the insert is refused on the `source` CHECK |
| See what a day's debrief ACTUALLY has stored, when the screen and the save disagree | `npx vite-node scripts/debrief-stored.ts --date 2026-10-09 --boat "Baraka GP"` — read-only. Prints length and the last 200 chars per field: ending mid-sentence means it was cut on the way IN, ending cleanly means it saved and the DISPLAY is at fault |
| Re-run a debrief SUMMARY without re-recording or re-transcribing | `npx vite-node scripts/debrief-resummarise.ts -- <transcript.txt> --mode debrief` — the transcript is the expensive part and is usually already complete; only the summary stops short. Calls the same `summariseWithContinuation` the route does, so the two cannot drift |
| See what the sail-media **Lidar column** will show for a day, and why a cell is empty | `npx vite-node scripts/sailmedia-lidar-check.ts --date 2026-09-26` — read-only. A cell needs three things at once (a head reported, the sail was up, the phase fell in a band); this says which one is missing without opening every sail |
| Check a day's photographed sail shape against the LIDAR at the same second | `npx vite-node scripts/sailtrim-vs-lidar.ts --date 2026-09-26` — read-only. The twist DIFFERENCE between two stripes is the check (a common zero cancels). **KND's lidar twist is referenced to the FOOT**, measured not assumed: on 26 Sept 10:25:33 (ψ = 0.00°, where the depth term drops out so the frame is exact) the main's foot-referenced twist at 25 % is −2.26 − (−5.15) = **2.89° against KND's 2.87°**, where the same pair read as angles to the boat's MIDLINE is 5.13° apart — and that gap IS the clew angle. So `angleRows` converts the photo side to the foot basis, from the annotation's `twistFromFootDeg` or its clew chord, and reports which in `basis`. **It also checks that the stored phases are THIS DAY'S.** `session_phase_stats` is keyed by date but holds epochs, and two rows are duplicates of a neighbour — 27 Sept holds 212 phases that are 29 Sept's, 3 Oct holds 276 that are 2 Oct's. Time-of-day printing hides it completely: 27 Sept reads "phases 10:35→13:49, shutters 13:43" and then every frame's nearest phase is 161,509 s away, which is 1.87 days. **Never shift the epochs to line up** — that compares one day's photographs against another day's sailing; rebuild the day or delete the row. A day-mismatch is silent in both directions: a time-matched lookup finds nothing (reads as "the camera was out at the wrong time"), and anything using the day's phases without time-matching gets the other day's conditions. `phase-stats-day-audit.ts` (next row) audits every row for this and repairs it |
| Find which stored frames were measured on a datum that has since MOVED | `npx vite-node scripts/sailtrim-audit.ts --stale` — read-only, no `--write`. It names the frames and the size of the shift; the redo itself is the **Redo N frames** panel the Photos tab offers on that day, which drives SailTrimTab offscreen — the app is the only implementation of the maths. By hand it is Photos → frame → **Edit points…** → Save to photo; note "📐 Analyse sail geometry" is shown only on a frame with NO geometry, so on the very frames that need redoing it is replaced by the card's `Edit points…`. Re-saving needs no re-clicking: `restoreFrom` puts the marks and the choices back and every number is recomputed from them |
| Check that every `session_phase_stats` row holds ITS OWN day's phases | `npx vite-node scripts/phase-stats-day-audit.ts` — read-only; repair with `--repair rebuild --write` (or `--repair delete --write`). A row is keyed by `date`, the phases inside it carry their own epochs, and nothing but this made the two agree. Of 37 stored days **three** held a neighbour's array — 09-06 holding 09-08's 263 phases, 09-27 holding 09-29's 212, 10-03 holding 10-02's 276, each byte-identical to that day's own row, each at **1.0 s** (so from a device's FULL log, not the cloud copy) and each with a `session_id` pointing at the RIGHT day: the route was fine, the browser posted the wrong body. **DUPLICATE vs MIS-STAMPED is the whole point**: a duplicate's day has its own identical row, so the row is redundant and can go; a mis-stamped row is the ONLY copy of that day's phases and is never touched. **Never shift epochs to line up** — the epochs are right, the filing is wrong, and moving them compares one day's measurements against another day's sailing. `--repair rebuild` recomputes the row's own day from the cloud log and only deletes when there is none; it also refuses when the SESSION's log is itself another day's. The 13 **empty** rows it lists are a different thing — a day whose log produced no event-file phases, which blocks nothing |
| Refit the MEDITERRANEAN MOS specs (incl. the regime split) | `npx vite-node scripts/mos-med-refit.ts` then `--write`. Truth is the calibrated masthead wind extracted by the separate **wind-verification** project (`~/Documents/Claude/Projects/Smart Sailing Analytics/wind-verification/obs_<venue>.csv` — 261, 445 and 417 ten-minute vector-averaged bins over 2-3 regattas each), PLUS this season's from `med-obs-phases.ts` (row below), which it picks up automatically from `…/wind-verification-2026/` and `--no-2026` excludes. That first extraction is the expensive part and is reused read-only; nothing writes to that directory. **The 30.0 m in every obs row is extract_obs.py's DEFAULT, not a measurement** — Northstar 72's masthead is 32 m and Northstar 76's is 35 m, and since the forecast is interpolated to `mast × cos heel`, a 30 m label asks the model for less wind than the instrument saw and books the difference as a model deficit. The script corrects a declared 30.0 to 32.0 on the way in and leaves any other value alone; 2026's rows carry 35.0 themselves. It is worth 0.55-1.3 % of wind, and `--eval-at target` measures the alternative (read the model at the app's 30 m instead of the instrument's height): the two agree to 0.03 kn everywhere, so the height is a nuisance parameter and the original design is kept. It reproduces `mos.py` deliberately — the 3×3 lattice over each venue's bbox, bilinear in u/v to the BOAT's position, the heel-reduced evaluation height (30 m × cos heel), the two-stage forms (base `a·x+b`, then the harmonic or the shrunk sector offsets on its residual, k = 8), leave-one-REGATTA-out CV and the 70 % sector-agreement guard — so its numbers are comparable with the JSONs that shipped. **Three things it does NOT reproduce, each for the same reason (fit what will be APPLIED):** the level ladder is the app's per model, not every level Open-Meteo returns; a single-level model is lifted by the app's marine log law, not a 0.11 power law (1.088 against 1.128 at 9 kn — the old fit was handed 3.6 % more wind than the app ever shows); and `cell_selection` is the app's. It enforces the same two bars as `mos-fit.ts`, which the original did not: the gain must hold in EVERY held-out regatta and clear 2 %. **And a THIRD bar as of 28 Oct 2026 — the TAIL** (`src/lib/mosFit`): a form must keep >= 90 % of raw's strong-wind hits and not worsen the top bin's mean error by more than 2 kn, with both levels read off the venue's own distribution by `pickTailBars`, never chosen. It refuses what rmse cannot see. **Read the fixed point, not the slope** — `a < 1` rotates the forecast about `x* = b/(1-a)`, so Sorrento's icon_eu at a 0.76 slope LIFTS its whole range (x* = 20.4 kn, above anything that venue blows) while Porto Cervo's ecmwf at 0.70 takes 3.2 kn off at 20 (x* = 9.2); the script prints both. Where the least-squares pick fails the tail it then tries the same three forms with **the slope pinned at 1** (`c_bias_scale` etc., stored as the ordinary type with `a: 1`, so the app needs no change) and ships that if it clears every bar. `--cell nearest` reproduces the old input for comparison; caches under `$TMPDIR/ssa-mos-med-cache`, and a truncated cache entry is now dropped and re-fetched rather than throwing — that failure once dropped AROME from a whole run with one line of output |
| Build THIS SEASON's Mediterranean obs from Northstar 76's logfiles | `npx vite-node scripts/med-obs-phases.ts` then `--write` — writes `obs_<venue>_2026.csv` to `~/Documents/Claude/Projects/Smart Sailing Analytics/wind-verification-2026/`, which `mos-med-refit.ts` then picks up. Source is the `oppositetack-log-<YYYYMMDD>-*.1s_clean.csv` exports in `~/Downloads` plus the matching `Northstar 76_<yymmdd>_*.ev.xml`. **Only the SELECTED PHASES** — the event file's `<phase>` blocks, 30 s each with their own sailing mode and leg, parsed by the app's own `parseXmlEvents` so the two cannot disagree about what a phase is. Three things it measures rather than assumes: the file clock is **venue-local** (checked by POSITION against the same day's cloud session — 0 m apart at +2 h, 1.5-14 km at every other half-hour, and the event file's own `<utc_offset><log_file hours="2">` agrees); it uses **GWD/GWS, ground wind**, because the forecast is earth-referenced and GWS runs **1.8-2.0 kn above** the water-referenced TWS the cloud copy carries, so the convenient source would have biased this season's block 2 kn light; and directions are **magnetic**, corrected by the event file's own `<magvar>` when it is 1-6 E. A day that exists only as an `_LSB` export is **skipped, not substituted** — that shape has TWD/TWS and no GW. A day needs 3 bins and a bin 120 samples, which is what drops 9 Sept (one selected phase, 122 samples, and the one file whose offset had to come from `<event_file>`). Yield: Porto Cervo 76 bins over 5 days (14 of them over 20 kn, to 26.3) and St Tropez 40 over 3 |
| Fit a venue's MOS wind correction against a lighthouse | `npx vite-node scripts/mos-fit.ts -- --venue viksfjord --station SN29950 --holdouts SN27500,SN30235` then `--write`. Fits at **10 m**, where the truth is, and the spec carries `fit_height_m: 10` so `correctedWind30()` corrects BEFORE lifting to 30 m — a 10 m-fitted intercept applied to a 30 m value is wrong by the lift ratio, largest on exactly the stable mornings where it matters. Leave-one-year-out with a 48 h buffer, because the hourly series' lag-1 is 0.93 and 22,820 hours behave like ~900 independent ones. The ladder is raw → `a·x+b` → + diurnal → + sector → both, chosen by the one-standard-error rule on nEff plus twenty effective samples per parameter. **A model that fails a bar is written as `raw` with the measurement beside it** (`not_shipped`), because the spec outlives the console. `--months` tests a SEASON window as its own arm, held out on the same hours as the year-round arm: it must beat it by more than one standard error to be stored, and as of 27 Oct 2026 nothing does — the thermal signal is real at Gullholmen (1.25 kn swing through a summer day against 0.50 the rest of the year) but **collinear with direction**, so the sector offsets already carry it. Writing the JSON does NOT ship it; it has to be registered in `SPECS` in `mos.js` |
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

## Migrations are DELIVERED as a file, EVERY TIME they are mentioned

A migration is useless as a code block in a chat: it has to be pasted into the
Supabase SQL editor, which means it has to be a file Wouter can open and copy.
Writing it to `supabase/migrations/` is **not** delivering it. Nor is naming it
in a sentence.

**ATTACH THE `.sql` FILE whenever the migration comes up at all.** Not only
when it is written. Also when it is amended, also when a reply says it still
needs running, also when it is one line of a longer summary, also when it was
already sent earlier in the same conversation. If the words "paste 0103" (or
any migration's number) appear in a reply, the file goes with that reply.

The reason is simple and was learned the hard way: a file sent twenty messages
ago is a file Wouter has to scroll back and hunt for, and the whole point of
sending it is that he should not have to. Re-sending costs nothing. Making him
search costs his attention, which is the scarce thing.

So the rule has no exceptions worth remembering. Mention a migration → send the
migration. And say in the caption which one it is, that it is additive and
idempotent, and which migration it follows.

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

**ψ was inflated on CLOSE shots, and the test suite could not see it.**
`solvePsi` reads ψ off the image displacement between two centreplane landmarks
and used to convert that displacement with ONE scale — the mast's. The two
landmarks are at different depths and therefore at different scales: a transom
7.8 m abaft the mast images LARGER, so its share of the displacement is worth
fewer millimetres per pixel. The inflation is exactly the product of the two
ends' depth factors, `R²/((R+d_f)(R+d_a))` — **1.45 at a 25 m range, 1.31 at
33 m, 1.013 at 260 m**. Every ψ test in `sailTrim.test.ts` used `RIG`, which
shoots from **260 m**, where the error is 1.3 % and invisible; Baraka's frames
are at 25–34 m. Because the factor depends on the RANGE, two frames of the same
trim shot from different distances got ψ wrong by different amounts — which is
how a port-tack measurement comes to disagree with a starboard-tack one with the
trim identical on both. Fixed by dividing by `effectiveSeparationMm` instead,
which needs each landmark's own depth (`baselineLandmarkDepths` in
`rigModel.ts`) and falls back to the old answer when they are not supplied.
**Frames measured before this carry the old ψ** and must be re-saved to pick up
the correction. `SAILTRIM_VERSION` is bumped for exactly this reason: it is
stamped on every annotation, and `staleFrames` compares it, so the Photos tab's
redo panel offers the affected frames by itself. It used to look only for a
moved DATUM, so a maths change left it reporting that everything was current.

**A date and a log are two arguments, and nothing used to tie them together.**
`uploadSessionStats(date, rows, xml)` filed whatever log was in memory under
whatever date was on screen. Both callers hold the two apart for a moment:
`loadDate()` sets the new `activeDate` and only THEN awaits the new day's log out
of IndexedDB, and `handleImported()` sets the imported day's log and only then
awaits a `getUser()` before switching the date. `useStoredStats`'s upload effect
keeps `rows` out of its deps (a new array identity every render would re-run it
constantly), so it fires inside those windows with the last day's log — and that
is how three `session_phase_stats` rows came to hold a neighbouring day's phases.
`phasesNotOfDay()` now refuses the contradiction in the client AND in the route
(409, so an old bundle cannot do it either), and the effect depends on
`rows[0].utc` so the refused upload is retried once the right log lands. ANY phase
starting on the date passes, which keeps a session through local midnight legal.

**A PDF's JPEGs are not always in the file as JPEGs.** `pdfImageExtract`
scans the raw bytes for `FF D8 FF … FF D9`, which works because North writes
`/Filter /DCTDecode` and the JPEG sits verbatim. Baraka's Sail Vision reports
write **`/Filter [ /ASCII85Decode /DCTDecode ]`** — the same JPEGs, ASCII85
armoured, so there is **no SOI marker anywhere in the file** and the scan
returned zero. `importScan` swallows an extraction failure on purpose, so twenty
scans imported with no photos and nothing said why. `extractJpegBytesList` now
falls back to `extractAscii85JpegList`, which pairs `/ASCII85Decode` with a
`/DCTDecode` in the same dictionary and checks the decoded bytes really start
`FF D8 FF`. The images come out in document = PAGE order, which is what maps
photo *i* onto scan *i* — and the report burns the source filename into each
picture, so that mapping is checkable by eye.

**Open-Meteo picks a LAND grid cell unless you tell it not to.** `cell_selection`
defaults to `land` — "prefer a cell on land with similar elevation" — and for a
marine point that is the wrong cell, sometimes by miles. Asked for Svenner fyr
(whose own DEM elevation is 12 m, it being a lighthouse islet) ICON-EU returned a
cell **5.7 nm inland** and ECMWF one 4.9 nm inland, and an inland cell's 10 m wind
carries a land roughness no anemometer at sea ever sees. Measured side by side:
icon_eu **16.99 km/h on the land cell against 23.27 on the sea cell**, a 37 %
difference — larger than any bias a MOS fit has ever found here. The 1 km
metno_nordic barely notices (32.60 against 32.17) because it has a sea cell at
the station anyway, which is why this hid for so long. The ELEVATION Open-Meteo
echoes back is the REQUESTED point's, not the cell's, so it reads the same for
every model and tells you nothing; the cell's **distance from the point** is the
only signal, and `mos-fit.ts` prints it every run.

What it cost: every MOS number measured before 27 Oct 2026 was against a land
cell. Gullholmen's headline gain was 16.2 % and is really **10.8 %**; ECMWF's
27.5 % at Svenner is really 3.1 %, because almost all of its "error" was the
inland cell. Worse, the APP had it too, so the forecast on screen was the wrong
place: measured against Northstar 76's own logged 30 m wind over nine days at
Porto Cervo, ECMWF read **5.17 kn low raw and 3.87 kn low even with the venue's
stored correction on top** — and 0.25 kn low on the sea cell with no correction
at all. `cell_selection=sea` is now set in `openMeteo.js` (one constant,
`CELL_SELECTION`, used by all three URL builders), in `tracker-import.ts`, and
in both fitting scripts, and `cellSelection.test.ts` asserts it for every model
in `MODELS`, because a missing query parameter has no symptom.

**A MOS spec belongs to the cell it was fitted against**, so fixing the app
without touching the specs would have been worse than leaving it alone:
`a·x + b` fed a different input is an offset of `a·(x_old − x_new)` applied to a
forecast nobody looked at. And the shipped Med specs had never matched the app
anyway — the **wind-verification** project's fetch asked for
`cell_selection=nearest` while the app asked for nothing and got `land`, so the
mismatch predates the fix. `mos-med-refit.ts` (runbook above) refits all three
venues against `sea`, on the original three years of logfile truth.

What survived: **Sorrento** icon_eu sector 27.5 % and ECMWF diurnal 27.6 % (both
within a point of the figures the original pipeline got, which is the best
available check that the TypeScript reimplementation matches `mos.py`);
**Porto Cervo** ECMWF sector 20.5 %, ARPEGE sector 17.9 %, icon_eu 9.5 %;
**St Tropez** icon_eu 18 %. What did not: AROME at Porto Cervo (1.1 %, and worse
in the held-out 2024 regatta), ARPEGE at Sorrento, and three of St Tropez's
four. **St Tropez's failures are a REGIME split, not noise** — every model's raw
rmse there is 3.0-3.6 kn in the June sea-breeze regatta against 1.9-2.9 in the
October gradient ones. The two regimes are now fitted apart (`--venue st_tropez`
runs it automatically; the split is declared on the venue in the script), and
the answer is mostly negative and worth not re-deriving:

- **June earned nothing.** With one sea-breeze regatta the only available
  blocking is by DAY, and a correction fitted on six days of that week is worse
  on the seventh for every model (AROME 1.48 -> 2.50 kn on 9 June, 3.59 -> 4.26
  on the 10th). The June error is not a stable bias, it is day-to-day. Two of
  the four models' June-only fits did beat the pooled fit — by 0.05 kn — and
  still failed the held-out-day bar.
- **October earned one.** AROME, fitted on the gradient pair alone and held out
  one regatta at a time, gains **5.1 % and holds in both** where the pooled fit
  gained nothing. So AROME is corrected outside May-July and raw inside it.
- **The window is where "raw" gets SAID.** `applyMOS` falls back to
  `spec.models` for any model the window does not name, so a model is left out
  of `seasonal` only when its default came from the POOLED fit, which had to
  hold in every regatta including June — icon_eu improves the June regatta
  3.56 -> 3.09, so it keeps correcting there. AROME's default came from the
  October arm and was never asked to work in June, so the window names it
  explicitly as raw. Getting that fallback backwards would apply October's
  coefficients to a sea breeze.

A second June regatta is the one thing that would make the sea-breeze arm
testable; everything else at that venue is now measured.

**An rmse-optimal MOS slope is a SHRINKAGE, and rmse cannot see what it costs.**
OLS sets `a = cov(x,y)/var(x)`, so a model poorly correlated with the truth gets
pulled toward the climatological mean — and rmse is MINIMISED by exactly that.
It reads as a large gain and it pays for it with the venue's strong wind. Found
at Long Beach (`dc65a29`): ECMWF's corrected forecast warned on **0 of the 130
hours** Angels Gate really had >= 18 kn, where raw warned on 86, and the 24 kn+
bin error went from roughly unbiased to -12.6 kn. None of rmse, the per-block
stationarity bar or the parameter ceiling can detect it, because all three
average over a distribution whose mass is in the middle.

**The slope alone is not the diagnostic.** `a < 1` rotates the forecast about
its fixed point `x* = b/(1 - a)`, so the sign of the change at a strong-wind
threshold T is the sign of `T - x*`. Sorrento's icon_eu has a = 0.76 and
x* = 20.4 kn — above almost everything that venue blows — so it LIFTS the whole
observed range; Porto Cervo's ecmwf has a = 0.70 and x* = 9.2 kn, so at 20 kn it
takes 3.2 kn off. The same slope to one decimal place, opposite behaviour where
it matters. Report `shrinkageAt`, never `a`.

What the Mediterranean audit found, 28 Oct 2026. Of the eight shipped
corrections, **three go to raw**: Porto Cervo's ecmwf kept 27 % of raw's
>= 20 kn hits (10 of 37) and turned a +0.8 kn top-bin error into -4.0, on three
regattas — and a pure offset there is WORSE than raw (4.34 against 4.02), so the
whole 20.5 % was shrinkage and nothing else. Sorrento's two surviving slopes are
the **abstention** case and worth not mistaking for a pass: no model there ever
forecast 16 kn at all (0 of 35), so there is no warning rate to protect, and the
top-bin error is unchanged from raw. The bars and the measurement live in
`src/lib/mosFit` so every venue's refit gets them, with the result pinned in
`src/lib/__tests__/mosTail.test.ts`.

**A target shape must be scoped to the boat it belongs to.**
`northstarConditions()` fell back to Northstar 76's sailmaker sheet for ANY sail
with no override, so Baraka's mainsail scans were drawn against another boat's
reference trim — under a panel and a chart legend both reading "Northstar
target". It now needs the boat name and returns nothing for a boat it is not
sure about: **absent means no target, never Northstar's.** A wrong target is
worse than none, because a target is the thing you trim against.

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
