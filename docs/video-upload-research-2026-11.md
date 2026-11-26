# Why the video upload is slow, measured — and what to do

**26 Nov 2026 · research + proposal, nothing changed yet**

Goal: **720p on the team's phones as soon as possible after sailing; full
resolution by the evening debrief, for a monitor.**

This replaces the October documents' guesswork. Those made two estimates I had
to retract. This time the Bunny Stream library was **audited directly** — 930
videos — so the numbers below are measurements, not arithmetic from my reading
of the code. The one remaining assumption is named in §7.

---

## 1. The audit: what is actually in the library

Read from `GET /library/620505/videos`, all 10 pages, 26 Nov 2026.

| | |
|---|---|
| videos | **930** — 738 `ready`, **192 stuck at `created`** |
| storage | **416.5 GB** |
| footage | **17.7 hours** |
| | **→ 23.6 GB of Bunny Stream storage per hour of sailing footage** |
| mean | 448 MB per video |

Three separate kinds of waste, all measured:

### 1a. 27% of the library is a duplicate second copy — 113 GB

622 distinct clip names; **136 of them (22%) exist more than once**, and every
single duplicate pair is a `.mov` / `.mp4` pair with **two distinct GUIDs**:

| stem | copy 1 | copy 2 |
|---|---|---|
| `IMG_1920` | `.MOV` 1645 MB | `.mp4` 1644 MB |
| `IMG_2042` | `.MOV` 658 MB | `.mp4` 657 MB |
| `IMG_2029` | `.MOV` 687 MB | `.mp4` 687 MB |
| `IMG_2059` | `.MOV` 604 MB | `.mp4` 603 MB |

Same duration, same 3840×2160 source, sizes within 0.2%. **It is the same
footage, uploaded twice, encoded twice, and stored twice.** Across the library
the redundant copies hold **113.1 GB — 27% of all storage** — and 3.1 hours of
footage went up the uplink twice.

This is the duplication, and it is worse than the "two ladders by design" I
described in October. That was a proxy and an original, deliberately. This is
one 4K file sent twice.

### 1b. 192 videos (21%) where the bytes never arrived

Status `created`, zero dimensions, zero storage, dated **19 Mar → 27 Sep 2026**.
A Stream video object was created and the upload never completed. No
`transcodingMessages`, so nothing failed in encoding — the TUS upload was
abandoned.

They cost no storage, but they say something important: **TUS uploads are
abandoned often enough to leave 192 orphans over six months.** That is the
resumability story not working.

### 1c. Most of what goes up is 4K, not 720p

| source height | videos | storage |
|---|---:|---:|
| 2160p (4K) | 273 | 143.0 GB |
| 1512p | 44 | 37.4 GB |
| 1080p | 89 | 148.5 GB |
| 720p | 331 | 85.9 GB |
| 6016p | 1 | 1.6 GB |

So **318 of 738 ready videos were uploaded at 1512p or above.** The phone route
dominates: of the 100 most recent videos, 81 are `IMG_*`/`VID_*` at **672 MB per
minute of footage**, against 17 `clips:day` drone cuts at 192 MB/min.

I had assumed `clips:day`'s 720p output was the main thing being uploaded. It is
not — iPhone 4K is.

---

## 2. Why it takes long: four causes, compounding

### 2a. Bunny's free encoding tier is a shared queue

From Bunny's own encoding docs: free-tier encoding "may be briefly delayed
during peak periods," and under heavy demand **"may take anywhere from several
hours to multiple days."**

This is the real explanation for the 60–120 minute wait that the storage-first
work was built to route around. It is not bandwidth and it is not a fixed
property of Stream — it is **queue depth on the free tier**, and the way to beat
it is to ask for less encoding work.

### 2b. Every upload asks for five encoding jobs

`src/app/api/stream/create/route.ts:37`:

```js
body: JSON.stringify({ title: fileName, enabledResolutions: "240p,360p,480p,720p,1080p" })
```

Bunny's docs: **"Each enabled resolution is a separate encoding job."** So every
video queues five jobs, and `status: 4` — which is what our player waits for
(`stream/status/[id]/route.ts`) — is only reached when **all five** finish.

