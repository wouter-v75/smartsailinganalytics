# Commercialising SSA — Oct 2026 → Sep 2027

_Written 20 Sep 2026. Covers the twelve months to the end of the 2027 season,
with a go/no-go on raising at the end of it._

**Inputs this plan is built on** (stated so they can be challenged): the goal is
to build toward **raising money**; there are **2–4 programmes** on SSA today and
**none paying**; founder capacity **varies with the season** — heavy in winter,
close to zero from April to September.

---

## 0. The answer to the question you actually asked

> *Offer it cheaply to get as many teams as possible and gather data, or make it
> commercial from the start?*

**Commercial from the start. High price, small number of customers, and buy the
data with access deals rather than with a low price.**

The land-grab instinct is right in most software and wrong here, for four
reasons that are specific to SSA rather than general:

**1. The market is too small for a land grab to mean anything.** There are a few
hundred grand-prix programmes in the world and one to two thousand funded
Olympic campaigns. Winning 1,000 free users is not a beachhead — it is most of
the addressable market, monetised at zero. Volume is a strategy for markets
where volume is large; this one rewards depth and price.

**2. ~~A free user costs you real money.~~ — Retracted. The measurement says
otherwise.** This was the argument I expected to be strongest, and §5 killed it.
A real team-year costs **$15–60** to serve. A free team is close to free. The
binding marginal cost of a customer is **your time in July**, not bytes on
Bunny — which is a cap on *how many* you can serve, not on what you can afford.
It changes one thing in the other direction, and usefully: since access is
nearly free to grant, **trading access for data and a case study costs you
almost nothing**, so the §0 data strategy below is cheaper than it looked.

**3. You are not available in the season.** Cheap customers generate the most
support per euro, and they generate it in June, when you are on a boat. A free
tier you cannot service produces churned users, bad word of mouth in a small
and extremely well-connected sport, and a data set full of half-finished days.
Reputation in sailing travels through about six people; you only get to make
this impression once.

**4. For your stated goal — raising — paid beats popular.** No investor in this
sector will be moved by free users. What moves them is that a programme with a
real budget put SSA on a purchase order and renewed. Ten paying programmes at
€5k is a far stronger room than four hundred free ones, because it proves the
only thing genuinely in doubt: that this is a budget line and not a favour from
a friendly analyst.

### The part of the "gather data" instinct that is correct

The instinct is right that **the data is the asset**. It is wrong that a low
price is how you get it. Data is acquired by *contract*, not by price:

- a **data-rights clause in every paying contract** — you may use their days,
  de-identified, to train and benchmark;
- **selective free access traded explicitly for data and a case study**, granted
  to named programmes you chose, not offered publicly;
- **squad reciprocity** (already designed in `squad-sharing-design-2026-09.md`,
  the Hudl league-pool rule: you cannot pull a day unless you contributed one) —
  which acquires data *and* distributes the product;
- **public corpora** — SAP's wind-estimation bundle and its event data, TracTrac
  event files, the open `.vkx` format.

All four work at a price of €800/month. None of them requires a free tier.

### And the sequencing is a dependency, not a preference

This is the strongest argument, and it should be the first slide of any deck:

> **The instrumented boats manufacture the asset that unlocks the volume
> market.** A fully-instrumented yacht produces *measured* TWD alongside the
> same GPS track a dinghy produces. That pairing — measured wind and raw track,
> same boat, same minute, same venue — is the ground-truth training set for
> inferring wind on a boat with no instruments. SSA is the only product in the
> survey that serves both ends of the capability spectrum on one data model, so
> it is the only one that generates that pairing as a by-product of normal
> business.

So the order is forced: **sell to instrumented programmes first, at a high
price; use what they generate to make the GPS-only path actually good; then go
wide on dinghies in year two, when going wide is cheap to serve and defensible.**
Going wide first means going wide with a wind model no better than the free
tools already shipping — competing on price, from behind, with no moat.

**Cheap-and-wide is year two, and it is earned, not chosen.**

---

## 1. Who buys, and what they are actually buying

| buyer | what they are replacing | budget reality | ACV band |
|---|---|---|---|
| **Grand-prix programme** (Northstar-class, TP52, Maxi) | a freelance performance analyst's days, plus a folder of unwatched GoPro | six figures a season; €10k is a rounding error | €6–15k |
| **Olympic squad / national federation** | nothing coherent — a coach's laptop, WhatsApp, Vantage on a phone | funded, and peaking through LA28 qualification | €2.5–6k |
| **Class association / event** | nothing | thin, but buys credibility and distribution | €2–5k, or free for reach |
| **Individual coach** | Vantage Coach ($180/yr), SailSync ($21–63/mo) | own pocket | €600–1,200 |
| **Individual sailor** | free tools | own pocket, price-sensitive | €12–20/mo |

