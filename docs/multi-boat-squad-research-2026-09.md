# Multi-boat SSA — becoming the app for Olympic dinghy coaches

Research for the squad product: a coach, 3–8 boats, a RIB, a training day. This
is also the route to the accurate TWD solution — pooling the squad is what takes
wind estimation from 3–5° to ~1° (see §5-L5 of
[dinghy-gps-prior-art-and-twd-2026-09.md](dinghy-gps-prior-art-and-twd-2026-09.md)).

Three things drove the scope: (1) TracTrac access has been requested, (2) we must
ingest every hardware tracker the squad owns, and (3) identity — knowing *which
file is which boat* — turns out to be a harder problem than the analysis.

Sources at the bottom. Where a finding rests on a search summary rather than a
primary page it is marked *(unverified)*.

---

## 1. The headline finding: SSA's session model is boat-first

```sql
CREATE TABLE public.sessions (
  team_id UUID, boat_id UUID, date DATE, ...
  UNIQUE (boat_id, date)
);
```

**A session is one boat on one day, enforced by a uniqueness constraint.** A
squad day with six boats is six unrelated rows. Everything downstream — photos,
videos, tags, `session_phase_stats`, `session_phases`, day notes — hangs off
`session_id`, so the entire app is boat-scoped by construction.

Nothing about that is wrong; it is correct for the N76. But **the squad product
needs a scope above it**, and that scope is where the wind estimator, the
two-boat speed test and the coach's debrief all live.

Two related traps found while reading the schema:

- **`public.events` is the audit log** (`action`, `details`, `ts`) — signup,
  login, upload, quota. It is *not* a regatta. Anyone adding a regatta concept
  called "event" will collide head-on; the campaign/regatta spine lives in
  `timeline_nodes` and the campaign docs instead.
- **`memberships` is already squad-shaped.** It is user × (team, boat) with a
  role, and the schema comment says `boat_id = NULL` means "any boat in the
  team… mainly for coaches who supervise the whole team's boats". The coach
  role already exists and already spans boats. §4b exploits this.

There is **no device or tracker concept anywhere in the schema**. That is the
gap §3 is about.

### The fix: a parent scope, additively

Do *not* make `sessions` multi-boat — that breaks every FK in the app. Add a
parent:

```sql
CREATE TABLE public.training_days (
  id UUID PRIMARY KEY,
  team_id UUID NOT NULL REFERENCES teams(id),
  date DATE NOT NULL,
  venue TEXT, lat DOUBLE PRECISION, lon DOUBLE PRECISION,
  tz_offset_minutes INTEGER,          -- one clock for the whole squad, see §3c
  UNIQUE (team_id, date, venue)
);
ALTER TABLE public.sessions ADD COLUMN training_day_id UUID REFERENCES training_days(id);
```

Per-boat sessions stay exactly as they are and keep their constraint. The new
row is where squad-level things attach: the wind solution, the drill timeline,
the pair tests, the coach-boat track, the debrief. Njord's model corroborates
the shape — Events contain Boats and Races/Trainings, and aggregation happens at
day, event and multi-event scope.

---

## 2. What a coach's day actually is

The app has to fit this, not the other way round. A session is 1.5–4 hours on
the water with a brief before and a debrief after — and crucially **a training
day is not a regatta**. It is a sequence of *drills*, each with a purpose:

| drill | what it is | what the coach wants measured |
|---|---|---|
| **transit** | out to the course and home | nothing — must be excluded from every stat |
| **tuning run** | boats sail upwind together, settings logged | mode, height/speed trade |
| **two-boat speed test** | the core primitive — §2a | gain rate, with the variable isolated |
| **line-up** | 3+ boats abreast, bows even | ranking, and who is high/fast |
| **start practice** | rolling starts, "stopped at 30" | line position, acceleration, timing |
| **short course racing** | the squad races | everything the race product does |

Without drill segmentation, every squad-day average is contaminated by transits
and by boats sailing different drills at the same time. **Segmenting the day into
drills is a prerequisite for every multi-boat statistic**, in the same way that
phase detection is a prerequisite for the wind estimate.

SSA already has most of the machinery: the tagger (`ssa_tag_defs` /
`ssa_tag_events`, with lead/lag times and a controlled vocabulary) and
`session_blocks` / `session_plan_items`. What is missing is that a drill spans
*boats*, so it belongs on `training_days`, not on one session.

