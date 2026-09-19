# Dinghy / GPS-only SSA — prior art, and how to get TWD out of a track

Research behind the decision to adapt SSA for Olympic dinghy and keelboat classes
that carry **a GPS tracker and nothing else**.

Three questions, answered in order:

1. Who already does this, how well, and what is left unserved? (§1–§4)
2. How do you derive TWD from a bare track, and how accurately? (§5–§9)
3. Should TWD and TWS come from *different* sources, as Njord does? (§11–§13)

Sources at the bottom. Several vendor pages are marketing copy with no technical
detail; where a finding rests on a search summary rather than a primary page it
is marked *(unverified)*. Two primary sources refused the build environment
(Wiley, the SAP wiki `concepts/` namespace — 401/403) and are marked as such.

---

## 1. Why this is a different product, not a setting

SSA today assumes the Northstar 76: an Expedition log with `twa`, `tws`, `twd`,
`bsp`, `awa`, `heel`, rudder, forestay load, lidar sail shape, plus a KND event
file whose `<phase>` elements pre-segment the day into 30 s steady-state chunks.
Look at what the core modules actually consume:

| module | depends on |
|---|---|
| `phaseStats.ts` | event-file `<phase>` list, `twa` sign for tack, polar |
| `manoeuvres.ts` | TWA sign flips, `bsp`, heading, `tws` |
| `startAnalysis.ts` | `twd` at the gun (line bias, `twdAtGun`) |
| `buildPhases.ts` / `phasePlot.ts` | mode from `<sailingmode>` |

A dinghy tracker gives you `lat`, `lon`, `sog`, `cog` — and, on a Vakaros or
Sailmon, `hdg`, heel and pitch. **Every single one of those modules' inputs is
missing.** There is no polar, no event file, no phases, no sails to name.

The structurally right move is therefore *not* to fork the analysis. It is to
insert a **synthesis layer** that manufactures the missing channels —
`twd`, `tws`, `twa`, and a phase list — from the track, writes them into the
existing `LogRow` shape (`{ utc } & Record<string, number|null>`, already open),
and lets everything downstream run unchanged. TWD is the linchpin: get it, and
`twa` follows, and with `twa` the existing mode classification, manoeuvre
detection, VMG, start-line bias and phase stats all come back to life.

That is why the TWD requirement is the whole project, not a feature of it.

---

## 2. The landscape

### 2a. GPS-first analytics for dinghies — the direct competitors

| tool | origin | data in | wind from track? | video | notable |
|---|---|---|---|---|---|
| **kTool** | HU, web | GPX, instrument logs, wind files, video | **yes**, stated as a headline feature | multi-angle sync | also has a **Sail Shape Analyzer** from photos — overlaps SailScan |
| **SailViewer** (IB-Sailing) | web/app | "GPS logs from any device", incl. Android phones | not stated | not stated | "used by Olympic teams around the world"; 2-month free trial |
| **Vantage** | iOS/Android/macOS | Vakaros, Sailmon, Garmin, Polar, Suunto, GPX, own GPS | **yes** — "true wind from GPS", ML-based *(unverified)* | telemetry overlay | Free / €-equiv $119.99 yr PRO / $179.99 yr Coach; 80+ classes |
| **Kinetix AI** | IL (Tel Aviv, f. 2020) | GPS tracker + GoPro | not stated | **auto-cuts key moments into clips** | built during an Olympic 49er campaign; from ~$420/yr |
| **SailSync** | web | phone, Garmin, Vakaros, Strava, Velocitek, Sailmon | "wind & speed analysis" | video + transcribed audio | "FLO" AI assistant; $20.99–62.99/mo coach tiers; 3D replay |
| **OutSail.pro** | EU, web | GPX + native Vakaros/Sailmon/Velocitek/Sailteck/Expedition | "wind shift tracking" | replay sync | free tier; €15/mo, €60/mo pro, €3,000/yr club; A-Cat beta 2026 |
| **RaceAnalyser** (Kinetic Labs) | desktop + web | Vakaros RaceSense live + `.vkx` | **yes** — "derived from fleet tacks and gybes, no instruments needed" | no | PDF debriefs, "Pro Regatta Coach" NL Q&A; beta expires 30 Oct 2026 |
| **ChartedSails** | web | GPX, Velocitek, Vakaros, GoPro, Garmin/Apple watch | **partly** — detects from track shape, but the documented workflow is *manual*: rotate the compass until wind is up | GoPro GPS extraction | seeds a baseline from fetched weather data |
| **Fastrrr** | HU | own sensors + Vakaros | not stated | — | Dinghy Edition / CoachBoat Pro / DataBay |
| **Tactiqs** | iOS | phone sensors + NMEA | tracks point of sail + shifts | — | 52 metrics, AR sunglasses display |

### 2b. Fleet/event tracking platforms (wind from the *fleet*)

| tool | wind method | claimed accuracy |
|---|---|---|
| **RaceQs** | met data as prior, then a **rule-based** refinement on tacking/gybing angles and course shifts while close-hauled | **3–5° single boat; ~1° with 5+ boats** |
| **SAP Sailing Analytics** / Eclipse Azimuth | **maneuver-based wind estimation** with trained ML regressors (duration-based and distance-based, on TWD-delta measures); open-sourced Apache 2.0, Oct 2025 | not published |
| **TackTracker** | "automatically estimates wind direction when analysing races", used to place sails, classify legs, compute VMG | not published |
| **TracTrac** | position/SOG/COG feed; wind comes from sensors, not the tracks | — |
| Kattack, SailRacer, GeoRacing | replay-grade | — |