The bottom row is where the competitors live and where the support burden is
worst. **Do not build it this year.** It is the year-two motion, after the
GPS path is good and onboarding runs without you.

What the top row is buying is not an analytics app. It is **the day's whole
record, joined and shared with everyone on the programme before dinner** — video,
photos, telemetry, forecast, sail shape, rig numbers and the crew's own words,
on one timeline. That is the thing nobody else combines, and it is why the price
anchors against a human analyst's day rate (€600–1,200) rather than against a
$180/yr app.

---

## 2. Pricing

Founding rates are for contracts signed before **31 Mar 2027**, held for two
years, and are the *only* discount that exists. Everything is annual, invoiced,
paid up front — cash matters more than list price at this size.

| plan | for | includes | list | founding |
|---|---|---|---|---|
| **Programme** | one instrumented grand-prix campaign | everything: SailScan, lidar, rig versions, phase reporting, AI debrief, consultant seats, unlimited crew | **€9,600/yr** | €4,800 |
| **Squad** | a coach + up to 8 boats | GPS/derived-wind path, media, squad sharing, debrief, AI | **€3,600/yr** | €1,800 |
| **Coach** | one coach, up to 3 boats | as Squad, no squad sharing, capped storage | **€1,200/yr** | €600 |
| *Sailor* | individual | — | *year two* | — |

**Do not build metered storage overage.** I had this as a requirement; the
measurement removed it. At Bunny's rates a team would have to store roughly
**10 TB** — around 2,000 sailing days — before overage was worth invoicing. A
one-line fair-use cap in the terms covers the pathological case. Build billing,
not a meter with a price attached to it.

Three rules worth holding:

- **Never quote a monthly price to a programme.** Annual, on an invoice, into a
  season budget. Monthly invites monthly cancellation and monthly support.
- **Price the second boat cheaply, the second team never.** A programme is not a
  boat — Northstar is one team with a 72 and a 76. Expansion inside a team
  should be nearly free; that is what makes renewals grow.
- **Say no to the wrong customer out loud.** With your capacity, every customer
  you cannot serve in July costs more than they pay.

---

## 3. The twelve months

The plan is shaped by two calendars, not one. Your availability is the inverse
of your customers' intensity, and the LA28 quad peaks in 2027 — the qualification
season, when squad and federation budgets are at their least price-sensitive of
the entire four years. *(Confirm the exact quota calendar; the combined Worlds
in 2027 allocates the bulk of places.)*

### Q4 2026 — Oct to Dec: make it sellable, get paid once

The only quarter where you have time and nobody is racing. Spend it on the
things that are impossible to do in season.

| | |
|---|---|
| **Build** | Self-serve onboarding (§4.1) · billing · usage metering · terms, DPA, data-rights clause |
| **Sell** | Convert **3 founding customers**: 1 Programme, 2 Squad. Target **€8–12k booked** |
| **Prove** | Every contract carries the data clause from the first signature |
| **Decide** | Which two front doors (yacht / Olympic), and the LA28 narrative |

Getting paid once, by someone who is not a friend, before Christmas is the whole
point of this quarter. It is the single fact that changes every later
conversation.

### Q1 2027 — Jan to Mar: winter camps, and the dinghy proof

Olympic squads are in Palma, Lanzarote, Vilamoura, Cádiz and Miami from January.
This is simultaneously your best selling window and the best place to prove the
GPS path, because those camps are exactly the GPS-only case with a coach boat
that could carry a wind sensor.

| | |
|---|---|
| **Build** | GPS→TWD synthesis to a **published accuracy figure**, validated against measured wind from the Programme customers. The public bar is RaceQs: 3–5° single boat, ~1° with five. Beat or match it and say so in public |
| **Build** | Squad reciprocity — distribution and data acquisition in one feature |
| **Sell** | 3 → **8–10 paying** programmes. ~**€35–50k booked** |
| **Prep** | Investor material assembled from measured metrics, never projections |

### Q2–Q3 2027 — Apr to Sep: the season. Do not try to sell.

Assume founder capacity near zero. The plan for these six months is not a sales
plan, it is a **survival-and-harvest** plan, and the work that makes it possible
was all done in Q4 and Q1.

- **No founder-dependent motion.** Anything that needs you in July does not
  happen. Onboarding, support and renewal must already run without you.
- **One visible moment.** Be conspicuously in use at one qualification event.
  In this sport that is worth more than a quarter of outbound.
- **Harvest.** The season is when the corpus is built. Instrument it: complete
  days, ground-truth wind hours, human tags. These are the numbers you will
  raise on.