### 2a. The two-boat speed test, properly

This is the single most important analysis unit in dinghy coaching, and the
protocol is specific:

- boats start **about two boat-lengths apart, bows even** — that geometry is
  what makes gain and loss measurable at all
- run it **three or four times**; one run proves nothing, because a boat can
  gain from fewer waves, a persistent shift, or simply better steering
- **swap windward and leeward between runs.** This is the control. If the same
  boat is still faster after the swap, the setting is genuinely faster; if the
  advantage follows the *position* rather than the boat, it was the lane
- it only works in **steady wind and waves**; shifts and uneven puffs do not
  affect both boats equally

The measurement the coach wants is therefore **not** "boat A averaged 0.1 kn
more". It is a **gain rate** — boat-lengths (or metres) per minute of forward
and sideways separation — **with the shift removed and the windward/leeward
swap used as the control**, plus an honest statement of whether the difference
survived the runs or is inside the noise.

Prior art for exactly this exists on the yacht side: B&G's **Deckman Two-Boat
module** shares data over a telemetry link to give *wind-shift compensated*
performance comparison between yachts. Nothing in the GPS-only dinghy survey
(§6) does the protocol-aware version. **That is the gap.** Everyone offers
"compare two boats"; nobody offers "here is your speed test, four runs, the
swap accounted for, and the answer is +0.04 kn ± 0.03 — which is not
significant".

### 2b. The coach boat is a data source, not a spectator

The RIB carries the coach, usually the camera, and ideally an anemometer. From
the wind research: a coach-boat wind file is the **highest-quality TWD/TWS
source available to a squad**, and Njord explicitly accepts one. Requirements:
log the RIB's own GPS alongside the wind so its motion can be subtracted, and
treat the result as a first-class `sensor` wind source (§13d of the wind doc).

It is also where the video comes from, which makes the RIB's clock the one that
has to be right (§3c).

---

## 3. The three hard problems are not the analysis

### 3a. Getting data off N devices

| tracker | file / channel | how it comes off | rate | identity in file? |
|---|---|---|---|---|
| **Vakaros Atlas 2 / Edge** | `.vkx` (open spec) **and CSV** — 8 columns, confirmed §3d | **Vakaros Connect app — logs stored on the sailor's phone** | configurable **1 / 2 / 5 / 10 Hz** (GNSS itself 25 Hz); **two rates seen in one session** | **no** — confirmed for CSV too, §3d |
| **Vakaros RaceSense** | live mesh → RC coordinator tablet → cloud | event-run; free live tracking for coaches; RTK cm-level via Swift Navigation Skylark | live | yes (event roster) |
| **Velocitek SpeedPuck / ProStart** | `.vcc` (times, positions, speeds, headings, Doppler-derived) | **Velocitek Control Center** (Win/Mac), exports VCC / GPX / KML; v3.0 uploads straight to ChartedSails | ~1 Hz | not documented |
| **Sailmon MAX / Element / E4** | CSV | Sailmon app / cloud — **CSV download requires the ~$100/yr Gold tier** *(unverified)* | varies | boat profile in the app |
| **TracTrac** | event JSON / KML / binary `.mtb` | API token, organiser grants per-event access | ~1–5 Hz (5 Hz measured in the Formula Kite study) | **yes** — event roster |
| **Garmin / phone / Apple Watch** | GPX / FIT | export or Connect | 1 Hz | no |
| **GoPro 5+** | GPMF telemetry track inside the MP4 | `gopro/gpmf-parser` (official), `gpmf-extract`, `gopro2gpx` | ~1–18 Hz | no |

Two things this table says loudly:

1. **There is no bulk path for the devices a squad actually owns.** Vakaros logs
   live on each sailor's phone; Velocitek needs a desktop app and a cable. The
   coach's real workflow is "collect six files from six people after sailing",
   and that is the workflow to design for — not a cloud API that does not exist.
2. **TracTrac and RaceSense are the exceptions**, because they are *event*
   systems with a roster. They solve identity for free and give the whole fleet.
   That is why TracTrac access matters beyond the yacht product.

### 3b. Identity — the problem nobody's format solves

**The published VKX spec contains no device serial, no device ID, no boat name,
no firmware field and no session-start record.** Record `0x08` (Device
Configuration) carries a config bitfield and the logging rate — its first field
is literally unused. Every record is a Unix-millisecond UTC timestamp and
payload. *A `.vkx` file is anonymous.*

