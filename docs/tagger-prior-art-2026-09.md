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

---

# Part 2 — merging auto detections with manual tags

The goal is to automate as much as possible: tacks, gybes, starts, top and bottom
mark roundings detected from the data, with the crew's manual tags reconciled
against them. This part is about the reconciliation, which is the hard half.

## 10. What SSA already detects

Worth stating plainly, because the tagger should consume this rather than
re-implement it:

| Detection | Where | How |
| --- | --- | --- |
| Tacks / gybes | `src/lib/manoeuvres.ts` | event file's `<tackjibe>` first; **TWA sign flips above 6 kn BSP** as the fallback (`detectFromLog`), 20 s debounce, upwind-both-sides → tack, downwind-both-sides → gybe |
| Manoeuvre KPIs | `src/lib/manoeuvres.ts` | BSP before/after, time to 95 %, turn angle, distance lost, max rotation — fitted against KND's own tables |
| Mark roundings | `src/lib/xmlEventParse.js` | event file's `<markrounding>`, `istopmark` → top vs leeward gate |
| Race starts | `src/lib/xmlEventParse.js` | `RaceStartGun` events |
| Start quality | `src/lib/startAnalysis.ts` | distance-to-line, run-in, OCS bands |
| Phases | `src/lib/xmlEventParse.js` + `phaseStats.ts` | event file's 30 s `<phase>` blocks |

**The gaps**: mark roundings and race starts exist ONLY if the event file has
them. There is no log-based mark-rounding detector (sustained heading change +
proximity), no log-based start detection (the line is known from
`startLines` — a distance-to-line zero crossing at the gun is derivable), and no
leg detection from true wind direction. Njord names TWD as "the key that unlocks
leg detection, manoeuvre analysis and VMG", and a published technique for leg
boundaries is principal-axis projection of the track plus reversal detection.

## 11. The human's job is VERIFICATION, not creation

The consistent finding across every mature annotation platform (CVAT, Label
Studio) is that AI-assisted pre-annotation "shifts the human task from creation
to verification" — predictions are rendered as *editable regions*, and the
operator's work is accepting, correcting and rejecting them.

This is the frame for the whole tagger: the detections are a **proposal layer**.
The crew's job is to confirm, nudge, reject and add what the detector missed.

## 12. Snap-to-event: snap BACKWARDS, not to the nearest