- **Channel instead of sales.** Coaches, class associations and hardware vendors
  sell for you while you are away — or nobody does.

### Q4 2027 — decide

With a season of retention behind you: raise, or conclude that SSA is a superb
strategic asset for your own practice and stop paying the tax of pretending
otherwise. Both are good outcomes. The plan is designed so the decision is made
on evidence rather than on appetite.

**Twelve-month target: 10–14 paying programmes, €55–80k ARR, one full season of
retention, and a wind model with a number attached to it.**

---

## 4. What to build, ranked by what it unblocks

### 4.1 P0 — nothing can be sold until these exist

1. **Self-serve team, boat and membership creation.** `docs/auth/permissions.md`
   states memberships are created by "manual SQL update" and only `admin` can
   add one. **You are currently the onboarding mechanism.** This single fact is
   incompatible with both raising money and being unavailable in the season.
   Nothing else on this list matters as much.
2. **Billing.** Stripe subscriptions mapped onto the existing role model —
   plan → entitlement → the `coach`/`tl2`/`tl1`/`consultant` matrix that already
   exists. The permission work is done; only the commercial layer above it is
   missing.
3. **Usage metering per team** — but for the *investor metrics and the
   completeness problem*, not for billing (§5 showed there is no margin problem
   to catch). `scripts/unit-economics.ts` already reports it from the existing
   tables. What is missing is delivery: Bunny Stream's own statistics endpoint
   returns **no traffic field at all**, and its view counter reads zero because
   playback does not go through Stream's player. `playback_events` is the only
   record of what is actually watched, and it has 73 rows. Fix that before
   claiming an engagement number to anyone.
4. **Terms, privacy policy, DPA, and an explicit data-rights and consent
   clause.** SSA holds video and photographs of identifiable people in the EU.
   The Supabase project is already in `eu-west-1`; the DPA is outstanding.
   Consent for training use is close to impossible to retrofit — put it in
   before the corpus exists, not after.
5. **An import path that works off your laptop.** Today a photo's instrument
   data only reaches the cloud at import, and a day imported on the wrong
   machine looks perfect to the importer and blank to everyone else. That is a
   support landmine that detonates in June, in your absence, in front of a
   paying customer. The `media:upload` route must become a first-class in-app
   path, not a script you run.
6. **Self-service support** — a status page, a way to be unstuck without you.

### 4.2 P1 — what closes the sale and builds the moat

7. **GPS→TWD synthesis with a published accuracy number.** The whole dinghy
   market rests on it, and a number you can defend is worth more in sales than
   any feature.
8. **Squad reciprocity.** Distribution and data acquisition in one mechanism,
   already designed.
9. **The AI debrief / plain-language query.** The demo that sells the room. Not
   the moat — the corpus underneath it is — but it is what people remember.
   The per-note 🎙 record button shipped in this pass (§8); the eval set and the
   map→reduce split are the next two steps, in that order.

### 4.3 P2 — year two, explicitly deferred

Individual-sailor tier · mobile polish for sailors rather than coaches · event
and federation products · hardware bundling.

---

## 5. Unit economics — measured, 20 Sep 2026

Measured, not modelled: `npm run econ` (`scripts/unit-economics.ts`) against
live Supabase and the Bunny Stream library. Re-run it each quarter.

### What is actually there

| team | boats | crew | days | videos | photos | stored GB | first → last |
|---|---|---|---|---|---|---|---|
| **Northstar** | 2 | 36 | 40 | 328 | 282 | 101.1 | 2026-05-18 → 2026-10-03 |
| Warp | 1 | 5 | 17 | 0 | 4 | 0.0 | 2026-06-15 → 2026-08-30 |
| Dragon | 1 | 3 | 1 | 0 | 0 | 0.0 | 2026-02-08 |
| Team Torvar | 1 | 2 | 1 | 0 | 0 | 0.0 | 2026-02-08 |

One real customer. 59 team-days, 731 videos in the Bunny library, 320 GB with
all renditions against 101 GB of source — a **3.19× rendition expansion** across
240/360/480/720/1080p.

### The cost of a team, at list rates

| per team-day | |
|---|---|
| stream storage added | **5.42 GB** (after rendition expansion) |
| photo storage added | 0.02 GB |
| video recorded | 0.12 h |
| photos | 5 |

| days/yr | year-end GB | storage $/mo (avg) | infra $/yr |
|---|---|---|---|
| 20 | 109 | $0.27 | **$3.27** |
| 40 | 217 | $0.54 | **$6.55** |
| 90 | 489 | $1.23 | **$14.73** |
| 120 | 652 | $1.63 | **$19.65** |

**A heavy team costs about fifteen dollars a year to serve.** Gross margin is
over 99% at every plan price, and would still be over 95% if delivery turned out
to be twenty times what is recorded. The 80% margin test I proposed is not a
test — nothing can fail it.