And you cannot recover identity from the data, because on a squad day **every
boat is in the same place at the same time** — position clustering distinguishes
nothing. So identity has to come from outside the file. Three carriers, in order
of how much I'd trust them:

1. **The uploader's identity.** A sailor uploads from their own phone, logged in
   as themselves; `memberships` already says which boat they are on, with
   `valid_from`/`valid_to` bounding it. **Identity comes from auth, not from the
   file.** This is the cleanest answer available and it needs no new concept —
   the table is already there, already time-bounded, already role-aware.
2. **A tracker registry** for the coach-bulk-upload case, following the pattern
   TackTracker uses: *store a permanent ID on the tracker, and use a schedule to
   map that ID to a competitor* rather than writing the competitor's name into
   the device.
   ```sql
   CREATE TABLE trackers (            -- physical devices the squad owns
     id UUID PRIMARY KEY, team_id UUID, kind TEXT,   -- 'vakaros' | 'velocitek' | ...
     label TEXT,                       -- what's on the sticker: "ATLAS-3"
     serial TEXT
   );
   CREATE TABLE tracker_assignments (  -- the schedule
     tracker_id UUID, boat_id UUID, valid_from DATE, valid_to DATE
   );
   ```
   Because the file carries nothing, the *filename* and the folder the coach
   drops become the carrier — so support a documented convention
   (`ATLAS-3_2026-09-19.vkx`) and fall back to asking.
3. **Ask once, remember forever.** On upload, propose an assignment from the
   registry and the last day's mapping, show the six tracks on a map, and let
   the coach confirm or swap in one screen. Never silently guess.

**Design rule:** a track with an unconfirmed boat assignment is *quarantined* —
it can be viewed but contributes to no squad statistic. An unlabelled track
silently averaged into a speed test is worse than a missing one.

### 3d. Confirmed against two real Atlas exports

Two files from one session (Palma, 8 Feb 2026) settle what the vendor pages
could not. Full detail in Part 4 of the TWD doc; the ingestion-relevant points:

- Header is `timestamp,latitude,longitude,sog_kts,cog,hdg_true,heel,trim`.
- **CRLF line endings** — strip `\r` or the last column silently vanishes.
- **Timestamps carry an explicit UTC offset** (`...+0100`), so this format is
  free of the local-wall-time trap. **Take the session date from the first
  timestamp, never from the filename.**
- **No device identity in the file**, exactly as the `.vkx` spec predicted.
- **Filenames are user-typed and unparseable.** The two real files were
  `Miss Behavior 2 2-8-2026.csv` and `Torvar's second  08-02-2026.csv` — the
  same date in `M-D-YYYY` and `DD-MM-YYYY`, one naming a boat and the other a
  session, plus a curly apostrophe and a double space. This is decisive
  evidence for §3b: the filename cannot carry identity reliably, so identity
  must come from auth or the registry.
- **2 Hz and 10 Hz in the same session** — resampling is mandatory.
- Attitude quality is per-device and varies wildly (one unit logged heel
  −173°…+133°). Needs outlier rejection.
- **Per-device compass bias of 5–15°** is real and measurable. Two boats 36 m
  apart disagreed by 10.2° on heading-derived TWD and 0.2° on COG-derived TWD.
  A squad day therefore *calibrates its own devices* — see §4c.

### 3c. Time and sample rate

The good news, and it is genuinely good: **GPS time is UTC and excellent**, so
tracks from six different devices align to well under a second with no
cross-correlation trickery. VKX timestamps are Unix ms UTC. This is the one
alignment problem that solves itself.

Everything else does not:

- **Sample rates differ by an order of magnitude** — 1 Hz Velocitek/GPX against
  10 Hz Vakaros. Every cross-boat comparison needs resampling to a common grid,
  and the grid should be the *coarsest* contributing rate for pair statistics,
  not the finest, or you invent precision.
- **Video and photos do not carry GPS time.** This is SSA's oldest trap, already
  in CLAUDE.md: EXIF `DateTimeOriginal`, log export time columns and Drime's
  `captured_at` are all venue-local wall time even when labelled `Z`. On a squad
  day it gets worse, because now there are six clocks plus the RIB's camera.
  Put `tz_offset_minutes` on `training_days` and derive the boats' from it.
- **GoPro is the useful exception** — its GPMF track carries GPS time *and* a
  position, so a GoPro clip can be aligned to the squad's tracks automatically
  rather than by hand. Worth supporting early for exactly this reason.