**RaceQs' numbers are the most useful public benchmark in the whole field**:
3–5° from one boat, ~1° from five. That is the bar. Note the second number — the
fleet is not a nice-to-have, it is a 3–5× accuracy multiplier.

**SAP going open source (Apache 2.0, 67k+ commits, Java/GWT) is the single
biggest gift here.** Their `com.sap.sailing.windestimation` bundle is the only
production maneuver-based wind estimator whose source you can read. Worth a day
of someone's time before writing a line of our own.

### 2c. Instrument-platform analytics (SSA's current neighbourhood)

**Njord Analytics** — "whatever instrument system or tracker your boat runs",
auto-detects races and legs, builds a season database; **Njord Player** puts
every camera angle and data channel on one timeline for the debrief, team views
it in a browser while the coach builds it. Olympic dinghies listed alongside
TP52/Maxi72/RC44. Pay-per-sailing-day or flat monthly. *This is the closest
thing to SSA's debrief ambition, and it already claims Olympic coaches.*

**Expedition / KND** — where SSA lives now. Irrelevant to a boat with no
instruments.

### 2d. Hardware the athletes actually have

| device | logs | notes |
|---|---|---|
| **Vakaros Atlas 2** | 25 Hz L1+L5 dual-band GNSS, 3-axis mag/gyro/accel | compass to 0.1°; pairs with a solar ultrasonic masthead wind sensor for real TWD/TWA |
| **Vakaros Atlas Edge** | same sensor suite, cut-down feature set, $749 | **built for dinghies**; explicitly *no* wind-sensor support on a rotating mast |
| **Sailmon MAX / Element** | GPS + display + cloud | header/lift vs start-line wind direction; 3-minute wind plot; "wind from coaches or other close wind sources" |
| **Velocitek ProStart / SpeedPuck** | GPS | **shift tracking**: locks the mean heading, shows deviation as a bar, auto-resets on a detected tack — the single-tack half of the algorithm in §6c, in firmware since 2010 |
| phone / Garmin / Apple Watch | 1 Hz GPX | free; dunking risk |
| **GoPro 5+** | embedded GPS in the video | ChartedSails extracts it locally — one device for track *and* footage |

The **`.vkx` format is openly published** by Vakaros on GitHub. Record 0x02 is
position + SOG (m/s) + **COG (radians)** + altitude + an **orientation
quaternion** — i.e. heel, pitch and heading are all recoverable. There are also
records for declination (0x03), race timer (0x04), line position (0x05), a
"shift angle" record (0x06: tack heading in degrees + speed in knots), wind
(0x0A) and speed-through-water (0x0B) if sensors are attached. A .NET reference
parser exists in the wild (`SCarlsen7757/Vakaros.Vkx.Parser.NET`). **Note: no
licence file on the Vakaros repo** — check before vendoring anything.

That quaternion matters enormously for §6: **heading is the difference between a
hard problem and an easy one.**

---

## 3. Class rules — the constraint nobody's marketing mentions

This shapes the product more than any feature decision.

- **ILCA**: electronic and digital compasses are **prohibited**. A compass or
  timing device "shall not be capable of displaying, delivering, transmitting,
  receiving, calculating, correlating or storing information about wind speed,
  wind direction, boat speed or boat position." A wrist-worn timing device with
  a non-GPS electronic compass is the exception. **A GPS logger is not class
  legal while racing.**
- **iQFOiL / Formula Kite**: personal GPS devices and recording equipment are
  **permitted when the NoR or SIs allow it**.
- **49er / 49erFX / Nacra 17 / 470**: governed by class rules plus the event's
  NoR/SI; events routinely *issue* trackers (the Nacra 17 Europeans required
  boats to carry event GPS units collected each morning).
- **RRS 41** (2025–2028) is about *outside help*, not onboard kit — equipment
  restrictions live in class rules. But 41(c) "information freely available to
  all boats" is what makes organiser-supplied fleet tracking legal.

Vakaros built **Class Compliance** profiles precisely for this: features
(GPS input, distance-to-line, even magnetic heading) can be individually
disabled, the device shows only what the class permits **while still logging the
full session in the background**, and the log carries a locked record of which
profile was active so a measurer can verify it. Several classes' measurers
verify the profiles.

**Product consequence, and it is a big one:** for several Olympic classes the
data model is *training-first*. Own-boat high-rate logging in training; racing
data arrives later and from a different source — the event's tracker (TracTrac,
SAP, RaceQs) at 1–5 Hz for the whole fleet. SSA needs **both ingestion paths**,
and the fleet path is not an afterthought: §2b says it is where the wind
accuracy comes from. The existing `docs/tractrac-integration-research.md` is
therefore not a side quest — it is on the critical path for the dinghy product.

---

## 4. What is actually unserved

The GPS-analytics space is crowded and converging fast: everyone does maneuver
detection, VMG, replay, and increasingly video sync and an AI chat layer.
Competing on "analyse my track" is competing on a commodity. Honest read:

- **kTool is the closest competitor to SSA's full shape** — wind from GPS,
  video sync, *and* sail shape from photos. It overlaps SailScan directly.
  Pricing page says "coming soon", so it is early. Worth watching closely.
- **Njord owns the credible Olympic-coach debrief story** on the instrument side.
- **RaceAnalyser** has the best-stated wind method and a principle worth
  stealing verbatim: *"honest data — marks unmeasured segments rather than
  inventing numbers."* For a derived-TWD product this is not a nicety, it is the
  difference between a tool a coach trusts and one they don't.

What none of them appear to combine, and what SSA already has parts of:

1. **Weather depth** — SSA's forecast deck, 3D wind field, MOS, windweight,
   venue knowledge. The GPS tools all treat wind as a per-session scalar. For an
   Olympic campaign the venue model *is* the product.