Two caveats, both honest:

- **Delivery is unmeasured.** Bunny Stream's statistics endpoint returns
  `viewsChart`, `watchTimeChart`, `countryViewCounts` and `engagementScore` —
  **no traffic field** — and all of them read zero with `engagementScore: -1`,
  because playback is served through signed CDN URLs rather than Stream's
  player. `playback_events` holds 73 rows: 0.7 watch-hours, 1.5 GB. Assume it is
  20× understated and traffic is still under $50/team/yr.
- **Postgres is the one line that is not free.** 31 sessions carry 78 MB of
  `log_data`/`xml_data` JSONB — **2.5 MB per logged day**, ~133k log rows. That
  is object-storage-shaped data living at database prices. It is irrelevant at
  four teams; at 100 teams × 90 days it is ~22 GB, past Supabase Pro's included
  8 GB. Cheap to fix later, cheaper to know now.

### Northstar has only just started — so test it at 10×

The 40 recorded days are a team that began using SSA in May and is still ramping.
Take usage up **ten-fold** — 54 GB per team-day instead of 5.4 — and the picture
barely moves:

| | today | **at 10×** |
|---|---|---|
| per team-day | 5.44 GB | 54.4 GB |
| year-end storage, 90 days | 489 GB | 4,896 GB |
| **infra cost / team / yr** | **$15** | **~$150** |
| margin, Programme €9,600 | 99.9% | **98.3%** |
| margin, Squad €3,600 | 99.6% | **96.2%** |
| margin, Coach €1,200 | 98.9% | **88.5%** |
| margin, a €144/yr sailor tier | 90% | **≈ 6%** |

**The conclusion survives the 10×, with one exception, and it is instructive.**
At ten times today's usage the Programme and Squad plans are untouched, the
Coach plan is still healthy — and a €12/month individual-sailor tier goes to
roughly break-even. That is the tier the competitors occupy, and it is the one
place in this business where bytes genuinely decide the outcome. It is a second,
independent reason not to build it this year.

Plan for the 10×: it is a storage line that grows, not a risk. `npm run econ`
re-measures it in a minute; re-run it when Northstar's season closes.

### What this changes

**Infrastructure is not a reason to price high, and it is not a reason to fear
a free tier.** I argued both in the first draft and the measurement does not
support either. What it supports is this: your marginal cost is **support and
onboarding**, denominated in founder-hours in June. Price and customer count
should be set by how many programmes one person can carry through a season —
not by a margin calculation that will never bind.

Open-Meteo remains the one variable that can misbehave, because it bills **per
location**: a 256-point wind field is 256 calls, and the limit is per IP. Model
forecast cost per team-day, not per request.

---

## 6. How much data does the AI need? Three partners is enough

> *Solid AI summaries that understand sailing is key. Happy with a maxi yacht,
> an Olympic team and a coached keelboat team, or do we need the volume?*

**Those three are enough — and they are the right three.** Volume is needed for
exactly one capability, and for that one, volume means *same-class boats*, not
more customers.

### Why volume is the wrong axis

You are not training a model on sailing, and you should not. Your own
`SSA_AI_STACK_HANDOVER.md` already settles the architecture: *"the LLM never
writes the analysis. It picks a function and fills arguments; Postgres does the
maths."* Domain understanding therefore enters through four channels, and **not
one of them scales with customer count**:

1. **The glossary** — `debriefGlossary.ts`, Dutch→English and the ASR fixups.
   One expert's vocabulary. Exists.
2. **Deterministic computed numbers** — `phaseStats`, manoeuvres, polars,
   windweight. This is code, not learning. A thousand teams improve it by zero.
3. **The tag vocabulary** — 232 definitions. Exists.
4. **An eval set** — ~50 real questions and debriefs with known-good answers.
   *This is the one that is missing, and it is the whole ballgame.*

A 24B model with heavy scaffolding and a good eval set beats a large model with
a naive prompt. Scaffolding and evals are built from **depth on a few boats and
one expert's judgement** — which is precisely what you are.

### What each capability actually needs

| capability | what it needs | days, or teams? | you have |
|---|---|---|---|
| Debrief summarisation | glossary + eval set | **days** — 30–50 complete ones | 22 debriefs |
| NL query over your own data | typed tools + semantic layer | **neither** — no training data at all | not built |
| Physics / VPP grounding | polars + class knowledge | **neither** | 8 polars |
| Auto-suggested tags | labelled examples per tag class | **days** — 20–50 tagged | **5 tagged days** |
| GPS → TWD synthesis | paired measured-wind + GPS hours | **days** — 100–300 h, from few boats | 31 logged days |
| SailScan sail shape | labelled images | **days** — 500–2,000 images | 282 photos, 58 scans |
| Learned polar | one boat's own days | **neither** — per-boat | — |
| **"Is 6.2 kt good?" benchmarking** | comparable boats **in the same class** | **teams — the only one** | 1 class |