So for the team to watch **720p**, they currently wait for the **1080p rung of a
4K source** to finish encoding, in a shared queue, behind everyone else's work.

With duplicates, a single clip can be ten encoding jobs.

### 2c. The uplink carries 4K when 720p is what gets watched

A 4K iPhone clip is 600 MB–1.6 GB. At a marina uplink of 10 Mbps a 1.6 GB file
is **21 minutes**, for one clip. The team then watches the 720p rung.

### 2d. Nothing dedupes on content

There are **four** independent ways a clip becomes a Bunny Stream video:

| | path | titles with |
|---|---|---|
| 1 | `syncSessionToCloud` → `createStreamUpload(video.name)` (`bunny.js:268`) | the real filename — `IMG_2059.MOV` |
| 2 | originals queue → `createStreamUpload(label)` (`useCloudSync.js:279`) | `video.title` |
| 3 | manual "upload compressed" picker (`SSAApp.jsx:1695`) | `video.title` |
| 4 | `uploadOriginalStorageFirst` → `/api/stream/fetch` (`useBatchActions.js:265`) | `video.title` |

Each has its own idea of "already uploaded", and the Supabase `videos` row
dedupes on `external_id`, which is the **per-device random id**
`v_${Date.now()}_${Math.random()}` (`localStore.js:270`). **Nothing compares the
bytes, anywhere.**

That the pairs are `.MOV` + `.mp4` says two of these four paths ran for the same
clip — one titling from `video.name`, one from `video.title`. Which exact pair
is inferred; that 38 of 62 recent clips went up twice is measured.

---

## 3. How Bunny actually tapers the ladder

Researched against Bunny's docs, then **confirmed against the library's own
data**, which is better evidence than the docs provide.

### It does not upscale — confirmed

October left this as the open question the whole design rested on. The library
answers it:

| source | rungs Bunny actually built |
|---|---|
| 720p | `240p, 360p, 480p, 720p` |
| 1080p | `240p, 360p, 480p, 720p, 1080p` |
| 2160p | `240p, 360p, 480p, 720p, 1080p` — capped at what was requested |

So the comment in `stream/create` — *"Bunny only produces renditions up to the
source resolution"* — **is correct**, and the docs simply never said so. Credit
where due; it is now verified rather than assumed.

### The ladder is per-UPLOAD, not just per-library

This is the finding that dissolves October's biggest obstacle. I wrote then that
resolutions "need to be configured before a video is uploaded" and concluded a
video's ladder could never be narrowed for a fast path without a second library.

**Wrong.** Both entry points take the ladder per video:

- `POST /library/{id}/videos` accepts `enabledResolutions` in the body — which is
  how our own code already sets five rungs;
- the **TUS upload accepts `EnabledResolutions` and `JitEnabled` as headers** on
  the request that completes the upload.

So the fast path can request **`360p,720p`** and the evening path the full
ladder, in the same library, with no dashboard change and no second library.

One documented gap: **`/videos/fetch` takes no `enabledResolutions`** — a video
brought in by the storage-first path gets the library default. Our own code
already notes this (`stream/status/[id]/route.ts:45`). It matters for which path
the fast upload should use.

### Other levers, with their costs

| | |
|---|---|
| **JIT encoding** | **"videos become playable within 10–15 seconds"** — but Premium only, Bunny-player only, and `jitEncodingEnabled` is `false` on all 930 videos today |
| **Premium encoding** | SD $0.025/min, **HD $0.050/min**, 4K $0.150/min, per output codec, billed in 10-second increments |
| **MP4 fallback** | already **on** (`hasMP4Fallback: true` on 738 videos) → `https://{pull}.b-cdn.net/{guid}/play_720p.mp4` exists without the storage-first dance |
| **Early Play** | plays the source before the ladder finishes — but "will expose the original file to the public", which contradicts the Block-Direct-URL + token-auth posture this library runs |

**17.7 h of footage on HD premium encoding would be about $53** at
$0.050/min — one-off, not recurring. That is worth knowing before dismissing
Premium as the answer to 2a.

---

## 4. What best-in-class does

Researched across Frame.io, Mux, Cloudflare Stream, Veo, Spiideo and Hudl.

