# SSA v2.0-stable — Version Snapshot

**Tagged:** 2026-05-29 · **Branch:** `main` · **Marks:** the stable multi-tenant + two-tier-sync + mobile/desktop-polished baseline, immediately **before** the campaign-engine work begins. This is the "known-good" version to fall back to.

> How to return to this exact version is at the bottom.

---

## 1. What SSA is

Smart Sailing Analytics — a multi-tenant SaaS for sailing teams to capture, sync, and review on-water video alongside synchronised instrument data (Expedition logs). Coaches and sailors upload clips, the platform overlays live boat data (BSP, TWS/TWD, TWA, VMG, start-line gauges) on playback, and SailScan analyses sail-shape photos. Deployed at **ssa.wvsailing.co.uk**.

Stack: **Next.js 14 (App Router) + TypeScript + Tailwind**, deployed on **Vercel**; **Supabase** (auth + Postgres + RLS); **Bunny.net** (video storage + adaptive streaming).

---

## 2. Feature summary (what's in v2.0)

**Accounts & multi-tenancy.** Email/password auth via Supabase, password-reset flow, invitations with email-prefill and auto-approve. Org model is `team → boat`, users join via `memberships` carrying an access role (`coach`, `tl1`, `tl2`, `consultant`, `guest`; plus global `admin`). RLS isolates every team's data. Per-user storage quotas with 80/100% warnings. Admin audit-log viewer.

**Video capture → sync (two-tier).** Local clips live in the browser's IndexedDB. Sync splits into a **proxy** (low-bitrate, fast to upload, for field review) and the **original** (HD, for debriefs). On mobile, proxies auto-queue on import; originals are manual + wifi-gated. On desktop the flow is **originals-only** — Bunny encodes the adaptive ladder server-side — paired with a native ffmpeg/VideoToolbox compression workflow (Save-to-disk + Upload-compressed, per-clip and batch) that preserves the local HD blob untouched. TUS resumable uploads survive flaky wifi.

**Playback.** Adaptive HLS via Bunny Stream (240–720p ladder); hls.js with an extended buffer tuned for weak field wifi; 720p proxy served on mobile, HD reserved for desktop debriefs (coach/admin can opt into local-HD playback from IndexedDB). Lossless in-browser trim/crop (ffmpeg.wasm, WORKERFS-mounted to handle multi-GB originals).

**Instrument overlay.** Expedition CSV log parsed header-aware and overlaid at 5 Hz: BSP, %Target BSP, TWS, TWD, TWA, VMG%, heel, plus a start mode (TWD, Line-Sqr, distance-to-line in boat lengths from `DST_LINE`, TTB·Line/Port/Stbd, green BL / red OCS gauges). Boat length (m/ft) is an admin field used by the gauges.

**Tags.** Auto-tags derived from log (TWS bands, manoeuvres, legs) plus manual tags; suggestions span the whole session; tags are cloud-authoritative and propagate across users/devices.

**SailScan.** Sail-shape photo analysis (OpenCV.js) — separate roadmap (see SailScan memory notes).

**Mobile & desktop UX.** Mobile boots to the newest available session with auto-populated thumbnails; rotate-to-landscape or a fullscreen button gives a full-frame replay with the data overlay on top; tap-to-play/pause; phones/tablets are pinned to the mobile layout so rotation never drops playback. Thumbnails open the in-browser player on click (no standalone window). iPhone now keeps the overlay in fullscreen via inline playback.

---

## 3. How the pieces connect (setup map)

### Domain / DNS / hosting
```
ssa.wvsailing.co.uk
   123-reg (registrar)  →  Bunny DNS (zone)  →  Vercel (Next.js app)
```
When the site is down, debug in that order: registrar nameservers → Bunny DNS records → Vercel deployment/domain. (See `sailscan_infra_stack` memory.)

### Supabase (EU, Frankfurt)
- **Auth** — email/password; the app reads the session and resolves the user's active membership (team + boat + role).
- **Postgres** — core tables: `users`, `teams`, `boats`, `memberships`, `sessions` (one per boat×date; holds `log_data`/`xml_data`/`tz_offset`), `videos`, `photos`, `mast_settings`, `tag_lists`, `user_quota`, `events` (audit). Migrations live in `supabase/migrations/0001…0013`.
- **RLS** — every row carries denormalised `team_id` + `boat_id`; SELECT gated by `has_boat_access(...)`, writes by `has_team_role(...)` / `own_or_coach(...)`, with an `is_admin()` bypass. Every table has `created_by_user_id` + `created_at`/`updated_at`.

### Bunny.net (two surfaces that coexist)
- **Bunny Stream** — holds clips for **adaptive HLS** playback. Enabled resolutions 240–720p. Proxies (and, on desktop, originals) are uploaded here; Bunny transcodes the ladder and auto-generates poster thumbnails. Player prefers the proxy-Stream HLS, with a processing-state poll while Bunny encodes.
- **Bunny Storage Zone + Pull Zone (`ssa-videos.b-cdn.net`)** — the two-tier proxy/original file store; access gated by Supabase-signed URLs. Path split keeps proxy vs original separate.
- The two (Stream and Storage) intentionally coexist — older videos sit in Stream; the newer proxy/original flow uses the Storage Zone. (See `sailscan_bunny_stream_vs_storage` memory.)

### Browser / platform notes (important gotchas)
- **IndexedDB** stores local HD blobs; the **File System Access API** (`showDirectoryPicker`, `createWritable`) powers batch Save-to-disk into one chosen folder.
- **iPhone:** Safari force-promotes a playing `<video>` to the native OS player unless `playsInline` is set — which strips HTML overlays. v2.0 sets `playsInline` so fullscreen-with-overlay works (CSS pseudo-fullscreen, `position:fixed` + `100dvh`). iPhone has no element-level Fullscreen API, hence the pseudo-FS approach.
- **iPad / Android Chrome:** honour the real element Fullscreen API on the stage container (overlay preserved).
- **Desktop:** real Fullscreen API + Picture-in-Picture; originals-only sync; native ffmpeg+VideoToolbox compression is the recommended path on slow uplinks.
- **ffmpeg.wasm** crop mounts the source via **WORKERFS** (lazy `slice()` reads) to avoid the ~2 GiB typed-array ceiling on multi-GB camera originals.

---

## 4. Known roadmap (what comes after this tag)

The **campaign engine** — see `docs/campaign-spine-schema.md` (data model) and `docs/campaign-operating-model.md` (operating model). Next build: the campaign spine, rolled out **for the NORTHSTAR team only** first.

---

## 5. How to return to this version

This snapshot is the git tag **`v2.0-stable`**.

Inspect without changing anything:
```bash
cd ~/Code/ssa && git show v2.0-stable --stat | head -40
```

Temporarily look around at this version (detached HEAD — read-only browsing):
```bash
cd ~/Code/ssa && git checkout v2.0-stable
# …look around…  then return to latest:
cd ~/Code/ssa && git checkout main
```

Roll the working branch back to this version (DANGER — discards newer commits on main; only if you truly want to revert):
```bash
cd ~/Code/ssa && git checkout main && git reset --hard v2.0-stable && git push --force-with-lease
```

Safer "undo forward" that keeps history (recommended over reset):
```bash
cd ~/Code/ssa && git checkout main && git revert --no-edit v2.0-stable..HEAD && git push
```

Start a fresh branch from this version (e.g. to hotfix the stable line while campaign work continues on main):
```bash
cd ~/Code/ssa && git checkout -b hotfix-from-v2.0 v2.0-stable
```