---

## 4. What multi-boat actually unlocks

### 4a. The wind, which is the point

From the wind research: RaceQs publishes **3–5° from one boat, ~1° with five**,
and Njord independently reports that TWD inference "is more reliable when
several boats' data are loaded into the same event — the algorithm uses combined
maneuver geometry across all boats to better constrain the solution."

A squad of six is not a nice-to-have for the wind estimator; it is a 3–5×
accuracy multiplier that the coach already owns and is not using. Three
mechanisms stack: independent errors average down, boats tack at different times
so the temporal sampling densifies, and boats spread across the course let you
fit a *spatial* field rather than one number — which answers the question the
coach actually asks, *which side had more?*

**This is why the multi-boat model must come before the wind estimator**, not
after. Build the estimator fleet-scoped from the start.

### 4c. The squad calibrates its own instruments

Measured on two real boats sailing together: heading-derived TWD disagreed by
**10.2°**, COG-derived by **0.2°**. Because boats that close share one wind, the
disagreement *is* the relative compass error — so a squad session yields a
per-device heading offset for free, and the `COG − HDG` decomposition splits it
from leeway (Part 4, §17).

Caveat that determines when this works: a cross-wind current is algebraically
indistinguishable from a compass offset. **Calibrate on non-tidal days, carry
the offsets to tidal venues.** This belongs in the build order as a step, and
the offsets belong on the tracker record, not the session.

### 4b. Everything else the squad scope gives you

- **Pair tests** with the swap as control (§2a)
- **Line-ups** — 3+ boats abreast, ranked, with high/fast decomposed
- **Relative gain/loss** in forward, sideways and VMG directions — Njord's
  existing shape, and the right one
- **Who was where** — the coach's own memory of the day, reconstructed
- **One debrief for the squad** rather than six, with the media already attached

---

## 5. What the competitors do, and what they leave

| | multi-boat support | gap |
|---|---|---|
| **Njord** | Events contain multiple boats; compare any two, relative gain forward/sideways/VMG; aggregate across day / event / multi-event; wind inference improves with more boats | generic pair comparison, not the *speed-test protocol*; no drill model |
| **Vantage** | "Team performance comparison", unlimited teams on the Coach tier | session-tool shape |
| **SailSync** | lineup summaries, coach tiers to 5 boats free | — |
| **RaceAnalyser** | fleet-wide wind from tacks and gybes; Vakaros RaceSense + `.vkx` | race-shaped, not training-shaped |
| **SAP / TracTrac / RaceQs** | whole-fleet by construction | event systems; a squad training day is not an event |
| **Deckman (B&G)** | **Two-Boat module, wind-shift compensated, over a telemetry link** | yacht-only, instrument-only, live rather than post-hoc |

**The unserved product is the training day.** Everyone's multi-boat support is
either *event*-shaped (a regatta with a roster) or *generic*-shaped (compare any
two tracks). Nobody models a coach's day as a sequence of drills with boats in
roles, and nobody does the protocol-aware speed test on GPS-only boats.

---

## 6. Build order

1. **`training_days` parent + `training_day_id` on sessions.** Additive, no
   breakage. Everything else needs it.
2. **Identity before ingestion.** `trackers` + `tracker_assignments`, plus the
   sailor-uploads-as-themselves path that uses `memberships`. Quarantine rule
   from §3b.
3. **Multi-file ingestion**: `.vkx` first (open spec, the dinghy device, and the
   quaternion gives heading), GPX second as the universal fallback, then
   Velocitek `.vcc`, Sailmon CSV, GoPro GPMF. TracTrac when access lands — it
   arrives with identity solved, so it is the cheapest fleet path.
4. **Resample to a common grid** on the training day; coarsest-wins for pair
   stats.
5. **Drill segmentation** on the training day — auto-propose, coach corrects,
   reuse the tagger's vocabulary and lead/lag model.