2. **Media as a first-class citizen** — photos, video, drone, speed-team
   compilations and documents, shared across a squad. Kinetix does video;
   nobody does the day's whole media record.
3. **Campaign continuity** — SSA's campaign spine, session→event→season. The
   competitors are session tools.
4. **Squad-level training-group analysis** — 3–6 boats of the *same* team
   training together is the Olympic reality, and it is also (§5) where TWD
   accuracy jumps from 3–5° to ~1°. Nobody is selling that as the headline.

The defensible position is therefore: **the venue + the squad + the whole day's
record**, with track analysis as table stakes. Not "another tracker app".

---

## 5. TWD from a track — framing the problem

Everything below assumes: position at 1–25 Hz, SOG, COG, optionally heading and
heel, no wind sensor, no speed-through-water, no polar to start with.

### What you are really solving

The observable is velocity **over ground**:

```
V_ground  =  V_water(TWA, TWS)  +  C
```

`C` is the tidal/current vector. The sailor chooses TWA; the boat's polar maps
(TWA, TWS) → speed through water. You want TWD, and TWD only enters through the
*rotation* of `V_water` into the earth frame.

Three unknowns hide behind one observation: **what the wind is doing, what the
water is doing, and what the sailor chose to do.** Every method below is a
different way of breaking that three-way ambiguity.

### Why this is harder than the forum answer

The standard answer — "average your two close-hauled headings" — fails in four
specific ways, and each one is worth a named mitigation:

1. **It needs heading, and you have COG.** They differ by leeway plus current
   crab. On an ILCA upwind that is several degrees of leeway alone.
2. **Cross-wind current rotates the bisector** (§6e — with a formula and a
   number). This is the dominant error and it is *systematic*, not noise.
3. **TWD is not constant.** Oscillations of 5–10° on 3–8 minute periods are the
   entire tactical game. A session-mean TWD answers the wrong question.
4. **Tacks are sparse.** One every 1–3 minutes upwind, none at all down a run.
   A tack-only method has terrible temporal resolution exactly where you need it.

---

## 6. The method ladder

Build these in order. Each is useful on its own and each feeds the next.

### L0 — Priors: model, marks, committee

Free, and they bound everything else.

- **Weather model.** SSA already fetches and stores this. ChartedSails does
  exactly this as a baseline and RaceQs seeds its algorithm from met data before
  refining. Gives TWD to maybe ±15–20° inshore — useless tactically, invaluable
  as a prior that resolves the 180° ambiguity and catches gross failures.
- **Course geometry.** A race committee sets the windward mark square. The
  start-line normal and the leg bearing are both TWD estimates to ~±5–10°.
  Mark positions can be recovered from rounding patterns — RaceQs claims **~95%
  from one boat, ~99% from several**, plus a static-mark database. SSA would
  derive them from the track's turn clusters.
- **Coach boat.** The highest-value cheap upgrade in the whole project: an
  ultrasonic anemometer on the RIB (Calypso portable, or the Vakaros solar
  masthead unit on a pole) logging alongside its own GPS. Subtract the RIB's
  motion vector and you have *measured* TWD to feed in as truth. This is what
  the pro teams do, and it doubles as the validation set for §8.

### L1 — Tack-pair bisector

The baseline. For each detected tack, take a steady-state window before and
after (SSA's `manoeuvres.ts` already uses −40…−10 s and +17…+23 s windows for
the N76 — same idea, retuned), and bisect.

Refinements that matter:
- Bisect **headings** if you have them (Vakaros quaternion), COG otherwise.
- Use the **circular** mean — `startAnalysis.ts` already has `circularMean`.
- Weight by steadiness: reject windows containing a gust response, a wave set,
  a big heel excursion, or a second manoeuvre inside the settle time (SSA
  already has `shortHitch` for this).
- Reject any window whose speed is below a fraction of the running best for the
  conditions — a pinching or stalled boat lies about its angle.

Expected: **3–5°**, matching RaceQs' single-boat claim, and biased by current.

### L2 — Steady-segment fitting, not just tack pairs

Better: segment the whole track into straight-line steady runs, classify each as
upwind/reach/downwind, and fit a TWD that makes the population of upwind COGs
bimodal and symmetric. This uses every second on the beat, not just the two
windows either side of a tack, and it copes with legs where the boat tacked once.

This is where the **chicken-and-egg** bites: you need TWD to classify point of
sail, and point of sail to estimate TWD. Solve it as **EM**: initialise from L0,
classify, re-fit, re-classify, iterate. It converges quickly in practice because
upwind COG distributions are sharply bimodal. `mkobetic/gpx` takes the same
shape — segment into moving/turning/static, then analyse the moving segments —
and notably *warns and skips* the analysis when the determination fails rather
than guessing. Steal that behaviour.

### L3 — Single-tack shift tracking (the high-rate channel)

L1/L2 give you **absolute** TWD at sparse times. Between tacks, hold the TWA
estimate fixed and read COG deviation directly as a wind shift. This is exactly
what the Velocitek SpeedPuck/ProStart shift tracker does in firmware — lock the
mean heading, display deviation, auto-reset on a detected tack — and what
Sailmon exposes as header/lift against the start-line wind direction.

The failure mode is that a COG change might be the *sailor*, not the wind. **Use
SOG as the discriminator:**

| COG | SOG | reading |
|---|---|---|
| up (toward the wind) | steady or up | **lift** |
| up | down | **pinching** — sailor, not wind |
| down | up | **header**, or footing for a gust |
| down | steady | header |

