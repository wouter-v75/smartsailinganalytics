# Smart Sync & Caching Architecture — Research & Recommendations

**Context:** SSA is an offline-first sailing analytics web app (Next.js browser client + IndexedDB/localStorage, Bunny Storage for JSON/photo blobs, Bunny Stream for video, Supabase/Postgres for authoritative metadata). It must stay smooth on slow, intermittent mobile connections. The trigger for this study: the client re-uploads data already in the cloud (e.g. a logfile that's been in Bunny for days) because sync decisions trust local flags instead of real cloud state.

This document synthesises how best-in-class products and libraries solve this, and ends with a concrete, prioritised plan mapped to our stack.

---

## 0. The one principle that fixes our bug

> **Cloud/local presence is decided by content, not by a local boolean.** Local "synced" flags are an optimisation hint, never the source of truth — they drift after failed/partial uploads, reinstalls, storage eviction, and multi-device use.

Every mature system replaces the question *"did I upload this?"* (a local flag) with *"does the cloud already have this exact content?"* (a hash lookup). AWS frames the existence check (`HeadObject`) as the thing you do *before* transferring; restic and Dropbox make the object's identity a hash of its own bytes so the answer can't lie ([restic — Content Defined Chunking](https://restic.net/blog/2015-09-12/restic-foundation1-cdc/), [Dropbox — Content Hash](https://www.dropbox.com/developers/reference/content-hash), [AWS — Checking object integrity](https://docs.aws.amazon.com/AmazonS3/latest/userguide/checking-object-integrity-upload.html)).

Our exact bug in this framing: `syncSessionToCloud` uploads `log.json`/`events.json` whenever `logData?.rows?.length` is truthy, with no presence/hash check; and the "synced" flag it would rely on is written to a localStorage key that `saveLogData` deletes, so it never persists. Two independent failures, one symptom.

---

## 1. Content addressing, hashing & manifests (the core fix)

**Name data by the hash of its bytes.** In restic "the data's address is a hash of the data itself," giving automatic dedup — identical content is stored/transmitted once ([restic](https://restic.net/blog/2015-09-12/restic-foundation1-cdc/)). Dropbox publishes a deterministic **content hash** (4 MB blocks → SHA-256 each → SHA-256 of the concatenation) precisely so clients can "compare remote files to local files without downloading them" ([Dropbox](https://www.dropbox.com/developers/reference/content-hash)).

**A per-session manifest turns a resync into a tiny hash exchange.** A restic re-backup of unchanged data "finished in less than a second" and the repo "does not grow at all," because a snapshot is just a list of already-present chunk hashes ([restic](https://restic.net/blog/2015-09-12/restic-foundation1-cdc/)). Git generalises the wire shape: client sends `have`/`want` hash lists, server ships only the missing objects ([Git — gitprotocol-pack](https://git-scm.com/docs/gitprotocol-pack)). For a large asset set, arrange the manifest as a **Merkle tree**: compare one root hash to answer "anything changed at all?", then descend only into mismatched subtrees — O(log n) and you "only send hashes (32 bytes each) until you pinpoint the exact differences" ([Merkle trees & anti-entropy](https://deepengineering.substack.com/p/merkle-trees-and-anti-entropy-concepts)).

**Chunk-level dedup only matters for *changed* files.** Content-defined chunking (CDC) with a rolling/Gearhash boundary survives byte insertions that would break fixed-size blocks, so a re-exported/EXIF-edited asset re-sends only its deltas ([HF Xet — CDC](https://huggingface.co/docs/xet/en/chunking), [restic](https://restic.net/blog/2015-09-12/restic-foundation1-cdc/)). Keep the cheap "where to cut" hash separate from the strong "what is this chunk" identity hash ([borg — Internals](https://borgbackup.readthedocs.io/en/stable/internals.html)). **For SSA this is over-engineering** — our media are whole immutable files; whole-file hashing is enough. CDC is noted only as the escalation path if we ever diff large versioned assets.

**Steal for SSA:** a small `sync-manifest.json` per session `{ fileId → { hash, size, mtime } }`. Sync = diff local hashes vs the manifest; upload only the misses. Repeat syncs of unchanged data become a few-hundred-byte exchange, not a multi-MB re-upload.

---

## 2. Cheap presence & freshness checks over HTTP

Ordered cheapest-first, the industry answer to "is it already there / has it changed?":

1. **Local manifest first (free)** — most questions never hit the network.
2. **HEAD the object** — same headers as GET, no body: existence, `Content-Length`, `ETag`, `Last-Modified` for a few hundred bytes ([MDN — HEAD](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Methods/HEAD), [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html)).
3. **Conditional GET** — `If-None-Match: <etag>` → `304 Not Modified` (tiny, header-only) when unchanged; ETag detects any content change, not just a timestamp bump ([MDN — Conditional requests](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Conditional_requests)).
4. **Fingerprint compare** — if a HEAD's `ETag` equals your locally computed hash, the bytes are already there; skip the upload for zero body cost.

For **writes**, optimistic concurrency prevents clobbering: `If-Match: <etag>` makes a PUT succeed only if the server copy is unchanged (`412` otherwise); `If-None-Match: *` makes a create succeed only if nothing exists yet ([MDN — Conditional requests](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Conditional_requests)).

**Gotchas (important for Bunny/S3):**
- **Multipart ETag is *not* a plain MD5** — it's the MD5 of concatenated per-part MD5s plus `-<partCount>`, and depends on part size. Don't build dedup on `ETag == md5(file)` for multipart objects ([AWS — multipart data integrity](https://docs.aws.amazon.com/AmazonS3/latest/userguide/tutorial-s3-mpu-additional-checksums.html)). ETag isn't guaranteed MD5 even for single-part on some stores/encryption ([DigitalOcean Spaces ETag note](https://www.digitalocean.com/community/questions/contents-of-etag-returned-from-spaces-isn-t-always-md-5)) — treat ETag as an opaque validator and carry our **own** hash in the manifest.
- **Bunny Storage** accepts an optional `Checksum` header (SHA-256, uppercase hex) but **returns `201` even on a bad checksum without storing the file** — you must verify afterward, never trust the status code ([Bunny Storage HTTP API](https://docs.bunny.net/storage/http)).
- **`Last-Modified` has ~1 s resolution** — prefer ETag/hash when correctness matters ([MDN](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Conditional_requests)).
- **S3 HEAD 403-vs-404 depends on `ListBucket` permission** — don't infer "absent" from a 403 ([AWS — HeadObject](https://docs.aws.amazon.com/AmazonS3/latest/API/API_HeadObject.html)).

---

## 3. Resumable, idempotent uploads (survive flaky radios)

- **tus resumable uploads:** `HEAD` the upload URL → server returns `Upload-Offset`; client `PATCH`es only the remaining bytes; offset mismatch → `409` (no corruption). Optional `Upload-Checksum` per chunk → `460` on mismatch, chunk discarded, offset not advanced ([tus.io — protocol](https://tus.io/protocols/resumable-upload)). We already use tus for video via Bunny Stream — good.
- **S3 multipart:** retry only failed parts; keep your own list of part numbers + ETags for completion ([AWS — multipart upload](https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpuoverview.html)).
- **Idempotency keys:** a stable UUID per upload so a retried request (mobile timeouts are ambiguous — did it land?) returns the original result instead of duplicating ([Stripe — Idempotent requests](https://docs.stripe.com/api/idempotent_requests)).
- **Exponential backoff + jitter** so reconnecting clients don't retry in lockstep ([Adyen — idempotency & retries](https://docs.adyen.com/development-resources/api-idempotency)).
- **Resumable downloads:** `Range: bytes=n-` → `206`, guarded by `If-Range` so a mid-flight change forces a clean `200` restart instead of stitching two versions ([MDN — Range requests](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Range_requests)).

---

## 4. Tiered / progressive media (the biggest mobile win)

Every major photo product tiers **placeholder → thumbnail → proxy → original**, fetching originals only on demand and preferring Wi-Fi:

- **Instant placeholder shipped inside the data row (~20–200 bytes).** ThumbHash (~25 bytes, encodes aspect ratio + alpha) or a ~100-byte 16×16 WebP LQIP (renders with no JS — paints before hydration on slow CPUs). Keep the hash a hash end-to-end; decoding it to Base64 server-side inflates it ~10× and defeats the point ([Mux — blurry placeholders](https://www.mux.com/blog/blurry-image-placeholders-on-the-web), [ThumbHash](https://evanw.github.io/thumbhash/)).
- **Thumbnail-first, two-phase backup.** Google Photos syncs a browsable low-res pass ("Backing up thumbnails") before heavy originals ([Google Photos Help](https://support.google.com/photos/thread/194533168)). Apple iCloud "Optimize Storage" keeps thumbnails/proxies on device and pulls originals only when needed ([Apple — iCloud Photos](https://support.apple.com/en-us/108782)).
- **Wi-Fi-gated originals by default, explicit cellular override** — Immich uploads on Wi-Fi only by default ([Immich — Mobile Backup](https://docs.immich.app/features/mobile-backup/)).
- **Right-size per device** with `srcset`/`sizes` (desktop pixels to phones waste 2–4× data), and `loading="lazy"` for off-screen media (eager-load only the LCP image) ([web.dev — responsive images](https://web.dev/articles/serve-responsive-images), [web.dev — lazy loading](https://web.dev/articles/browser-level-image-lazy-loading)).
- **Video: stream, never download originals.** HLS/DASH adaptive bitrate picks the rendition for live bandwidth and is "ideal for mobile users moving between WiFi and mobile data"; show a poster + placeholder while the first segment loads ([Mux — HLS vs DASH](https://www.mux.com/articles/hls-vs-dash-what-s-the-difference-between-the-video-streaming-protocols)). Bunny Stream already gives us this.

**Dedup, as the reference apps do it:** hash the file client-side, send the hash first, let the server say "already have it → skip." Immich sends a SHA-1 via `x-immich-checksum` *before* uploading to skip duplicates and "save bandwidth"; PhotoPrism skips by SHA-1 + size at index and keys its thumbnail cache path by the original file hash ([Immich](https://docs.immich.app/features/mobile-backup/), [Immich PR #16133](https://github.com/immich-app/immich/pull/16133), [PhotoPrism — Duplicates](https://docs.photoprism.app/user-guide/library/duplicates/), [PhotoPrism — Thumbnails](https://docs.photoprism.app/developer-guide/media/thumbnails/)). This single move turns a would-be full-original upload into a tiny hash round-trip — the biggest saver on a slow link.

---

## 5. Browser storage, Service Workers & network-aware sync

- **Blobs in Cache Storage, structured data in IndexedDB.** The Cache API stores `Response` objects that *stream* (faster first paint, lower peak memory, range requests for video); IndexedDB is for queryable metadata + the sync queue ([Chrome — caching strategies](https://developer.chrome.com/docs/workbox/caching-strategies-overview), [MDN — storage quotas](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria)).
- **One origin quota, evicted all-at-once.** Design so a wipe is recoverable (server authoritative; local is cache). Pre-flight big writes with `navigator.storage.estimate()`, wrap in `try/catch(QuotaExceededError)`, and call `navigator.storage.persist()` to opt out of best-effort eviction ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria), [WebKit — storage policy](https://webkit.org/blog/14403/updates-to-storage-policy/)).
- **Match SW strategy to content:** cache-first for immutable already-uploaded media; network-first (with a network-timeout fallback) for data reads; stale-while-revalidate for non-critical thumbnails; network-only + Background Sync for uploads ([Chrome — Workbox strategies](https://developer.chrome.com/docs/workbox/caching-strategies-overview), [workbox-background-sync](https://developer.chrome.com/docs/workbox/modules/workbox-background-sync)).
- **Network-aware transfers:** `navigator.connection.effectiveType`/`saveData` (readable in the SW) to send thumbnails only on 2g/3g and hold originals; the `connection` `change` event to auto-flush the original queue when Wi-Fi returns and pause on cellular ([web.dev — adaptive serving](https://web.dev/articles/adaptive-serving-based-on-network-quality)). Prioritise the queue: thumbnails to the front, originals to the back, with a `maxRetentionTime` ([workbox-background-sync](https://developer.chrome.com/docs/workbox/modules/workbox-background-sync)).

**iOS Safari reality (we are a mobile app — this matters most):**
- **No Background Sync, no Periodic Background Sync, no Network Information API on Safari.** Deferred uploads will *not* replay while the app is closed; `navigator.connection` is undefined. Build an in-page fallback: flush the IndexedDB queue on launch, on the `online` event, and on `visibilitychange`; offer a manual "upload originals now / Wi-Fi-only" toggle ([caniuse — Background Sync](https://caniuse.com/background-sync), [MDN — effectiveType](https://developer.mozilla.org/en-US/docs/Web/API/NetworkInformation/effectiveType)).
- **7-day script-storage eviction (ITP):** with no interaction for 7 days Safari deletes IndexedDB/Cache/SW. Unsynced captures can vanish over a week's inactivity — **Add to Home Screen** escapes this and earns persistent storage ([WebKit](https://webkit.org/blog/14403/updates-to-storage-policy/), [Search Engine Land — Safari 7-day cap](https://searchengineland.com/what-safaris-7-day-cap-on-script-writeable-storage-means-for-pwa-developers-332519)).

---

## 6. Sync engines vs hand-rolling the metadata sync

The load-bearing finding: **sync engines sync structured data; none sync large blobs.** PowerSync, Replicache, ElectricSQL, RxDB all use the same two-tier split — small rows through the engine, photos/videos to object storage via a separate upload queue, the row carrying a pointer + content hash ([PowerSync — Attachments](https://docs.powersync.com/client-sdks/advanced/attachments)). That is exactly the manifest + object-storage design for our media half.

Every engine reduces to **cursor + delta**: a `checkpoint`/`cookie`/`lastPulledAt`/`operation ID` the client sends, server returns only what changed — the same shape as a manifest diff, which is why hand-rolling is viable for a simple model. Worth stealing without adopting a framework: Replicache's mutation-queue + rebase-on-pull and "poke" (tiny signal, client pulls the real delta); ElectricSQL "shapes" (partial replication by a WHERE clause — e.g. one venue/regatta's data); WatermelonDB's **per-column** merge (cheaper and safer than whole-record LWW) ([Replicache — how it works](https://doc.replicache.dev/concepts/how-it-works), [ElectricSQL — Shapes](https://electric-sql.com/docs/guides/shapes), [WatermelonDB — Sync](https://watermelondb.dev/docs/Implementation/SyncImpl)).

**Conflict resolution — start simple, escalate only when forced.** Server-authoritative + LWW (or per-column merge) handles ~80% of CRUD; Figma deliberately uses per-property LWW on a central server and **rejected true CRDTs** because it doesn't need decentralised merge ([Figma — multiplayer](https://www.figma.com/blog/how-figmas-multiplayer-technology-works/)). CRDTs (Yjs/Automerge) are for genuine concurrent editing of the *same* fine-grained content (free text) — and are frequently over-adopted: Cinapse migrated *away* from Automerge (unbounded history growth toward WASM's 4 GB ceiling, extra sync-server cost) to server-authoritative PowerSync, cutting hosting 66% ([PowerSync — Why Cinapse moved away from CRDTs](https://www.powersync.com/blog/why-cinapse-moved-away-from-crdts-for-sync), [Ink & Switch — Local-first](https://www.inkandswitch.com/essay/local-first/)).

**Verdict for SSA:** our data model is simple (sessions, videos, photos, scans — mostly append/CRUD, rarely concurrent edits on the same row) and blob-heavy. **Hand-roll a manifest + content-hash sync now; do not adopt a sync engine.** Keep the door open to RxDB/Dexie/PowerSync only if the relational metadata later grows collaborative. Supabase already gives us the server-authoritative store.

---

## 7. Recommended plan for SSA, prioritised for slow mobile

**Phase 1 — Stop the redundant uploads (fixes the reported bug; highest value, low risk).**
- Compute a fast **content hash** of `log.json`/`events.json` payloads (a 32-bit FNV/xxhash over the JSON string is plenty for change-detection; cache it keyed by size+mtime).
- Maintain a tiny **`sessions/{date}/sync-manifest.json`** in Bunny: `{ logHash, xmlHash, updatedAt, videoIds:{…}, photoCount }`. Before uploading log/xml, fetch this (a few hundred bytes) and **skip if the local hash matches**. After a successful upload, update the manifest.
- Persist the synced state where it's actually read: store `syncedHash` in the **IndexedDB** `log_data`/`xml_data` rows (not the deleted localStorage key), and fix `getUnsyncedCount`/`markSynced` to use it so the "unsynced" badge is truthful.
- Net effect: a logfile already in the cloud costs one small manifest GET, zero upload.

**Phase 2 — Make cloud state authoritative & self-healing.**
- On session load / boat switch, reconcile local flags against the manifest (and existing video/photo cloud rows) so a lost/stale flag never triggers a re-upload, and a file present from another device is recognised.
- Add optimistic-concurrency (`If-Match`/manifest `updatedAt`) so two devices don't clobber the manifest.
- Verify Bunny writes (it returns 201 even on bad checksum) with a cheap follow-up HEAD/hash check.

**Phase 3 — Network-aware tiering for smooth slow-link UX.**
- Formalise the existing photo tiers: **thumbnail immediately, original deferred to good connection**, driven by `effectiveType`/`saveData` with a `connection`-change auto-flush and an explicit "upload originals now / Wi-Fi-only" control (required because iOS lacks these APIs). Videos already stream via Bunny Stream — keep originals on-demand/Wi-Fi.
- Add a ~25-byte **ThumbHash** (or ~100-byte WebP LQIP) to each photo's metadata row for instant, offline-capable grid paint.

**Phase 4 — Durability & background (nice-to-have).**
- `navigator.storage.persist()` + `estimate()` pre-flight + LRU eviction of our own oldest cached media; prompt "Add to Home Screen" for iOS persistence.
- Where supported (Chromium), Background Sync to replay the upload queue while closed; in-page fallback (`online`/`visibilitychange`/launch) for iOS.

Phase 1 alone resolves the symptom you saw and is the natural continuation of the sync work already in progress. Phases 2–4 are the "best possible" layering for slow mobile.

---

## Sources

- restic — [Content Defined Chunking](https://restic.net/blog/2015-09-12/restic-foundation1-cdc/)
- Dropbox — [Content Hash](https://www.dropbox.com/developers/reference/content-hash) · [Rewriting our sync engine](https://dropbox.tech/infrastructure/rewriting-the-heart-of-our-sync-engine)
- Hugging Face Xet — [Content-Defined Chunking](https://huggingface.co/docs/xet/en/chunking)
- borgbackup — [Internals](https://borgbackup.readthedocs.io/en/stable/internals.html)
- rsync — [tech report](https://www.samba.org/rsync/tech_report/node3.html)
- Git — [gitprotocol-pack](https://git-scm.com/docs/gitprotocol-pack) · [pack-protocol (thin packs)](https://git-scm.com/docs/pack-protocol/2.2.3)
- Merkle sync — [Anti-entropy concepts](https://deepengineering.substack.com/p/merkle-trees-and-anti-entropy-concepts)
- AWS S3 — [Checking object integrity](https://docs.aws.amazon.com/AmazonS3/latest/userguide/checking-object-integrity-upload.html) · [HeadObject](https://docs.aws.amazon.com/AmazonS3/latest/API/API_HeadObject.html) · [Multipart upload](https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpuoverview.html) · [Multipart data integrity (ETag)](https://docs.aws.amazon.com/AmazonS3/latest/userguide/tutorial-s3-mpu-additional-checksums.html)
- MDN — [Conditional requests](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Conditional_requests) · [Range requests](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Range_requests) · [Storage quotas & eviction](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria) · [effectiveType](https://developer.mozilla.org/en-US/docs/Web/API/NetworkInformation/effectiveType)
- RFC 9110 — [HTTP Semantics](https://www.rfc-editor.org/rfc/rfc9110.html)
- tus.io — [Resumable upload protocol](https://tus.io/protocols/resumable-upload)
- Bunny — [Storage HTTP API](https://docs.bunny.net/storage/http)
- Stripe — [Idempotent requests](https://docs.stripe.com/api/idempotent_requests)
- web.dev — [Adaptive serving by network quality](https://web.dev/articles/adaptive-serving-based-on-network-quality) · [Responsive images](https://web.dev/articles/serve-responsive-images) · [Lazy loading](https://web.dev/articles/browser-level-image-lazy-loading)
- Chrome/Workbox — [Caching strategies](https://developer.chrome.com/docs/workbox/caching-strategies-overview) · [workbox-background-sync](https://developer.chrome.com/docs/workbox/modules/workbox-background-sync) · [Periodic Background Sync](https://developer.chrome.com/docs/capabilities/periodic-background-sync)
- WebKit — [Updates to storage policy](https://webkit.org/blog/14403/updates-to-storage-policy/) · Search Engine Land — [Safari 7-day cap](https://searchengineland.com/what-safaris-7-day-cap-on-script-writeable-storage-means-for-pwa-developers-332519)
- Mux — [Blurry image placeholders](https://www.mux.com/blog/blurry-image-placeholders-on-the-web) · [HLS vs DASH](https://www.mux.com/articles/hls-vs-dash-what-s-the-difference-between-the-video-streaming-protocols) · [ThumbHash](https://evanw.github.io/thumbhash/)
- Immich — [Mobile Backup](https://docs.immich.app/features/mobile-backup/) · [Checksum header PR #16133](https://github.com/immich-app/immich/pull/16133) · PhotoPrism — [Duplicates](https://docs.photoprism.app/user-guide/library/duplicates/) · [Thumbnails](https://docs.photoprism.app/developer-guide/media/thumbnails/)
- Apple — [iCloud Photos](https://support.apple.com/en-us/108782) · Google — [Backup quality](https://support.google.com/photos/answer/6220791)
- Sync engines — [PowerSync Attachments](https://docs.powersync.com/client-sdks/advanced/attachments) · [Why Cinapse moved away from CRDTs](https://www.powersync.com/blog/why-cinapse-moved-away-from-crdts-for-sync) · [Replicache](https://doc.replicache.dev/concepts/how-it-works) · [ElectricSQL Shapes](https://electric-sql.com/docs/guides/shapes) · [RxDB Replication](https://rxdb.info/replication.html) · [WatermelonDB Sync](https://watermelondb.dev/docs/Implementation/SyncImpl)
- Local-first & conflict — [Ink & Switch: Local-first software](https://www.inkandswitch.com/essay/local-first/) · [Figma multiplayer](https://www.figma.com/blog/how-figmas-multiplayer-technology-works/) · [Linear sync engine](https://www.fujimon.com/blog/linear-sync-engine) · [Actual Budget FAQ](https://actualbudget.org/docs/faq/)