6. **Fleet-scoped wind estimator** (the wind doc's L1→L5), pooling every boat in
   the day.
7. **Per-device compass calibration** from the crab decomposition, stored on
   `trackers` and applied on ingest (§4c). Cheap, and it makes every
   heading-derived metric comparable across the squad.
8. **Pair speed test** with shift compensation and the windward/leeward swap.
9. **Squad debrief** — one timeline, N boats, media attached.

Note that 1–5 are all plumbing, and 6–9 are the product. The plumbing is most of
the work, which is the usual shape and worth saying out loud before starting.

---

## 7. Open questions

- ~~What does Vakaros Connect actually name its exported files?~~ **Answered**
  (§3d): a user-typed label plus a date in an inconsistent format. The filename
  is unusable as an identity carrier, which settles §3b in favour of
  auth-derived identity.
- **Is there any Vakaros cloud/API for a coach to pull a squad's logs**, or is
  the phone the only exit? Nothing public suggests an API.
- **Does RaceSense expose coach-accessible data outside an event?** Live
  tracking is free at RaceSense events, but a squad training day is not one.
- **Sailmon's Gold-tier gate on CSV download** — verify. If real, it is a
  per-sailor cost the squad has to carry just to get its own data out.
- **How many boats before the spatial wind field beats a single pooled number?**
  RaceQs' ~1° is for five. The kriging/GP step is phase two either way.
- **Is `training_days` the right name** given `public.events` is already taken by
  the audit log and the campaign spine owns regattas? Possibly `squad_days`.

---

## Sources

Devices and formats:
- [vakaros/vkx — VKX telemetry log format](https://github.com/vakaros/vkx) (v1.4 spec; no device-identity fields)
- [Vakaros — Telemetry Logging](https://blog.vakaros.com/blog/telemetry-logging-its-here) · [Making the Most of Vakaros Connect](https://www.vakaros.com/blogs/news/making-the-most-of-vakaros-connect) · [Vakaros Connect (App Store)](https://apps.apple.com/uy/app/vakaros-connect/id1481223437)
- [Vakaros RaceSense](https://www.vakaros.com/pages/racesense) · [RaceSense Live Tracking](https://www.vakaros.com/blogs/news/racesense-live-tracking-bringing-every-race-to-the-world-in-real-time) · [Swift Navigation case study (RTK)](https://www.swiftnav.com/resource/case-study/how-vakaros-and-swift-navigation-are-transforming-competitive-sailing)
- [Velocitek software / Control Center](https://www.velocitek.com/pages/software) · [VCC file extension](https://www.file-extensions.org/vcc-file-extension-velocitek-control-center-data) · [TackTracker: loading Velocitek tracks](https://tacktracker.com/web/kb/velocitek)
- [Sailmon — how to download my data](https://sailmon.com/support-articles/how-to-download-my-data/) · [Njord: Sailmon log files](https://www.sailnjord.com/data-sources/sailmon/)
- [TracTrac](https://www.tractrac.com/) · [How to use the TracTrac system](https://estela.co/how-to-use/tractrac-system) · [Performance Analysis in Olympic Formula Kite sailors using GPS](https://pmc.ncbi.nlm.nih.gov/articles/PMC7830054/) (5 Hz, 60 g device)
- [gopro/gpmf-parser](https://github.com/gopro/gpmf-parser) · [GPMF docs](https://gopro.github.io/gpmf-parser/) · [gpmf-extract](https://github.com/JuanIrache/gpmf-extract) · [gopro2gpx](https://github.com/juanmcasillas/gopro2gpx)

Multi-boat analysis and coaching:
- [Njord — Aggregate Analysis](https://app.sailnjord.com/help/analytics/aggregate.html) · [Njord Analytics](https://www.sailnjord.com/analytics/) · [Njord FAQ](https://app.sailnjord.com/help/analytics/faq.html)
- [B&G Deckman](https://www.bandg.com/en-gb/deckman/) (Two-Boat module, wind-shift compensated)
- [Sailing World — Speed Test Your Way to the Top](https://www.sailingworld.com/how-to/speed-test-your-way-to-the-top/) · [SailZing — Two-Boat Testing: Worth the Effort](https://sailzing.com/two-boat-testing/) · [Snipe — Two Boat Sail Testing](https://www.snipe.org/articles-advices-and-education/technical-experts/boat-handling/two-boat-sail-testing/) · [Yachting World — 5 expert tips for two-boat tuning](https://www.yachtingworld.com/expert-sailing-techniques/5-expert-tips-to-improve-your-two-boat-tuning-162693)
- [Sailing World — Two Easy Speed-Moding Drills](https://www.sailingworld.com/how-to/two-easy-speed-moding-drills/) · [Dave Perry coaching drills](https://hssailing.org/documents/Session-2-Drills-Dave-Perry.pdf)