The single most useful primary source found. US 8,805,929 ("Event-driven
annotation techniques") describes a *snap-to-event manager* that

> selects an event from detected events that is of the user-specified type and
> occurs **prior to and closest to** the time associated with the signal received
> from the annotating interface

Two details matter enormously and are easy to get wrong:

1. **Direction.** Snap to the detection *before* the click, not the nearest in
   either direction. A human always presses late — they have to see the thing,
   recognise it, and find the button. Reaction-time literature makes the same
   point: using "nearest" can pair a stimulus with a key press that happened
   *before* it, which is causally impossible.
2. **Anchor.** A detection is a window, not an instant. The snap can target its
   start, middle or end, and which one is right depends on the tag ("tack" wants
   the entry; "recovered" wants the exit).

So the snap window is **asymmetric**: generous backwards (the crew press late),
tight forwards (they only click early when scrubbing a recording).

## 13. Snapping conventions to inherit from editors

Final Cut Pro, DaVinci Resolve, Vegas and the DAWs have converged on a set of
behaviours people already know:

- **A snap radius.** Outside it, nothing snaps — the human meant something else.
- **Visual feedback.** A line showing exactly what is being snapped to, drawn as
  you drag.
- **Hold a key to suspend snapping** (Shift in Vegas, N in Resolve) so precise
  placement is always available without a trip to a settings menu.
- **Tab to transient** (Pro Tools, Cakewalk): a keyboard shortcut that jumps the
  cursor to the next/previous *detected* feature. For SSA: jump to the next
  manoeuvre, mark or phase edge.
- **Quantize strength / iterative quantize.** Partial snap — 50 % strength moves a
  note 40 ms late to 20 ms late — repeatable until it sits right. This matters for
  a *bulk* "tidy every tag in this race": full-strength bulk snapping yanks
  outliers across the timeline, whereas partial strength converges safely.

## 14. Refining vs substituting overrides

From the Collaborative Human-Agent Protocol work, a distinction that turns out to
be exactly the right taxonomy for tag edits:

- a **refining override** reaches the right decision the wrong way — the detector
  found a real tack, the human moves it 4 s. Keep the detection, adjust it.
- a **substituting override** reaches a different decision — the detector's "tack"
  was a luff. Suppress it.

And the recommendation for what an override should persist: *the base snapshot,
the structured diff, the resulting artefact, the reviewer, the rationale, and the
timestamp.* For SSA that is: `auto_t0` (where the detector put it), `t0` (where it
sits now), who moved it, when, and why.

## 15. A rejected detection must stay rejected — tombstones

The corollary nobody writes down but everyone needs: if a human deletes an auto
tag and the detector runs again, the tag must not come back. Deleting an auto row
has to leave a **tombstone** keyed to the detection's identity, which the next
derivation consults before inserting.

Without it the crew fight the tool, and stop trusting it — the exact failure mode
`src/lib/localStore.js` already documents for video tags, where an over-eager
auto-tag detector "quietly wiped" manual tags on every enrich pass "so tag edits
never persisted across refreshes".

## 16. Identity must be stable under re-derivation

This is the mechanical prerequisite for everything above, and SSA currently has a
hazard here. `src/lib/timeline/buildNodes.ts` builds node ids as

```
nid(boatId, date, 'race', raceNum, kind, x.utc)   // ← the millisecond is IN the id
```

and `/api/teams/[teamId]/timeline` upserts on that id. So a re-parse that shifts
timings at all — a corrected timezone offset, a re-exported event file, the log
fallback standing in for the event file — mints a NEW id for the same physical
manoeuvre. The old row is not updated and not removed; it is orphaned, and the
day quietly accumulates duplicate tacks.

Identity for a detection therefore has to be **ordinal, not temporal**:
`boat:date:race2:tack:3` — "the third tack of race 2" — which survives the
detector moving it by a second. Time becomes an attribute, not the key.

## 17. Triage by confidence

Semi-automated scoring in polysomnography is reported to reduce scoring time
while maintaining or improving agreement with expert consensus specifically by
"allowing clinicians to focus on difficult or ambiguous segments".

So detections should carry a confidence, and the review UI should sort by it: a
clean 95°-turn tack with a textbook speed trace needs no human; a 40° wobble at
5 kn in a gap in the log is what the crew should be looking at.

## 18. Forced alignment is the general form of the nudge

Speech forced alignment (Montreal Forced Aligner and successors) solves: *given a
known sequence of labels and a signal, find the optimal time boundaries*, via
Viterbi/dynamic programming over frame-level probabilities, optionally with
boundary probabilities folded in to sharpen the edges.

The single-tag nudge is the greedy, one-label case of this. The bulk case — "align
every tag in this race to the data" — is the real thing: a human tag sequence
(start, tack, tack, topmark, gybe, gate) against a detection sequence, aligned
globally rather than each tag grabbing its own nearest candidate independently.
Global alignment cannot produce the crossings and double-bookings that greedy
per-tag snapping can.

## 19. The nudge, concretely

```
snapTag(tag, detections, opts)
  candidates = detections
      .filter(kind compatible with tag)             // tack tag ↔ tack detection
      .filter(t0 - backMs <= d.t <= t0 + fwdMs)     // ASYMMETRIC: back 30 s, fwd 5 s
  if empty  -> do nothing, and SAY why ("no tack found within 30 s")
  score     = kindMatch·w1 + recencyBefore·w2 + detectorConfidence·w3
  best      = argmax score
  Δ         = anchor(best, tag.anchorPref) - tag.t0
  move t0 by Δ; for a range tag move t1 by Δ too (preserve duration),
      unless both edges have their own candidates, in which case snap each edge
  record    { auto_t0: best.t, snapped_by, snapped_at, detection_id, method }
```

Range tags snap each edge to a *boundary* (manoeuvre entry/exit, phase edge, leg
edge), not to a point; a "line-up" range wants its edges on the straight-line
segment, not on the tack that started it.

## 20. Where this lands against Njord and KND

Read only from public material, so treat as the shape of the gap rather than a
feature-by-feature audit:

- **Njord Analytics** automates the timeline well — legs colour-coded, tacks and
  gybes marked, races and legs labelled and detected with no configuration. Its
  *human* layer is comments: "your own on-water comments appear as markers", with
  a comment view in the Player as a "debrief storyline". Rich detection, thin and
  ungoverned annotation.
- **KND SailingPerf** automates phases through LogCleaner → RaceReplay, and is the
  reference for phase-based reporting (SSA already reproduces its tables). It is a
  desktop analyst pipeline, not a crew-facing tagging surface.

Neither appears to offer what this tagger is for: a **governed, multi-user
annotation layer** — role- and section-scoped, with personal notes that stay
private — that is *merged* with the detections rather than sitting beside them.
The step up is not better detection. It is that a bowman's tag, a coach's tag and
the detector's tack end up on one reconciled timeline, with provenance, and the
whole thing exports.