Read the last row carefully, because it is the honest case for volume and it
also defeats the land-grab version of it: **cross-boat benchmarking needs
same-class teams, and class-local volume does not transfer.** Four hundred ILCA
users tell you nothing about the Northstar 76. The useful volume is ten boats in
*one* class — which is exactly what a single squad deal delivers, and exactly
what the squad-sharing feature is for. You do not buy it with a low price; you
buy it with one class association.

### What is actually in the corpus today

Measured 20 Sep 2026:

| | |
|---|---|
| team-days recorded | **59** |
| …with a log | **31** (133,498 log rows, 2.5 MB JSONB each) |
| …with media | **29** |
| …with a debrief | **22** |
| …with human tags | **5** |
| tag events / definitions | 339 / 232 — `tack` 152, `sail-change` 65, `gybe` 48, `topmark` 30, `gate` 24 |
| human debrief text | 53,944 characters ≈ **13.5k tokens**, plus 75 attached documents |
| sail scans / analysed photos | 58 / 280 |
| timeline nodes | 1,070 — **every single one `source: auto`. Zero human, zero AI.** |
| manoeuvre_events, runs, day notes, clip notes, mast settings | **0, 0, 0, 0, 0** |

### The finding that matters more than the answer

**Your bottleneck is not volume. It is completeness — and completeness is a UX
problem, not a sales problem.**

Of 59 recorded days, 31 have a log, 29 have media, 22 have a debrief and 5 have
tags. A
*complete* day — log, media, tags and a human debrief on the same day — is
currently a handful. The entire human layer of the corpus is 13.5k tokens of
debrief text and 339 tags on five days. Meanwhile the machine has produced 1,070
timeline nodes without help.

That asymmetry is the whole problem. Adding teams multiplies the auto layer and
leaves the human layer where it is, because the human layer depends on someone
choosing to tag a day and write a debrief after a long day on the water. **A
hundred teams tagging nothing is a hundred times nothing.** Everything that
makes SSA's corpus defensible — the expert labels nobody else has — comes from
the half of the product that is hardest to make effortless.

So the AI investment this year is, in order:

1. **The eval set** — 30–50 complete days with a debrief you would hand a coach.
   You are over half way on the debrief axis already. Nothing else in the AI
   plan should start first; per the handover, *"without it, prompt changes are
   vibes."*
2. **Make tagging and debriefing effortless enough that they happen** — this is
   product work, and it is the real data strategy.
3. **Map→reduce on the summary** (handover Part 1a), which both kills the 4,000-
   token truncation and turns every observation into a queryable row.
4. Then the query layer.

### So: pick the three for complementarity, not volume

The three you named cover the three things the AI needs, which is why they are
the right answer:

- **Maxi / grand-prix** — measured wind, lidar, real polars. The *ground truth*.
- **Olympic team** — the GPS-only case the synthesis has to serve. The *target*.
- **Coached keelboat squad** — multiple same-class boats. The *benchmarking seed*
  and the reciprocity test.

One change to make it count: **write completeness into the founding contract.**
Twenty complete days a season — tagged, with a debrief — is what the founding
discount buys. Not "access to their data", which you already have and which is
mostly auto-generated. The scarce thing is a coach's attention after racing, and
it should be an explicit term rather than a hope.

Inference cost does not feature: 13.5k tokens is the entire human corpus, and a
day's summarisation on Mistral Small 24B costs fractions of a cent. Scaleway is
not a line item this year.

---

## 7. The TWD moat, counted — and Warp is not in it

TWD-from-track is the linchpin of the whole dinghy market, and the paired data
from the instrumented boats is what makes it defensible. So it should be
measured rather than asserted: `npm run twd:truth`
(`scripts/twd-groundtruth.ts`) counts rows where measured `twd`/`tws` sit
alongside `lat`/`lon`/`sog` on a moving boat — the truth and the track, same
boat, same second.

| team / boat | days | paired days | log h | **paired h** | tacks | gybes |
|---|---|---|---|---|---|---|
| Northstar / Northstar 76 | 31 | 24 | 93.3 | **88.0** | 587 | 230 |
| Northstar / Northstar 72 | 9 | 5 | 17.8 | **17.2** | 166 | 70 |
| Team Torvar / Torvar | 1 | 1 | 2.7 | 1.9 | 8 | 0 |
| Dragon / Miss Behavior | 1 | 1 | 2.8 | 1.9 | 5 | 1 |
| **Warp / Warp 5** | **17** | **0** | **0.0** | **0.0** | 0 | 0 |

