# The SSA tagger — prior art and what it implies

Research behind the tagging tool (`src/lib/tagging/`, migration `0062_ssa_tagger.sql`).
The question was: how do the teams who do this for a living actually tag a session?

Sources are listed at the bottom. Several vendor sites could not be read directly
from the build environment; where that was the case the finding rests on search
summaries rather than the primary page, and is marked accordingly.

## 1. Elite tagging is TWO levels, not one

Sportscode and Nacsport — between them the tools most elite team-sport analysts
use — both split a tag into:

- a **category**: what happened (tack, start, mark rounding, gybe)
- one or more **descriptors** / **labels**: how, who, where (*slow*, *crew
  error*, *helm: X*, *J2*, *18 kn*)

Nacsport describes descriptors as "adjectives to categories". Everything
downstream — the data matrix, the filters, the playlists — is built on the
pairing, not on the category alone. A flat tag list cannot answer "show me every
slow tack above 18 knots with the J2 up", which is the question a debrief is
actually made of.

**Implication for SSA:** a tag event needs a `labels` list (group + text), drawn
from a controlled vocabulary carried on the tag definition.

## 2. A tag button needs lead and lag time

In Sportscode, a code button carries **lead time** (the instance starts N seconds
*before* the click) and **lag time** (it keeps running N seconds after). This is
not a convenience: by the time a human has registered a moment and found the
button, the moment is over. Tags placed by button without lead time land late,
every time.

**Implication:** `lead_sec` / `lag_sec` on a tag definition, applied when the tag
is dropped, and adjustable afterwards by dragging.

## 3. The timeline is rows, not one track

Sportscode timelines and ELAN (the reference multimedia annotation tool in
linguistics) both use a **multi-tier** model: one row per category, annotations
time-aligned to the media, each independently draggable and resizable. ELAN adds
a distinction worth stealing — *time-alignable* tiers versus *referring* tiers
whose annotations hang off a parent annotation rather than off the clock.

**Implication:** the daily tag track renders as lanes (one per crew section, or
per category), not a single row of chips. Moving a tag = dragging within its lane.

## 4. Auto-derived data lives BESIDE the source, never inside it

GoldenCheetah's interval-discovery design is explicit that auto-detected intervals
(routes, climbs, peaks, efforts, matches) are "identified automatically but stored
separately from ride files", so several detectors can claim the same stretch of
time without fighting over one field.

SSA already learned this the hard way: see the `isAutoTag` comment in
`src/lib/localStore.js` — a prefix-matching auto-tag detector was wiping manual
tags on every `enrichVideo` pass, so tag edits never survived a refresh.

**Implication:** auto tags and auto phases are a derived layer keyed separately
from human tags. Re-deriving must never touch a human row. The `.ssa` event file
is generated from both, not the storage for either.

## 5. Clean the log, THEN generate phases

KND SailingPerf — the analysis software behind VOR, IMOCA and SailGP campaigns,
and the source of the phase model already implemented in `src/lib/phaseStats.ts` —
runs the pipeline: Expedition log → **LogCleaner** → RaceReplay → *generate
phases*. The filtering step is a named product stage, not an afterthought.

**Implication:** confirms `buildAutoPhases()`. The thresholds should be visible
and adjustable in the UI, and rejected slices shown greyed out with their reason,
so a gap in the phase track reads as "the log died here" rather than "the tool
missed it".

## 6. Manoeuvre detection is table stakes; manoeuvre KPIs are the value

kTool, SailFrames, Njord Analytics and Vakaros all detect tacks and gybes
automatically, with no manual tagging. What they compete on is what they report
per manoeuvre: **entry speed, entry angle, execution time, exit efficiency, metres
lost, time to recover to 90 % of target boat speed, VMG through the turn.**

Njord's interaction model is worth copying directly: highlight a section of the
track and see statistics for just that segment; on-water comments appear as
markers in the same timeline.

**Implication:** applying a manoeuvre tag should auto-attach its KPIs to the tag's
`meta`, so the tag carries its own evidence. Selecting a range should show that
range's stats before you commit to cutting phases out of it.

