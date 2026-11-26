# The plan: 720p to the team fast, full res by the debrief

**26 Nov 2026 · step by step. Research behind it: `video-upload-research-2026-11.pdf`**

---

## Three corrections first, because they change the plan

**1. Premium is not a one-off fee — but you already have it, so the question is moot.**
You asked to upgrade "if it is a one off fee". It is not: it is a per-library
setting billed **per encoded minute, per output codec** — SD $0.025, HD $0.050,
4K $0.150, in 10-second increments. Since you already have it, there is nothing
to decide and nothing new to spend. Worth knowing what it has cost: your ladder
tops out at 1080p, so every minute bills at the **HD** rate on **one** codec
(`outputCodecs: x264`, confirmed) — about **$53** for the library's 17.7 hours,
of which roughly **$12 went on encoding duplicates**.

**2. JIT encoding is OFF, and it is the single biggest lever.**
`jitEncodingEnabled: false` on every video checked. Bunny's claim for JIT is
**"videos become playable within 10–15 seconds"** — which is the whole of your
"720p ASAP" goal, available as a library setting you are already paying for.

**The catch, and it is a real one:** Bunny's own docs say *"Just-in-Time (JIT)
encoding is only supported by the Bunny player. We cannot guarantee it will work
with 3rd party or custom video players."* SSA plays `playlist.m3u8` through
hls.js inside its own `<video>` element, because that is what carries the
instrument overlays — it cannot use Bunny's player. So JIT might simply not
work here. That is a **test**, not an assumption, and it is step 1.

**3. My "free-tier shared queue" explanation for the 60–120 minute wait was wrong.**
That applies to free encoding; you are on Premium. So the wait is upload time
plus five encoding jobs from a 4K source — not queue contention. Which means
cutting the rungs and shrinking the source attack it directly.

---

## Phase 0 — the decisive test, before writing any code

### Step 1. Turn JIT on and see whether hls.js can play it

Everything downstream branches on this, and it is thirty minutes.

1. In Bunny → Stream → your library → Encoding, enable **Just-in-Time encoding**.
   (CLI equivalent: `bunny stream libraries update <library> --encoding-tier premium --jit`.)
2. Upload one clip through SSA as normal.
3. Within ~15 seconds, check it is playable **in SSA**, not in Bunny's player:

```bash
cd /Users/wouterverbraak/Code/ssa && curl -s -o /dev/null -w "playlist: HTTP %{http_code}  %{size_download} bytes\n" "https://$(grep -E '^BUNNY_CDN_HOSTNAME=' .env.local | sed 's/^[^=]*=//' | tr -d '\r"'"'"'')/REPLACE_WITH_GUID/playlist.m3u8"
```

Then open the clip in the Videos tab and confirm it plays with the overlay.

| Outcome | What it means | Go to |
|---|---|---|
| **Plays in SSA within ~15 s** | the fast path is solved by a setting | Phase 1, then skip step 6 |
| **Playlist 404s, or hls.js errors** | JIT needs Bunny's player; SSA cannot use it | Phase 1, then do step 6 |

Note from the docs: **`EnabledResolutions` is ignored when JIT is on.** So if JIT
works, step 6 becomes unnecessary rather than merely lower priority. Turn JIT
back off if the test fails — it changes nothing for already-encoded videos.

### Step 2. Measure the baseline wait

There is no "ready at" in the API, so this has never been measured. Upload one
clip and poll:

```bash
cd /Users/wouterverbraak/Code/ssa && KEY=$(grep -E '^BUNNY_STREAM_API_KEY=' .env.local | sed 's/^[^=]*=//' | tr -d '\r"'"'"'') && LIB=$(grep -E '^BUNNY_STREAM_LIBRARY_ID=' .env.local | sed 's/^[^=]*=//' | tr -d '\r"'"'"'') && G=REPLACE_WITH_GUID && while :; do printf "%s  " "$(date +%H:%M:%S)"; curl -s -H "AccessKey: $KEY" "https://video.bunnycdn.com/library/$LIB/videos/$G" | python3 -c "import json,sys; d=json.load(sys.stdin); print('status',d['status'],'progress',d.get('encodeProgress'),d.get('availableResolutions') or '')"; sleep 20; done
```

Stop it when `status` reaches 4. That number is what the whole goal is stated in,
and without it nothing below can be shown to have worked.

---

## Phase 1 — remove the duplication