### Frame.io Camera to Cloud — the closest match to the requirement

- **The proxy is made on the device**, by the camera or an external encoder
  (Canon C80/C400, Teradek, Atomos, Accsoon). **Never in the cloud.** Frame.io's
  own docs: internal camera proxies "can upload faster than the camera original
  files."
- **The original is not uploaded later at all.** The editor relinks or conforms
  to the camera originals "on your storage."

Two things follow for SSA. First, **transcode-before-upload is the industry
answer, not a compromise** — which is what `clips:day` already does and what the
phone route does not. Second, **an original that stays local is a legitimate
best-in-class design**, not a corner cut.

### Mux — "standard input" skips a whole transcode

Mux documents an input spec that avoids their mezzanine pass: **H.264/HEVC, ≤1080p,
average bitrate under 8 Mbps, closed GOP, keyframe interval under 20 s.**
Non-standard input "must perform an initial encoding operation… slower to
ingest." Their own sample encode is `-b:v 7000k -maxrate 16000k` at 1080p.

Their **mobile SDKs pre-process on the device** to produce standard input before
uploading — documented transcode-then-upload, exactly the shape proposed below.

Also: **"The HLS version of a video will also be ready sooner than the MP4
versions, if time-to-ready is important."**

### Cloudflare Stream — playable before fully encoded

Videos in `ready` "are playable but may still be encoding certain quality levels
until the `pctComplete` reaches 100." The clearest documented
playable-before-complete model, and the thing Bunny only offers as JIT or Early
Play.

**Their published ingest recommendations are a useful external reference for the
proxy bitrate question:** 1080p **8 Mbps**, **720p 4.8 Mbps**, 480p 2.4 Mbps,
360p 1 Mbps.

Against that, SSA's proxy target of **1.2 Mbps at 720p is about a quarter of
what Cloudflare recommends for 720p** — and SSA's footage is water, wake and
spray, which is the worst case for a low bitrate, not the best.

### The sports platforms are behind, not ahead

Veo, Spiideo and Hudl are all either upload-after-recording or record-in-the-cloud.
**None documents a proxy-first upload**, and none publishes a time-to-viewable
figure that stands up. Their marketing says "ready by the final whistle"; the
docs do not say how.

So the reference class for this problem is film/TV post (Frame.io) and the video
APIs — not the sports-video field. SSA's proxy-first instinct is already ahead of
that field; it is the execution that is behind.

### What nobody publishes

No vendor publishes a proxy resolution/codec/bitrate for a review tier, and none
publishes guidance on where low bitrates break down for high-motion water. The
Cloudflare ingest table is the nearest published anchor.

---

## 5. The proposal

### 5a. One upload contract, two phases

```
  AFTER SAILING                           EVENING
  ┌──────────────────────────┐            ┌────────────────────────────┐
  │ 720p upload copy          │            │ full-resolution cut        │
  │ ~4.8 Mbps, H.264,         │            │ as shot                    │
  │ closed GOP, faststart     │            │                            │
  └────────────┬─────────────┘            └─────────────┬──────────────┘
               ▼                                        ▼
  TUS + EnabledResolutions: 360p,720p      TUS + full ladder
         = TWO encoding jobs                      = five jobs
               ▼                                        ▼
        720p on phones                     full ladder for the monitor
               └──────────► url/route.ts prefers the fuller one ◄──────┘
```

Per hour of footage: the fast path uploads **~2.2 GB** instead of today's
mixed-4K reality, and asks Bunny for **two** encoding jobs instead of five. Both
reductions attack 2a directly — the queue is the constraint, so the way to be
fast is to need less of it.

### 5b. The nine changes, in order