**109.1 paired hours and 1,067 paired manoeuvres.** Manoeuvres are the unit that
matters — every published estimator, SAP's open-sourced one included, infers
wind from tacks and gybes, so an hour of drifting is worth far less than a beat
full of tacks.

**You are already at the bottom of the band needed for a first model** (100–300
paired hours, several hundred manoeuvres). This is not a "gather data for a
year" problem. It is a build problem, and it can start now.

### Two things the count changes

**1. Warp contributes nothing.** Seventeen recorded days and **zero logs**. The
premise that "Northstar and Warp data is the moat" is currently half true — the
moat is Northstar, twice. Whatever Warp is recording is not reaching
`sessions.log_data`, and until it does those seventeen days are invisible to
every model you might train. Finding out why is the highest-value data action
available, and it costs a conversation, not a quarter.

**2. The wind range is lopsided, and that is where the model will be weak.**

| TWS band | share of paired rows |
|---|---|
| < 6 kn | 9.0% |
| 6–10 | 36.8% |
| 10–14 | 30.1% |
| 14–18 | 14.8% |
| 18–25 | 8.7% |
| **> 25** | **0.6%** ← thin |

Upwind 49% · reaching 18% · downwind 33%. Two thirds of everything sits between
6 and 14 knots, and above 25 knots there is essentially nothing. A model trained
on this will be quietly wrong in a breeze, which is exactly when a coach checks
it. **Log the windy days deliberately** — they are the scarce ones, and a single
strong-breeze regatta is worth more to the model than a month of 8-knot
training.

### To maximise it, in order

1. **Get Warp logging.** Seventeen days already lost. Whatever the reason —
   no export, wrong format, never imported — it is a conversation this week.
2. **Log every day the instrumented boats sail**, especially windy ones. Paired
   hours accumulate only from days that actually reach the cloud, and the import
   trap (§4.1 item 5) means a day imported on the wrong machine is a day lost to
   everyone but the importer.
3. **Read SAP's `windestimation` bundle before writing an estimator.** Apache
   2.0, the only production manoeuvre-based estimator whose source you can read.
   A day of reading against months of rediscovery.
4. **Publish the accuracy number** against the RaceQs bar — 3–5° single boat,
   ~1° with five. A number you can defend sells better than any feature, and it
   is the one asset a competitor cannot copy by shipping faster.
5. **Implement the capability profile.** `boats` has `id, team_id, name,
   sail_number` and nothing else — the `boat.specs.capabilities` design in
   `one-product-capability-profiles-2026-09.md` is a document, not a column. The
   whole "one product, two front doors" strategy rests on it, and it is a
   migration plus a JSONB blob.

---

## 8. The debrief is the unique selling point — so it now records

Nobody else in the survey joins a spoken debrief to the day's telemetry, media
and forecast. kTool has sail-shape analysis, Kinetix cuts clips, SailSync
transcribes audio — **none of them turns what the team actually said into a
searchable part of the day's record.** That is the USP, and it is also the part
of the corpus that §6 shows is barely being written.

Those two facts are the same fact. The debrief is the differentiator *and* the
bottleneck, so the friction in it is the most expensive friction in the product.

**Shipped in this pass: a 🎙 Record button on every note.** Previously the only
way to get audio in was `AudioBrief` — upload a file, summarise a whole meeting,
desktop-only. That fits a 75-minute Maxi Worlds debrief and nothing else. A
coach with one thought on the dock had to type it.

| | before | now |
|---|---|---|
| input | upload an audio file | **record straight from the mic** |
| scope | a whole section's fields | **one note** |
| device | desktop only | **mobile too** — the dock and the coach boat |
| model mode | speedteam / debrief / planning | **new `note` mode** — tidy-up, not summary |

Every note in the campaign day — Plan, Timings, Weather notes, and each debrief
field — now carries the button. Press it, talk, stop; the recording is
transcribed on Scaleway, tidied into the boat's own vocabulary (the sail
wardrobe is pulled live from the Boat tab), and shown for review with the raw
transcript one click away. Nothing is written to a note without the user
approving it, and a failed tidy-up falls back to the raw transcript rather than
losing what was said.

The `note` prompt is deliberately not a summariser: it keeps the note the same
length as what was spoken, strips filler and self-corrections, and is forbidden
from adding conclusions the speaker did not say. A note that grows in the
retelling is worse than the raw transcript.