Measured, not estimated: **539 videos, 138.0 GB — 33% of the library.**

| | videos | reclaims | what they are |
|---|---:|---:|---|
| duplicate pairs | ~250 | **68.3 GB** | the same clip under `.MOV` and `.mp4`, two GUIDs, sizes within 0.2% |
| legacy third copies | 104 | **69.7 GB** | `bunny_stream_id` superseded by the proxy/original pair |
| orphan stubs | 191 | 0 GB | status `created`, bytes never arrived, Mar–Sep |

`scripts/stream-dedupe.ts` does all three. **It is dry-run by default** and will
not touch anything a database row points at.

### Step 3. Read the dry run

```bash
cd /Users/wouterverbraak/Code/ssa && npx vite-node scripts/stream-dedupe.ts
```

It prints every GUID it would delete. Two things in that output deserve a look
before you go further:

- **57 duplicate groups are "conflicts" and are kept intact** — both copies are
  referenced by a row. The script deliberately refuses these: two rows pointing
  at two copies of one clip is a data question, and deleting either breaks a
  row. They are not in the 138 GB.
- **1 orphan stub IS referenced** (`eb072599…`, via `bunny_original_stream_id`)
  — a clip the app believes is uploaded when no bytes ever arrived. It needs a
  re-upload, not a delete.

Also visible: `DJI_20250905120235_0001_practise_start.MP4` exists as **nine**
empty stubs. Something retried that upload nine times and left nine video
objects behind.

### Step 4. Delete

```bash
cd /Users/wouterverbraak/Code/ssa && npx vite-node scripts/stream-dedupe.ts --write
```

**Bunny has no trash.** This cannot be undone. The dry run in step 3 is the
list; read it first.

The passes can be taken one at a time if you would rather:
`--orphans-only` (zero risk, no bytes), then `--dupes-only`, then the legacy pass.

### Step 5. Clear the superseded column

**Paste `0107_clear_superseded_stream_ids.sql`** into the Supabase SQL editor
after step 4. Additive and idempotent; it nulls `bunny_stream_id` on the 104
rows whose legacy copy has just been deleted, and leaves alone any row whose
only copy is the legacy one. It raises a notice saying how many rows it touched.

---

## Phase 2 — 720p to the team fast

### Step 6. Ask for two rungs instead of five — ONLY IF JIT FAILED

`src/app/api/stream/create/route.ts:37` asks for five rungs on every video:

```js
enabledResolutions: "240p,360p,480p,720p,1080p"
```

Bunny's docs: *"Each enabled resolution is a separate encoding job."* And
`status: 4` — which our player waits for — only arrives when **all five**
finish. So **to watch 720p the team currently waits for the 1080p rung of a 4K
source to encode.**

The fix is that the ladder is **per upload**, not per library — which is the
finding that dissolves the obstacle I wrongly reported in October. Pass
`enabledResolutions` per call: `"360p,720p"` on the fast path, the full list on
the evening upload. Same library, no dashboard change.

Caveat already noted in your own code (`stream/status/[id]/route.ts:45`):
**`/videos/fetch` accepts no `enabledResolutions`**, so a video brought in by the
storage-first path takes the library default. The fast path therefore wants the
TUS route, or the library default narrowed.

### Step 7. Stop uploading 4K on the fast path

This is the bigger half and it is independent of encoding.

Of the 100 most recent videos, **81 are phone clips at 672 MB per minute** —
against 17 `clips:day` drone cuts at 192 MB/min. A single 4K iPhone clip is
600 MB–1.6 GB; at a 10 Mbps marina uplink that is **21 minutes for one clip**,
and the team then watches the 720p rung.

Transcode on the device before uploading, which is what best-in-class does —
Frame.io's C2C proxies are made by the camera or an encoder, **never in the
cloud**, and Mux's own mobile SDKs pre-process on the handset to hit their
"standard input" spec before upload.

Target spec, from Mux's published standard input plus Cloudflare's published
720p ingest recommendation:

| | |
|---|---|
| resolution | 720p |
| bitrate | **~4.8 Mbps** (Cloudflare's published 720p figure) |
| codec | H.264, closed GOP, keyframes < 20 s |
| container | MP4, faststart |
| framerate | **constant** — a real clip warned `Source video stream has variable framerate 29.50` |

That takes a minute of footage from 672 MB to ~36 MB: **an 18× cut on the
uplink**, before any encoding question.

Note this also corrects SSA's current proxy target of **1.2 Mbps**, which is
about a quarter of Cloudflare's 720p recommendation — on water, wake and spray,
which is the worst content for a low bitrate, not the best.

### Step 8. One uploader, not four

There are four independent ways a clip becomes a Stream video — and that is what
produced 138 GB of duplicates:

| | path | titles from |
|---|---|---|
| 1 | `syncSessionToCloud` → `createStreamUpload(video.name)` (`bunny.js:268`) | `video.name` — `IMG_2059.MOV` |
| 2 | originals queue (`useCloudSync.js:279`) | `video.title` |
| 3 | manual "upload compressed" picker (`SSAApp.jsx:1695`) | `video.title` |
| 4 | `uploadOriginalStorageFirst` → `/api/stream/fetch` (`useBatchActions.js:265`) | `video.title` |

Collapse to one entry point, and give a clip a **content identity** so a second
upload of the same bytes is impossible rather than merely detected. Today
`videos` dedupes on `external_id`, which is the per-device random
`v_${Date.now()}_${Math.random()}` (`localStore.js:270`) — so the same card
imported on two laptops uploads twice by construction.

The fingerprint is nearly free: `extractVideoCreationTime` (`videoProbe.js:283`)
**already reads 1 MB of head and 2 MB of tail** off the drive for every clip, so
`SHA-256(size ‖ head ‖ tail)` is a digest over bytes already in memory.

---

## Phase 3 — full resolution by the debrief

### Step 9. Evening queue, full ladder, full-res source

The pieces exist: `enqueueOriginals`, `goodForOriginals`, and
`processOriginalsQueue` already yielding to the proxy queue
(`useCloudSync.js:230` — *"let proxies finish first"*). Three changes:

1. **Gate on a time window**, not just link quality, so it stops competing with
   the fast path during the day.
2. **Feed it the full-resolution cut.** `clips:day --full-res <manifest>`
   already re-cuts the day's segments at source resolution
   (`select-race-clips.mjs:299`), and `--copy` does it without re-encoding —
   *"lossless and near instant"*. So the archive cut is a replay of a manifest
   you already have.
3. **Request the full ladder** on this upload, now that the ladder is per-upload.

### Step 10. High res on the monitor, inside SSA

Already built: `VideoPlayer.jsx` has a **"◆ HD local"** toggle (coach/admin,
`SSAApp.jsx:1524`) that plays the local file through a blob URL with the gauges
drawing over it, because the overlay is driven by `interpRow(logData.rows,
logUtc)` and does not care where the pixels came from.

It is gated on `video.hasLocalBlob` — the bytes must be in IndexedDB. One extra
branch in the local-source resolver, so it can read from the persisted
`FileSystemDirectoryHandle` (`prefsStore.js:20`) as well, and a 20 GB day never
has to be copied into the browser to be watched at full resolution.

---

## The order, and what each step is worth

| # | Step | Worth | Risk |
|---|---|---|---|
| 1 | **Test JIT with hls.js** | possibly the entire goal, for a setting | none — a toggle |
| 2 | Measure the baseline wait | the number the goal is stated in | none |
| 3 | Dry-run the dedupe | — | none |
| 4 | **Delete 539 videos** | **138 GB, 33% of the library** | permanent; dry run first |
| 5 | Paste 0107 | tidies 104 rows | idempotent |
| 6 | Two rungs, not five *(if JIT failed)* | 5 encoding jobs → 2 | low |
| 7 | **Stop uploading 4K on the fast path** | **18× on the uplink** | low |
| 8 | One uploader + content fingerprint | stops duplicates recurring | medium |
| 9 | Evening queue, full ladder | makes "full res by the debrief" real | low |
| 10 | HD local from a folder handle | high res in SSA without a 20 GB copy | low |

**Steps 1, 4 and 7 are the plan.** One is a toggle, one is a script already
written and dry-run, one is an encode before upload that
`compress-videos.sh` already knows how to do. Steps 6, 8, 9 and 10 are the
engineering that stops it coming back.

## What is still unverified

**That JIT works with hls.js.** Bunny hedges it explicitly. Step 1 settles it,
and the plan branches on the answer rather than assuming one.

**Whether a 720p source asked for two rungs encodes much faster than 4K asked
for five.** Bunny publishes no per-job timings. Step 2's measurement, taken
before and after step 6, is what proves it — and it is the cheapest test of the
most important claim here.