## 7. Sportscode XML is the interchange lingua franca

The schema (confirmed from a primary source):

```xml
<file>
  <SORT_INFO><sort_type>sort order</sort_type></SORT_INFO>
  <ALL_INSTANCES>
    <instance>
      <ID>1</ID>
      <code>Tack</code>
      <start>131.4</start>
      <end>149.2</end>
      <label><text>slow</text><group>Quality</group></label>
    </instance>
  </ALL_INSTANCES>
  <ROWS>
    <row><sort_order>1</sort_order><code>Tack</code><R>29</R><G>158</G><B>117</B></row>
  </ROWS>
</file>
```

Catapult, Wyscout and Dartfish all read it. Note how cleanly it maps onto the
category + descriptor model above: `<code>` is the category, each `<label>` is a
descriptor with its group.

**Implication:** `.ssa.json` stays canonical (it carries phases, scopes, sections
and provenance, which Sportscode XML has nowhere to put), but exporting the tag
half as Sportscode XML costs little and lets SSA tags open in the tools a visiting
analyst already has.

## 8. Permissions: role-based views, real privacy, audit trail

Teamworks AMS (formerly Smartabase) and Kitman Labs both run permissions-based
views over sensitive athlete data, with role-based permissions and audit trails,
and keep private material genuinely private rather than merely hidden in the UI.

**Implication:** confirms the three scopes. Personal tags must never reach an
export — enforced in `eventFile.ts:isExportable`, not just in the UI — and every
tag carries its author for the audit trail.

## 9. Two-boat testing wants "runs" as a first-class range

Speed testing is run as repeated timed straight-line runs (commonly ~3 minutes),
with the pair swapping windward/leeward positions and repeating three or four
times before a difference is believed. A run is only valid if the boats were
evenly matched, in the same wind, in relatively steady conditions, with no
tactical advantage — the human version of the same filter `buildAutoPhases()`
applies to a 30-second slice.

**Implication:** `lineup` / `test` are range tags whose descriptors carry the
variable under test and the repeat number, so a season's worth of runs can be
grouped and compared.

---

## Sources

- Sportscode XML schema — https://github.com/PySport/kloppy/issues/92 (read in full)
- GoldenCheetah, advanced interval discovery — https://github.com/GoldenCheetah/GoldenCheetah/issues/537 (read in full)
- Hudl Sportscode, lead/lag time — https://support.hudl.com/s/article/add-lag-time-to-a-button-sportscode
- Hudl Sportscode, code window modes — https://support.hudl.com/s/article/code-window-modes-sportscode
- Nacsport, categories and descriptors — https://www.nacsport.com/blog/en-gb/Tips/nacsport-performance-analysis-categories-and-descriptors
- Nacsport, activation links — https://www.nacsport.com/blog/en-gb/Tips/activation-links
- ELAN annotation model — https://www.mpi.nl/corpus/html/elan/ch02.html
- KND 101 (LogCleaner → RaceReplay → phases) — https://www.fieldyachting.com/event-details/knd-101
- Njord Analytics — https://www.sailnjord.com/analytics/
- kTool — https://ktool.hu/
- SailFrames — https://sailframes.com/
- Vakaros, VMG and tack loss — https://blog.vakaros.com/vmgtackloss
- Cyclops Marine, modern analytics for racing sailors — https://www.cyclopsmarine.com/modern-analytics-for-racing-sailors/
- SailGP, expediting the learning process — https://www.sailingscuttlebutt.com/2019/05/06/sailgp-expediting-the-learning-process/
- Two-boat testing — https://sailzing.com/two-boat-testing/ and https://www.sailingworld.com/how-to/speed-test-your-way-to-the-top/
- Teamworks AMS — https://intuitionlabs.ai/software/sports-medicine-athletic-training/team-and-athlete-management/teamworks-ams
- Kitman Labs — https://www.kitmanlabs.com/platform/sports-data-integration-api/