*Files:* `src/lib/micRecord.js`, `src/components/NoteRecorder.jsx`,
`runAudioNote()` in `src/lib/debriefAudio.js`, the `note` mode in
`src/lib/debriefPrompt.ts`, `src/lib/boatVocab.js` (shared, cached vocabulary —
a day's page mounts a dozen of these), wired into `CampaignTab.jsx`.

**What to measure:** tagged-and-debriefed days per month, before and after.
§6 says this number, not customer count, is what gates the AI. If the record
button does not move it, the next fix is in the same place — not in sales.

---

## 9. Step by step — what to actually do

Ordered so that nothing waits on something later. **Bold** items are blocking:
a sale cannot be delivered without them.

### Now — the week of 21 Sep 2026

| # | do | why | done when |
|---|---|---|---|
| 1 | **Ask why Warp has no logs** | 17 days already lost; every future day compounds it | a log from Warp is in `sessions.log_data` |
| 2 | Run `npm run econ` and `npm run twd:truth`, keep the output | the baseline every later number is measured against | numbers pasted into this doc's §5 / §7 |
| 3 | Name the three founding targets | Q4 is twelve weeks and the season restarts in January | three names, with the person who introduces you |
| 4 | Decide: paid founding customers, or free pilots | everything downstream branches here (§12) | decided in writing |

### Oct 2026 — make it deliverable

| # | do | why | done when |
|---|---|---|---|
| 5 | **Self-serve team + boat + membership creation** | memberships are manual SQL today; *you* are the onboarding mechanism | a coach can invite their crew without you |
| 6 | **In-app import that works off your laptop** | a day imported on the wrong machine is blank for everyone else — the support landmine that detonates in June | `media:upload`'s path exists in the app |
| 7 | Terms, privacy policy, DPA, **data-rights + consent clause** | EU video of identifiable people; consent cannot be retrofitted across a corpus | drafted and in the contract template |
| 8 | Fix `playback_events` coverage | Bunny's counters read zero; you cannot claim engagement you cannot measure | watch-hours land for every play |

### Nov 2026 — make it sellable

| # | do | why | done when |
|---|---|---|---|
| 9 | **Stripe subscriptions → entitlements** on the existing role model | the permission matrix is done; only the commercial layer is missing | a plan can be bought and it grants access |
| 10 | Two front doors: yacht and Olympic landing pages | same app, two vocabularies (§5 of the capability-profile doc) | both live |
| 11 | Capability profile migration (`boats.specs` JSONB) | the one-product strategy rests on a column that does not exist | a boat declares its channels |
| 12 | **Close founding customer #1** | one invoice from a non-friend changes every later conversation | money received |

### Dec 2026 — the eval set, while it is quiet

| # | do | why | done when |
|---|---|---|---|
| 13 | **Build the AI eval set**: 30–50 complete days | *"without it, prompt changes are vibes"* | a scored golden set that re-runs |
| 14 | Map→reduce the debrief summary | kills the 4,000-token truncation; every observation becomes a queryable row | no more `extractJson` repair path |
| 15 | Close founding customers #2 and #3 | €8–12k booked before Christmas | signed |
| 16 | Apply for non-dilutive R&D funding (WBSO if NL-resident) | cheapest capital there is, and the wind work plainly qualifies | submitted |

### Jan–Mar 2027 — winter camps: the dinghy proof

| # | do | why | done when |
|---|---|---|---|
| 17 | **GPS→TWD synthesis, v1** | 109 paired hours is already enough to start | it runs end-to-end on a GPS-only day |
| 18 | **Publish the accuracy number** vs the RaceQs bar | the one thing a competitor cannot copy by shipping faster | a figure you will defend in public |
| 19 | Deliberately log windy days | >25 kn is 0.6% of the corpus; the model will be weak exactly where it matters | the band is no longer thin |
| 20 | Squad reciprocity (Hudl league-pool rule) | distribution and data acquisition in one feature | a squad day can be pulled only by a contributor |
| 21 | 3 → 8–10 paying programmes | ~€35–50k booked | signed |
| 22 | Investor material from measured metrics | projections convince nobody in a small market | a deck built on `econ` + `twd:truth` output |

### Apr–Sep 2027 — the season: survive and harvest

| # | do | why | done when |
|---|---|---|---|
| 23 | **No founder-dependent motion** | capacity is near zero; anything needing you in July does not happen | onboarding and support run without you |
| 24 | Channel: coaches, class associations, hardware vendors | they sell while you are away, or nobody does | one signed channel relationship |
| 25 | Be visibly in use at one qualification event | worth more than a quarter of outbound in this sport | it happened, with a case study |
| 26 | Track complete days monthly | the metric that gates the AI and the raise | a monthly number, trending up |

### Q4 2027 — decide

Raise, or conclude SSA is a superb strategic asset for your own practice and
stop paying the tax of pretending otherwise. Gate: **10+ paying programmes,
>€60k ARR, one season of retention, a published wind-accuracy number, a clean
data-rights position, and a second person.**

---

## 10. Raising: what is realistically available

Be clear-eyed. At €5k ACV and a few thousand addressable programmes, the honest
TAM is tens of millions, not billions. **A generalist VC will pass on TAM, and
they will be right to.** Aiming at them wastes the year. The money that fits:

| source | why it fits | what it wants to see |
|---|---|---|
| **Owner-angels from the sport** | grand-prix owners have capital, love the sport, and are your customers. The best-fit money in the world for this | a programme they respect using it, and a personal relationship |
| **Strategics** — Vakaros, Sailmon, North, Doyle, SAP | they own hardware or sails and no analytics layer; SSA is the layer | a working product on their hardware and a partnership before a term sheet |
| **Federations / class associations / World Sailing innovation budgets** | non-dilutive, and they buy as well as fund | a qualification-season result story |
| **Sports-tech micro-funds** | small cheques, understand small TAM and high ACV | retention and ACV, not user count |
| **Non-dilutive R&D** — WBSO if you are NL-resident, Eurostars, MIT-regeling | the cheapest capital available to a solo technical founder; a payroll-tax credit on genuine R&D, which the wind-synthesis work plainly is | an application, not a pitch. Worth a day in Q4 |

**The expansion story that makes the TAM objection survivable** — and it should
be argued, not hidden: elite sailing is the wedge because it is where the
ground truth is generated; the expansion is every class and federation, then
events, then hardware bundling, where the buyer is a manufacturer rather than a
team. Say that in the first five minutes, with the ground-truth argument from
§0 as the reason the wedge is not a niche but a supply chain.

**What the raise needs by Q4 2027:** 10+ paying programmes · >€60k ARR · one
season of logo retention · a wind model with a published number · a data-rights
position that holds up in diligence · **and a second person.**

---

## 11. Risks, in the order they will actually bite

| risk | severity | what to do |
|---|---|---|
| **Founder absent in season** | highest | It is the first diligence objection too. Everything in §4.1 exists to remove you from the critical path. Contract a second person before the raise, not after |
| **You are the onboarding mechanism** | high | §4.1 item 1. Today, a sale you close in May cannot be delivered |
| **Concentration on one programme** | high | Northstar is reference, revenue and design partner at once. Three customers by Christmas is the mitigation |
| **Warp records days but no logs** | high | 17 days, zero paired hours. Silent, and every day compounds it. §7 |
| **The human layer never gets written** | high | 1,070 auto timeline nodes against 5 tagged days. The corpus that is supposed to be the moat is almost entirely machine-generated. Make tagging effortless, and contract for complete days (§6) |
| ~~Video cost blowout~~ | measured away | $15/team/yr. Do not spend a day on it |
| **Funded competitors on the same wedge** | medium | Kinetix AI and SailSync are aimed here. Your defence is the joined record and the ground truth, not features |
| **Data rights unsecured** | medium, irreversible | The clause goes into contract #1. Retrofitting consent across a corpus of crew video is close to impossible |
| **GDPR on crew video and photographs** | medium | EU region is done; DPA, retention and deletion are not |
| **Class rules banning electronics while racing** | low | Training days are where the money and the data are |

---

## 12. Decisions for you, now

1. **Paid founding customers, or free pilots?** This plan says paid — even at
   half price, even to friends. A free pilot never gets a budget-holder's
   approval, and therefore never proves the thing you need proved.
2. **Which three logos by Christmas?** One instrumented programme and two
   Olympic squads. Name them this week; Q4 is short and the season restarts in
   January.
3. **Would you take an owner-angel cheque** from someone who is also a customer?
   It is the best-fitting capital available and it entangles the relationship.
   Decide before the conversation happens, not during it.
4. **Second person: before or after the raise?** The seasonal-absence risk says
   before. The cash says after. Non-dilutive R&D funding is what resolves this,
   which is why it is worth a day in Q4.
5. **Will you contract for complete days?** §6 says the founding discount should
   buy twenty tagged, debriefed days a season, in writing. It is the only term
   that converts a customer into corpus, and it is awkward to ask for — which is
   why it has to be decided before the first negotiation rather than during it.

---

## 13. The one-line version

> Charge properly, to few, starting now. The paying instrumented programmes are
> not just revenue — they manufacture the ground truth that makes the wide,
> cheap, GPS-only market winnable in year two. Going wide first would be going
> wide with nothing to defend.
>
> And the data you need for the AI is not more teams. It is more *complete days*
> from the three you have: 59 days recorded, 5 of them tagged.
>
> The TWD ground truth is further along than it looks — 109 paired hours and
> 1,067 paired manoeuvres, already enough to build a first model. Warp has
> contributed none of it.