Fuse: L1/L2 as sparse absolute anchors, L3 as the high-rate relative signal
between them. That combination is what produces a usable TWD(t) trace at the
resolution the tactical debrief actually needs.

### L4 — Joint polar-constrained solve for wind **and** current

The one that actually fixes the systematic error. Unknowns: `TWD`, `TWS`,
`C_x`, `C_y` — four. Each steady segment on a known tack contributes two
equations (the two components of `V_ground`). If you assume the sailor sails the
polar's target VMG angle, then `TWA* = f(TWS)` and the segment adds **no new
unknowns**: two opposite-tack segments give four equations in four unknowns,
exactly determined. Relax the target-angle assumption and let TWA float per
segment with a prior, and each segment adds one unknown for two equations — so
four or more segments, over-determined, least squares.

Downwind segments help disproportionately: gybe angles differ from tack angles,
which breaks degeneracies that upwind-only data leaves.

**The key structural insight:** `TWD` varies on a 3–8 minute timescale; `C`
varies on an hours timescale and is near-constant over a training session. So
run it as a state-space model — a random walk with **high process noise on TWD,
near-zero on `C`** — and pool the whole session. Current becomes strongly
observable from the session as a whole, and once `C` is pinned down, *every
individual tack pair yields a clean, unbiased TWD*.

This is, as far as I can tell from the public material, **not what any of the
competitors do**. RaceQs says its VMG "incorporates current effects" without
claiming to solve for the current vector; everyone else is silent. It is the
one place where SSA could be genuinely better rather than equal.

Independent cross-check when heading is available: with `hdg` from the Vakaros
quaternion, `COG − HDG` is leeway + current crab directly. Two routes to `C`
that must agree is a strong internal consistency test.

### L5 — Pool the fleet / the training group

RaceQs: **3–5° → ~1°** going from one boat to five. Three effects stack:
averaging independent errors; different boats tacking at different times giving
denser temporal sampling; and boats spread across the course letting you fit a
*spatial* field rather than a single number.

For a national squad this is free — they already train 3–6 boats together. Pool
every boat's L2 segments into one estimator, and for a regatta pull the event
tracker's whole fleet.

The spatial step (kriging / Gaussian-process regression over the course, as used
for aircraft-derived wind fields) is the natural extension and answers the
question coaches actually ask — *which side had more?* — rather than just *what
was the mean wind?* This is a phase-2 item but it is where the fleet data really
pays.

### L6 — Learned models

Two references:
- **SAP** trains regressors for maneuver-based wind estimation, on both
  duration-based and distance-based features of TWD-delta measures (std dev,
  mean). Their training pipeline is two-stage, wants ≥100 GB and 24+ hours on
  16 GB RAM. Open source.
- **`neil-marcellini/ml-wind-estimator`** — a PyTorch model for exactly this
  problem, stated goal "accurate wind direction estimate at each point, live VMG,
  and segmenting tracks without recording wind data." Small, but it is the
  hobbyist proof that the supervised framing works. *(README beyond the summary
  line was not retrievable; the architecture is in `net.py`.)*
- Adjacent literature: **MoWe** (Sun et al., *J. Field Robotics* 2025) —
  motion-observation wind estimation for sailing robots, combining a
  motion-analysis component with a data-driven one *(paper behind a 403;
  method summary from search results only)*. LSTM-on-roll-and-pitch is the
  recurring architecture in the quadrotor analogue.

**Do not start here.** ML is the right layer once there is a labelled corpus —
and the corpus comes from L0's coach-boat anemometer plus the squad's own
sessions. Physics first, learning as the residual correction.

---

## 7. The current-bias formula

Worth writing down because it sets the whole error budget.

Take symmetric upwind TWA, speed through water `V`, and a current with component
`c⊥` perpendicular to the wind axis. The bisector of the two ground tracks is
rotated away from true TWD by:

```
bias  ≈  (c⊥ · cos TWA) / V      radians
      ≈  57.3 · c⊥ · cos TWA / V  degrees
```

Numbers:

| boat | V (kn) | TWA | c⊥ = 0.5 kn | c⊥ = 1.0 kn |
|---|---|---|---|---|
| 49er upwind | 6.0 | 42° | **3.6°** | 7.2° |
| ILCA upwind | 4.5 | 45° | **4.5°** | 9.2° |
| 470 upwind | 5.0 | 43° | **4.2°** | 8.5° |

(Exact, from the two-tack geometry; the formula above is the small-`c`
linearisation and is within 0.2° of exact out to 1 kn.)

Half a knot of cross-wind tide puts 3.5–4.5° of *systematic* error into TWD —
comparable to the entire oscillation amplitude you are trying to measure. In
Marseille, Weymouth, Hyères or the Solent this is not a rounding error, it is
the answer.

Two further consequences:
- A current component **along** the wind axis does **not** rotate the bisector.
  It changes the apparent tack angle instead — so it corrupts your *TWS* and
  polar estimate, not your TWD. Useful: the two error modes are separable.
- Which means an L1 bisector is unbiased in TWD when the tide runs straight up
  or down the course, and worst when it runs across. Worth surfacing in the UI
  as a confidence modifier rather than hiding it.

---

## 8. Validation — do not ship this unvalidated

The one thing that will sink a derived-TWD feature with an Olympic coach is
being confidently wrong once. Plan:

1. **Ground truth**: a coach-boat ultrasonic anemometer + GPS, motion-corrected.
   One RIB, one afternoon, and you have a labelled day.
2. **Cross-source**: SSA's own forecast/MOS stack as a sanity bound; the
   committee's recorded wind at a regatta; the event tracker's fleet-derived
   wind if TracTrac/SAP supply one.
