# SailScan back-fill — drop zone (Northstar 72)

Local staging area for back-fill data. **Not committed to git** (see `.gitignore`) — logs/PDFs/event files stay on your machine; Claude reads them here to test parsing + the day-join before anything is uploaded.

## Where to put things

```
sailscan-backfill/
  logfiles/     ← Expedition log exports (*.csv)
  eventfiles/   ← event / mark / sail-change files (*.xml, *.gpx, …)
  sailscans/    ← SailScan reports (*.pdf — North app or thesailcloud)
```

Type-first grouping is fine. The three are joined by **day (UTC date)**, which each file already carries internally (log timestamps, event-file times, SailScan capture dates). **Keep the original filenames** — they usually carry the date/identifier and help disambiguate.

## For the first test selection

Include a small but representative set:

- **At least one fully-matched day** — one logfile + its event file + the SailScan report(s) captured that day. This is what lets me test the join (scan → session → sail), not just the parsers in isolation.
- A bit of variety if easy: a **jib** day, a **main** day (IMN, 87% stripe), and ideally one **two-sail** thesailcloud report.

5–10 files total is plenty to start. Once it parses cleanly I'll widen to the full history.

## What I'll run

A read-only test harness that: parses every SailScan PDF (format, sail type, UTC stamp, stripes), parses the logs and event files, then reports how they line up by day — flagging any scan with no matching log/event, unknown event-file fields, or timezone mismatches. No DB writes, no uploads.