| # | Change | Why | Evidence |
|---|---|---|---|
| 1 | **Ask for `360p,720p` on the fast path** — per-upload, via the TUS header or the create body | 5 encoding jobs → 2, and the team stops waiting for a 1080p rung to watch 720p | measured (§2b), documented (§3) |
| 2 | **Stop uploading 4K on the fast path.** Transcode phone clips to the 720p upload copy on the device first, as Mux's own SDKs do | 672 MB/min → ~36 MB/min | measured (§1c), best practice (§4) |
| 3 | **One uploader, not four.** Collapse paths 1–4 onto a single entry point | this is what produced 113 GB of duplicates | measured (§1a, §2d) |
| 4 | **Content fingerprint as the identity.** `SHA-256(size ‖ first 1 MiB ‖ last 2 MiB)` — nearly free, because `extractVideoCreationTime` already reads exactly those bytes (`videoProbe.js:283`) | makes a second upload of the same bytes impossible rather than merely detected | measured (§2d) |
| 5 | **Encode to Mux's "standard input" spec** — ≤1080p, <8 Mbps, closed GOP, keyframes <20 s | a conforming input skips a mezzanine pass on every platform that has one; costs one ffmpeg flag change | documented (§4) |
| 6 | **Raise the proxy bitrate from 1.2 to ~4.8 Mbps** | a quarter of Cloudflare's 720p recommendation, on the worst possible content for low bitrates | external anchor (§4) |
| 7 | **Clean up: 192 orphan stubs and 113 GB of duplicates** | 27% of storage, and the stubs show TUS abandonment | measured (§1a, §1b) |
| 8 | **Evening queue on a schedule**, fed the full-res cut (`clips:day --full-res` already does this), full ladder requested | makes the second phase real instead of competing with the first | — |
| 9 | **Price Premium encoding against the wait.** 17.7 h ≈ **$53** one-off at HD rates; JIT makes a clip playable in 10–15 s | if 1–2 do not fix the wait, this does, and it is cheap | documented (§3) |

**1 and 2 are the whole of "ASAP"** and neither is architectural: one is a
parameter, the other is an encode before upload that `compress-videos.sh`
already knows how to do.

### 5c. What I am NOT proposing

**Early Play.** It would make a clip watchable instantly, and it does so by
exposing the original publicly — which is exactly what Block-Direct-URL and
token auth on this library exist to prevent. That is a security decision and it
is not mine.

**Keeping originals in Stream.** Bunny's `hasOriginal` reads `None` across the
library, so I could not confirm the library setting from the API. If it is on, it
is storing a third copy of everything; worth a look at the Encoding screen.

---

## 6. The one thing I could not measure

**Encode wait time.** The API exposes `dateUploaded` but no "ready at", so I
cannot measure how long the queue actually takes from the data. Everything in §2a
is Bunny's own documentation plus the reported 60–120 minutes.

If change 1 is made, that becomes measurable: `GET /library/{id}/videos/{guid}`
polled from upload to `status: 4`, before and after. Worth capturing on one day's
clips, because it is the number the whole goal is stated in.

## 7. The assumption that remains

That a **720p source asked for `360p,720p` encodes much faster than a 4K source
asked for five rungs.** Bunny publishes no per-job timings, so this rests on
"each enabled resolution is a separate encoding job" plus the source being an
eighth of the pixels. It is extremely likely and it is not verified.

One day's clips through change 1 settles it, and that is the cheapest possible
test of the most important claim here.

---

## Sources

Bunny: [encoding](https://bunny.net/docs/stream/encoding) ·
[TUS](https://bunny.net/docs/stream/tus-resumable-uploads) ·
[url-fetch](https://bunny.net/docs/stream/url-fetch) ·
[premium encoding](https://bunny.net/docs/stream/premium-encoding.md) ·
[storage structure](https://bunny.net/docs/stream/storage-structure.md) ·
[pricing](https://bunny.net/pricing/stream)

Best-in-class: [Frame.io C2C getting
started](https://help.frame.io/en/articles/8896457-c2c-getting-started-with-camera-to-cloud) ·
[Frame.io proxy workflow](https://help.frame.io/en/articles/6079079-c2c-complete-proxy-workflow-guide) ·
[Mux minimize processing time](https://www.mux.com/docs/guides/minimize-processing-time) ·
[Mux static renditions](https://www.mux.com/docs/guides/enable-static-mp4-renditions) ·
[Cloudflare Stream FAQ](https://developers.cloudflare.com/stream/faq/) ·
[Veo Cam 3](https://www.veo.com/product/veo-cam-3) · [Spiideo](https://www.spiideo.com/)

Library audit: `GET https://video.bunnycdn.com/library/620505/videos`, 10 pages,
26 Nov 2026.