3. **Self-consistency**: TWA distribution symmetry between tacks after the fit;
   L4's two independent routes to `C` agreeing; estimated TWS against the polar
   the same data implies.
4. **Report the band, always.** Per-segment confidence, and an explicit
   *"unmeasured"* state where the estimate fails. RaceAnalyser's "honest data"
   principle, and `mkobetic/gpx`'s warn-and-skip, both get this right. A derived
   number that does not carry its uncertainty is worse than no number in a
   debrief, because it gets argued about.

Target to beat, stated publicly by a competitor: **3–5° single boat, ~1° with a
fleet of five.** If SSA's L4 current-corrected estimator does not beat 3–5° on a
tidal venue, it has not earned its complexity.

---

## 9. What this implies for the SSA codebase

**Architecture** — synthesis layer, not a fork:

```
tracker file (.vkx / GPX / Sailmon CSV / TracTrac)
      ↓  new parsers alongside logParse / flatLogParse / csvLogParse
LogRow[] { utc, lat, lon, sog, cog, [hdg, heel, pitch] }
      ↓  NEW: src/lib/wind/segment.ts   — steady/turn/static segmentation
      ↓  NEW: src/lib/wind/estimate.ts  — L0→L4 ladder, returns twd/tws + confidence
LogRow[] + { twd, tws, twa, bsp← sog }   ← existing channel names, unchanged
      ↓
phaseStats · manoeuvres · startAnalysis · phasePlot   (unchanged)
```

Concrete consequences, in dependency order:

1. **Phases must be derived.** There is no KND event file. The steady-state
   segmenter from L2 *is* the phase builder — `buildPhases.ts` gains a
   track-derived source. This is a prerequisite for wind estimation, and wind
   estimation is a prerequisite for classifying the phases. Build it as the EM
   loop described in L2; do not try to do them separately.
2. **Polars must be learned, not loaded.** No dinghy class ships a polar.
   Bootstrap from published class target angles, then refine from the boat's own
   data once TWD is stable — another EM loop, and one that gets better across a
   season. `polarCalc` needs a "learned polar" provenance flag so nothing
   downstream mistakes an inferred polar for a measured one.
3. **`bsp` becomes `sog`.** Legitimate for a dinghy with no paddlewheel, but it
   means every existing "boat speed" metric silently becomes speed over ground
   and inherits the current. Needs to be explicit in the data model, not a
   coincidence of naming — this is exactly the class of trap CLAUDE.md exists to
   record.
4. **`manoeuvres.ts` mostly survives.** It already has a TWA-sign-flip fallback
   path for when the event file is absent. The KND-fitted windows and the
   `minBsp: 6 kn` floor are N76 numbers and need per-class retuning.
5. **Confidence has to reach the UI.** Every derived channel needs a
   provenance + uncertainty pair carried alongside it, and the charts need an
   "unmeasured" rendering. Retrofitting this later will be painful; the
   `LogRow` shape is open enough to carry it from the start.
6. **Fleet ingestion is on the critical path**, not optional (§3, §5-L5).
   The TracTrac research already done is the other half of this product.
7. **`.vkx` first.** It is the open format, the Atlas Edge is the dinghy device
   at $749, and the quaternion gives heading — which is what makes L4's
   cross-check possible. GPX second as the universal fallback.

**Before writing the estimator**: read SAP's `com.sap.sailing.windestimation`
bundle (Apache 2.0). It is the only production implementation of maneuver-based
wind estimation with readable source, and a day spent there is cheaper than a
week of rediscovery.

---

## 10. Open questions

- Does kTool's "wind direction from GPS track" handle current? Their sail-shape
  overlap with SailScan makes them the competitor to evaluate properly — sign up
  for the free tier and test it on a known tidal day.
- Can we get the SAP wiki `concepts/windestimation` page? It 401'd from here;
  the `howto/` page is public and describes only model *training*, not the method.
- What do the Dutch/other squads currently use, and what do they complain about?
  This whole doc is desk research — one hour with a squad coach beats all of it.
- Licence on `vakaros/vkx` — the repo has none. Ask before vendoring.
- Is per-boat wind estimation even the right unit for a squad, or should the
  primitive be a **course wind field** with per-boat observations feeding it?
  §5-L5 argues the latter; that is a bigger architectural commitment and worth
  deciding early rather than refactoring into.

---

## Sources

