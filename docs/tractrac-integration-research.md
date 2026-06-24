# TracTrac race-tracking integration — research notes

_Prepared June 2026, ahead of receiving TracTrac's API details. Goal: pull live + replay
boat tracks (position, SOG, COG) into the SSA app to compute gains/losses vs the fleet._

## TL;DR — yes, this is well-trodden

TracTrac is the standard GPS live-tracking platform for sailing events, and pulling its
data into a third-party analytics app is a solved problem — **SAP Sailing Analytics**
(open source) and **Njord Analytics** (commercial) both do exactly this. The data
**explicitly includes per-boat position, SOG and COG**, which is everything needed for
gains/losses, leverage, VMG-vs-fleet, ladder-rung and cross-time analysis.

The gating factor is **access/permission**, not technology: the event organiser (and the
person running TracTrac at the event) must grant your app permission on the event. The
TracTrac developer offering us a "data link" is precisely this step.

## How the data is structured ("TracAPI")

From SAP's open-source connector and docs:

- **Entry point:** an event JSON service URL, e.g.
  `https://event.tractrac.com/events/<event_db_name>/jsonservice.php`
  (event DB names look like `event_20220626_KielerWoch`). This lists the event's races and
  competitors.
- **Per race:** the event JSON points (via a `params_url`) to a `.txt` parameter file, which
  in turn references a **binary `.mtb` archive** holding that race's full track data.
- **Also available:** a **KML download** per race (this is the path Njord uses) — much easier
  to parse than the binary `.mtb`.
- **Fields:** position (lat/lon) + time, plus **COG and SOG** (TracTrac's newer API exposes
  these directly; otherwise they're trivially derived from the 1 Hz position stream).
- **Live vs replay:** the same TracAPI serves a **live stream** (powers the public live
  trackers) and **historical replay** (the stored `.mtb`/JSON/KML). For post-race debrief we
  want replay; for on-the-water/coach-boat use we want live.

## Access / auth model

- Newer TracTrac uses an **API-token scheme**: tokens authenticate a user, and TracTrac
  authorises that user for read (or read/write) access to specific events.
- Njord's concrete recipe (a good template to ask our organiser for):
  1. Enable **KML Download** for the event on the TracTrac management page.
  2. Grant **permission to a named API user** (Njord uses `tractrac@sailnjord.com`) — we'd
     ask for an equivalent SSA user/token.
  3. Request a few days **before** the event.

## What's possible in the SSA app

- **Live fleet view:** all boats on the map in real time (reuse the existing Leaflet map).
- **Replay/playback:** scrub a race with the existing time-bar pattern.
- **Per-boat SOG/COG** readouts and trails.
- **Gains/losses analytics** (the headline goal), all computable from all-boats position +
  SOG/COG + the course marks:
  - distance gained/lost on the leg vs each competitor (and vs fleet median),
  - relative VMG to the next mark, leverage (cross-track) and "ladder-rung" gains,
  - cross-times / lead changes, start-line bias and timing.
  This is exactly the class of analysis Njord/SAP produce from the same feed.

## Reference implementations (worth mining)

- **SAP Sailing Analytics** — open source (Java). Full TracTrac connector + the
  `downloadTracTracEvent` scripts and the whole event→race→track pipeline. Best technical
  reference for the format. `github.com/SAP/sailing-analytics`
- **Njord Analytics** — commercial; confirms the access recipe + that gains/losses-style
  debrief from TracTrac is a product. `sailnjord.com/data-sources/tractrac`
- **TracTrac's own GitHub org** — `github.com/TracTracAPS` (check for official SDK/sample).

## Integration approach for SSA (recommendation)

- **Prefer a JSON / KML / websocket feed over the binary `.mtb`.** SAP's `.mtb` parser is
  Java; there's no obvious JS parser. If the dev can give us JSON (replay) and a websocket/REST
  live stream, we parse it directly in the existing JS stack with no reverse-engineering.
- **Hide the token behind a server route** (same pattern as our Bunny storage proxy /
  Open-Meteo calls) so the API token never ships to the browser.
- **Two modes:** (1) live — websocket/poll → boats on the map; (2) replay — fetch the race
  track once, store/normalise, run the gains/losses math client- or box-side.
- **Course marks matter:** leg-relative gains/losses need the start line + marks/gates, so
  confirm the feed includes the course geometry, not just boats.

## Questions to put to the TracTrac developer (when API details arrive)

1. **Access:** live, replay, or both? Per-event token, and how is it scoped/issued?
2. **Format:** JSON/REST + websocket for live? JSON/KML for replay? Or only the binary `.mtb`?
   (We strongly prefer JSON/KML/websocket for a JS app.)
3. **Fields:** does the feed include **SOG, COG and heading**, or position+time only (we derive)?
4. **Sample rate** (1 Hz typical?) and any smoothing/outlier filtering already applied.
5. **Course data:** start line, marks, gates, mark passings/roundings — included?
6. **Competitor metadata:** boat name, sail number, class, colour.
7. **Rate limits / caching** expectations (so we don't hammer their live server).
8. **Historical/replay endpoint** for post-race debrief, and how long data is retained.

## Sources

- [SAP Sailing Analytics — Wiki home](https://github.com/SAP/sailing-analytics/blob/main/Home.md)
- [SAP — Downloading and Archiving TracTrac Events](https://raw.githubusercontent.com/SAP/sailing-analytics/main/wiki/howto/downloading-and-archiving-tractrac-events.md)
- [Njord Analytics — TracTrac data source](https://www.sailnjord.com/data-sources/tractrac/)
- [SAP Sailing Analytics — Admin Console release notes (API-token auth, SOG/COG)](https://www.sapsailing.com/release_notes_admin.html)
- [TracTrac](https://www.tractrac.com/)
- [TracTrac GitHub org (TracTracAPS)](https://github.com/TracTracAPS)
- [Sailing Anarchy — GPS race tracker thread](https://forums.sailinganarchy.com/threads/gps-race-tracker.96633/)