Tools and platforms:
- [Njord Analytics](https://www.sailnjord.com/) · [Sailmon data source page](https://www.sailnjord.com/data-sources/sailmon/)
- [Vantage](https://www.vantage-sailing.com/) · [pricing](https://www.vantage-sailing.com/pricing)
- [kTool](https://ktool.hu/)
- [SailViewer / IB-Sailing](https://ib-sailing.com/sailviewer-app/)
- [Kinetix AI FAQ](https://kinetix-ai.com/faqs/) · [Sailing World: Kinetix, The Debrief Game-Changer](https://www.sailingworld.com/racing/sailing-performance-analysis-with-kinetix/)
- [SailSync](https://www.sailsync.ai/)
- [OutSail.pro](https://outsail.pro/)
- [RaceAnalyser, Kinetic Labs](https://regatta.kinetic-labs.ai/)
- [ChartedSails — 8 ways to record GPS tracks](https://www.chartedsails.com/blog/eight-ways-to-record-gps-tracks-of-sailing-drills-and-regattas) · [ChartedSails](https://www.chartedsails.com/)
- [Fastrrr](https://www.fastrrr.com/data-sources/vakaros/)
- [Tactiqs](https://tactiqs.io/)
- [TackTracker analysis](https://tacktracker.com/web/solution/analysis)
- [SailZing — Sailboat Race Analysis](https://sailzing.com/sailboat-race-analysis/)
- [Sailing World — Where Data Meets Development](https://www.sailingworld.com/racing/where-data-meets-development/)

Wind estimation methods:
- [RaceQs — How RaceQs calculates Wind, VMG and Mark Locations](https://raceqs.com/forum/topic/how-raceqs-calculates-wind-and-vmg/)
- [SAP Sailing Analytics wiki — wind estimation model training](https://wiki.sapsailing.com/wiki/howto/windestimation)
- [SAP/sailing-analytics on GitHub](https://github.com/SAP/sailing-analytics) · [Sailing Analytics Goes Open Source](https://community.sap.com/t5/technology-blog-posts-by-sap/sailing-analytics-goes-open-source/ba-p/14268880) · [Eclipse Azimuth proposal](https://projects.eclipse.org/proposals/eclipse-azimuth-sailing-analytics)
- [neil-marcellini/ml-wind-estimator](https://github.com/neil-marcellini/ml-wind-estimator)
- [mkobetic/gpx](https://github.com/mkobetic/gpx)
- [MoWe: Motion Observation for Wind Estimation of Sailing Robots](https://onlinelibrary.wiley.com/doi/10.1002/rob.22512) *(403 — summary only)*
- [Wind velocity field estimation from aircraft derived data using Gaussian process regression](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC9621445/)
- [Performance Analysis in Olympic Sailors of the Formula Kite Class Using GPS](https://pmc.ncbi.nlm.nih.gov/articles/PMC7830054/)

Hardware and formats:
- [Vakaros Atlas 2](https://www.vakaros.com/products/atlas2) · [Atlas Edge](https://www.vakaros.com/products/atlas-edge) · [Atlas 2 on Any Boat](https://www.vakaros.com/blogs/news/atlas-2-on-any-boat) · [What is Class Compliance?](https://www.vakaros.com/blogs/news/what-is-class-compliance) · [Ultrasonic Wind Sensor](https://www.vakaros.com/products/wind)
- [vakaros/vkx — the VKX telemetry log format](https://github.com/vakaros/vkx) · [SCarlsen7757/sail-sight](https://github.com/SCarlsen7757/sail-sight)
- [Sailmon MAX](https://sailmon.com/max/) · [Header/Lift, Wind Trends and app updates for MAX](https://blog.sailmon.com/header-lift-wind-trends-and-app-updates-for-max)
- [Velocitek ProStart shift tracking](https://www.velocitek.com/blogs/news/prostart-shift-tracking) · [SpeedPuck](https://www.velocitek.com/pages/speedpuck)

Rules:
- [ILCA Class Rules](https://ilcasailing.org/rules-and-technical/ilca-class-rules/)
- [World Sailing — 2025-2028 Racing Rules of Sailing](https://www.sailing.org/document/2025-2028-racing-rules-of-sailing-july-2024/) · [RRS Part 4, other requirements when racing](https://www.racingrulesofsailing.org/rules?part_id=57)
- [World Sailing — 2026 Class Rules, iQFOiL](https://www.sailing.org/document/2022-04-01-class-rules-iqfoil) · [IKA Formula Kite](https://www.sailing.org/document/2022-01-01-class-rules-ika-formula-kite-2/)

---

# Part 3 — Decoupled wind sources

Added after reviewing Njord's **Modify Wind Direction / Speed** dialog (screenshot,
TP52 fleet, eight TracTrac boats, 11:00–16:00 GMT+0, races 10–12). Their user
guide is public and confirms what the dialog shows.

## 11. What Njord actually ships

Two **independent** dropdowns, and the option lists are not the same:

| | **Wind Direction Source** | **Wind Speed Source** |
|---|---|---|
| inferred from the track | **Inferred from typical TWA** | — *(nothing)* |
| model | Weather Data (OpenWeather Time Machine) | Weather Data (OpenWeather Time Machine) |
| manual, fixed | Constant Value | Constant Value |
| manual, time-varying | Interpolated over Time | Interpolated over Time |

Their description of the inference method, verbatim from the dialog:

> Determines typical upwind and downwind TWA from the best maneuvers; then
> assumes that straight line sailing is done at this TWA and infers TWD from the
> boat's course. This method is able to detect wind shifts between maneuvers.

That is **exactly the L1+L3 pair from §6**, shipped: calibrate a typical TWA off
the good manoeuvres, then read the course between manoeuvres as shift. The
`Initial TWD: Auto` field is the L0 seed, and their guide recommends seeding it
with **the first start-line bearing** — the course-geometry prior from §6-L0.

What their docs concede about when it fails, all of it consistent with §6:

- works best with "clean straight upwind/downwind sailing, clear tacks and
  gybes, and consistent wind"; poor in light, shifty, or reaching-dominated days
- **"performs better when multiple boats' datasets are loaded together"** — the
  fleet multiplier again, now confirmed by a second vendor
- **defining the full course (all marks) is more robust than TWA-based leg
  detection alone** — marks as hard geometric constraints
- when it drifts mid-day: shorten the time range, seed the initial TWD, or run
  **separate inferences per segment**
- a coach-boat wind file can supply TWD/TWS directly

### The asymmetry is the whole point

**TWD has an inference method. TWS has none.** That is not an oversight, and it
is not a roadmap gap — it follows from observability:

| | observable from a bare track? | available from a model? |
|---|---|---|
| **TWD** | **strongly** — it is a pure *geometry* problem. Angles are what a track is made of. | **badly** at the scale that matters. Models get the synoptic mean; the 5–10° oscillation on a 3–8 min period is entirely sub-grid. |
| **TWS** | **weakly** — needs a polar to convert speed into wind, and you have SOG not BSP. | **reasonably**. Magnitude is the thing NWP does comparatively well, albeit smoothed. |

So each channel is taken from whichever source is actually good at it. Once you
see it that way the decoupling is not a clever UI trick, it is the only
defensible design — and it generalises past two channels (§13).

### The correct name for what a track gives you

Worth fixing the vocabulary, because it makes §7 exact rather than a caveat.
Following Burch's distinction (and Expedition's, and B&G's):

- **True wind** is referenced to **the water**, computed from **STW / CTW**.
  It is what the sailor trims to, and what polars are tabulated against.
- **Ground wind** is referenced to **the ground**, computed from **SOG / COG**.
  It is what forecasts are issued in.
- They differ by exactly the current vector. Burch's Gulf Stream worked example:
  3 kn of current produced a **4° direction and 3 kn speed difference** between
  the two.

A GPS-only track therefore yields **ground wind, natively and only**. Everything
in §6-L1 through L3 estimates **GWD, not TWD**. §6-L4's joint solve for the
current vector is not an accuracy refinement bolted on the side — it *is* the
GWD → TWD conversion, and without it every "TWD" the tool prints is mislabelled.

This also explains the §7 error budget in one line: on a tidal venue, a tool
that infers wind from a track and calls the answer TWD is reporting ground wind
with a true-wind label, and the gap is the current. **Nobody in §2 appears to
name this distinction in their GPS-only path.** Getting the two labels right —
and offering both — would be a small, cheap, genuinely differentiating piece of
rigour.

## 12. The same idea, two other ways

**SAP** goes further than a dropdown. Wind is modelled as **multiple named
source tracks plus a combination**: release notes reference source types
`EXPEDITION`, `WEB`, `WINDFINDER`, `RACECOMMITTEE`, their maneuver-based
estimator, and GRIB import that "turn[s] each position into a separate wind
source, leading to better visual interpolation" — all reducible to a **COMBINED**
wind track, which is exported alongside the individual ones. Crucially,
**per-race source de-selection is persisted** and "survive[s] re-loading of the
race as well as re-starting or upgrading a server."

Three lessons there, all cheap to copy:
1. A source is a **time series**, not a setting. Several coexist.
2. The combination is **derived and inspectable**, and the inputs stay visible
   next to it. (The screenshot shows Njord doing the lightweight version of
   this: the grey existing trace under the orange preview.)
3. The curation decision — *this source is rubbish for this race* — is **data,
   and it persists**. It is not a transient UI state.

**Expedition** takes the raw sensors independently (CTW, STW, COG, SOG) and
computes TWS/TWD/**GWD** itself rather than trusting the instrument's own true
wind, with TWD offset correction on top. Its canonical calibration check is
"compare TWD when sailing at the same angle on port and starboard" — i.e. the
§6-L1 bisector, used as a *calibration residual* rather than as an estimator.
Same geometry, pointed the other way.

## 13. What this means for SSA

### 13a. SSA's model baseline is already better than Njord's

Njord's "Weather Data" is **OpenWeather Time Machine**: hourly, global,
underlying model not publicly stated. You can see the consequence in the
screenshot — the TWS trace is a 6 → 9 → 8 → 10 kn staircase of linearly
interpolated hourly points, with every puff and lull gone, sitting under a TWD
trace full of real structure.

SSA already fetches **Open-Meteo's Historical Forecast API**: hourly as standard
but **15-minutely across Central Europe and North America**, from **ICON-D2 at
2 km**, UKMO UK 2 km and HARMONIE AROME, with gusts as a separate variable —
plus SSA's own MOS bias correction and windweight layer on top.

That is a materially better TWS source than the market leader ships, **and it is
already built**. It is the least effortful differentiator in this whole document:
plug the existing weather stack in as a named wind source. (Watch the per-location
billing — a wind track along a boat's path is a sequence of positions, and
Open-Meteo bills per location; snap to a coarse grid and interpolate.)

### 13b. Prefer additive decomposition over source-picking

A dropdown makes the sources mutually exclusive. They are not — they are good at
different *frequencies*. Better:

```
TWD(t) = model_baseline(t)        ← synoptic trend, gradient, sea-breeze veer
       + track_deviation(t)       ← the oscillation, from L1/L3
       − current_correction       ← the GWD→TWD step, from L4

TWS(t) = model_baseline(t)        ← including gusts, at 15 min / 2 km
       + polar_residual(t)        ← optional, once a learned polar exists
```

The model contributes what it is good at (slow, large-scale, unbiased-ish); the
track contributes what it is good at (fast, local, relative). This also fixes
the mid-day-drift problem Njord tells users to work around by manually chopping
the time range into segments — an inferred-only TWD has no anchor and wanders,
while an additive one is pinned to the model's trend by construction.

Keep the dropdown as the manual override. Make the additive fusion the default.

### 13c. Can TWS be inferred at all? Partly — and it doesn't matter much yet

Nobody does it. Ranked by how much signal is actually there for a dinghy:

| | signal | verdict |
|---|---|---|
| S1 | model baseline | **use it** — the honest default |
| S2 | **mode transitions**: planing on/off, foiling take-off and touch-down | **strongest single-boat signal.** A sharp, class-specific threshold (iQFOiL, Nacra 17, 49er downwind). Nobody uses it. |
| S3 | tack / gybe angle vs breeze | real, class-specific, non-monotonic at the extremes |
| S4 | polar inversion from SOG | needs a learned polar *and* the current — circular until L4 lands |
| S5 | heel / trapeze-vs-hiking mode from the Vakaros quaternion | crude but free once you parse the quaternion |
| S6 | **fleet mode fraction** — what share of the fleet is planing | a soft fleet-wide anemometer; only available on the fleet path |

Verdict: **S1 now, S2 next, the rest later.** And be clear about the priority —
a TWS error mostly corrupts target-speed comparison, while a TWD error corrupts
TWA, VMG, mode classification, lift/header and start-line bias *directly*. The
engineering effort belongs in TWD and the current vector, not in squeezing TWS
out of a track.

### 13d. Architecture: a wind-source registry, not a pair of settings

Concretely, for `src/lib/wind/`:

```ts
type WindSourceKind =
  | 'model'        // SSA weather stack: Open-Meteo / MOS / windweight
  | 'inferred'     // L1–L3 from the track — produces GROUND wind
  | 'solved'       // L4 joint wind+current — produces TRUE wind + current
  | 'fleet'        // L5 pooled across the training group / event tracker
  | 'sensor'       // coach-boat anemometer, masthead unit, committee log
  | 'manual'       // constant or interpolated, the human override

interface WindTrack {
  kind: WindSourceKind
  reference: 'ground' | 'true'      // NEVER inferred — always declared
  twd?: Series; tws?: Series        // a source may supply only ONE channel
  confidence: Series                // per-sample, not per-track
  provenance: { model?: string; boats?: string[]; window?: [number, number] }
  enabled: boolean                  // persisted per session/race, SAP-style
}
```

Then a `combine(tracks) → WindTrack` that does §13b, and the existing
`LogRow` gets `twd`/`tws` written from the combined result with provenance
carried alongside.

Four design rules falling out of the research:

1. **A source supplies channels, not "wind".** Njord's two dropdowns are the
   minimum viable version of this; make it the type.
2. **`reference` is declared, never assumed.** This is the ground-vs-true trap
   in §11, and it is exactly the class of thing CLAUDE.md exists to record —
   like the local-wall-time clocks, it silently produces plausible wrong answers.
3. **Enabled/disabled per source per session, persisted.** SAP's lesson.
4. **Recompute derived channels automatically.** Njord's FAQ makes users
   manually *drop* TWA/TWS/VMG, apply a formula, then add a "Derived Metrics"
   step to recalculate — and warns that "applying a formula twice applies it
   cumulatively," with a Reset-to-uploaded-files escape hatch. That is an
   invalidation bug surfaced as a user-facing procedure. SSA should track the
   dependency graph (`twd → twa → vmg → phaseStats → manoeuvres`) and recompute
   on change. Their FAQ also notes polars are "applied at upload time only" —
   same failure, same fix.

### 13e. The batch affordance is worth copying outright

The screenshot applies one wind solution to **eight boats over a five-hour
window spanning three races** in a single action. For a squad training day —
6 boats, one wind — that is precisely the right unit of work, and it is
*also* what §5-L5 needs: the fleet is the estimator's input, so the fleet should
be the estimator's scope. Do not build this per-boat and generalise later.

## 14. Revised open questions

- Does Njord's inference return **ground wind labelled as TWD**? Their docs
  don't say, and the dialog doesn't. If so it is a real, checkable accuracy gap
  on tidal venues — and the first thing to test on a Solent or Hyères day.
- Which model does OpenWeather Time Machine actually use for wind? Not
  published as far as I can find. If it is ERA5-family at ~25 km, the gap to
  ICON-D2 at 2 km is larger than §13a implies.
- SAP's `COMBINED` wind track: what is the actual combination rule — nearest,
  weighted, confidence-based? The source is Apache 2.0, so this is readable
  rather than guessable, and it is the one published implementation of §13b.
- Does SSA's Open-Meteo budget survive per-boat wind tracks? (See the
  per-location billing note in the existing Open-Meteo memory.) Grid-snap first,
  measure second.

## Sources added for Part 3

- [Njord user guide — Adding Wind Data](https://app.sailnjord.com/help/analytics/adding-wind-data.html) · [FAQ](https://app.sailnjord.com/help/analytics/faq.html) · [Overview](https://app.sailnjord.com/help/analytics/index.html) · [Data Sources](https://www.sailnjord.com/data-sources/)
- [Njord — Using Inferred True Wind Direction (video)](https://www.youtube.com/watch?v=4fmXqN4RSlM) · [Adding Wind Data from Any Source (video)](https://www.youtube.com/watch?v=p7G7Cf0tNtY) *(not retrievable from the build environment)*
- [SAP Sailing Analytics — Admin Console release notes](https://www.sapsailing.com/release_notes_admin.html) (wind source types, COMBINED track, persisted per-race de-selection, GRIB-per-position)
- [David Burch — True Wind and Ground Wind, and Why We Need Both](http://davidburchnavigation.blogspot.com/2021/12/TW-v-GW.html) · [B&G glossary](https://www.bandg.com/glossary/)
- [Expedition manual](https://www.expeditionmarine.com/downloads/documents/Expedition.pdf) (computes TWS/TWD/GWD from raw CTW/STW/COG/SOG; TWD offset correction; port/starboard calibration)
- [Open-Meteo Historical Forecast API](https://open-meteo.com/en/docs/historical-forecast-api) (15-minutely, ICON-D2 2 km, HARMONIE AROME)
- [OpenWeather One Call 3.0 / Time Machine](https://openweathermap.org/api/one-call-3) · [History API by timestamp](https://openweathermap.org/api/history-api-timestamp)
- [Observation-driven correction of numerical weather prediction for marine winds](https://arxiv.org/html/2512.03606v1) (assimilating point observations to correct model wind — the formal version of §13b)
