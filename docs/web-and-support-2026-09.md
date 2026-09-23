# The public face of SSA — what the best actually do, and what we do instead

_22 Sep 2026. Research behind the marketing site and the support centre, and
the decisions that fall out of it. Companion to
[commercialisation-plan-2026-27.md](commercialisation-plan-2026-27.md), whose
strategy this has to serve: **word of mouth, and a small number of key teams
that pay.**_

Deliberately researched wide. The sailing tools are the least useful reference
in here — they are all selling something SSA is not selling, to someone SSA is
not selling to. The useful references are two categories up (elite sports
technology, premium sales-led software) and one discipline across
(content design, where the work has actually been studied).

---

## 1. Sailing — the near field

Visited 22 Sep 2026. Not the feature survey; that is in
`dinghy-gps-prior-art-and-twd-2026-09.md`. This is about the *front door*.

| | Vantage | SailSync | OutSail.pro |
|---|---|---|---|
| landing page is… | a marketing site | **a signup form** | marketing + free tier |
| free tier | yes ("Starter") | yes | yes |
| public price | $119.99/yr PRO · $179.99/yr Coach | $20.99–62.99/mo | €15/mo · €60/mo · €3,000/yr club |
| high end | **"Organization Plans — contact us"** | coach tiers | club tier |
| signup | app store, 30-day trial | email/Garmin/Strava/Google/Apple; **Sailor or Coach chosen at signup** | web |
| support | Help Center + a structured manual | in-app | thin |

**Vantage's manual is the best-structured documentation in the category**, and
the structure is the valuable part: chapters grouped by **task** (*Getting
Started · Recording & Importing · Editing Activities · Logging Data ·
Performance Analysis · Data Comparison · Sharing*), **role badges** on each
chapter (`Sailor` / `Coach`), tier badges (`PRO`), numbered steps, and
Previous/Next so it reads as a manual rather than a pile of articles. Their
footer also carries a **Supported Classes** page — in sailing that is a trust
signal, because a coach checks whether their class is there before reading
anything else.

SSA can do the role-badge idea better than they can: `docs/auth/permissions.md`
already defines *seven* roles, so a chapter can say exactly who it is for.

**But the whole near field is a volume funnel** — free tier, app-store trial,
"Start Free Trial" as the primary button — which is coherent at $119/year
selling to thousands of individuals and incoherent for SSA. There is no free
tier in the pricing, self-serve signup manufactures exactly the support load
that cannot be carried April–September, and it aims at the individual sailor,
the one buyer the plan defers to year two.

The one thing worth taking is Vantage's escape hatch: *"Organization Plans — for
pricing, volume licensing and tailored setups, reach out."* For them it is the
small door at the back. For SSA it is the only door, and it is the front one.

---

## 2. Elite sports technology — the real comparables

These sell to the same kind of buyer SSA sells to: a funded programme, with a
budget holder, on an annual contract.

**Veo** (cameras + subscription, clubs). Price on the page and large — a bundle
priced at €1,857, reduced from €3,156 — with two CTAs side by side: *Buy Online*
and **Book a call**. The call form is the interesting part: *"Get your personal
quote in just 2 minutes"*, then a **dropdown of specific intents** ("Buy my
first Veo Cam", "Upgrade my subscription", "I have a support question"),
organisation, and sport. The high-touch path is packaged as *fast and concrete*
rather than as a vague "contact us", and the dropdown qualifies the lead before
a human reads it.

**Catapult** (elite performance, 5,500+ teams). The opposite pole: **no price
anywhere**, one CTA ("Get in touch"), and credibility carried entirely by scale
— *128+ countries · 40+ sports · 5,500+ elite teams · "We work with the best"*.

**Hudl.** Help Center plus a YouTube channel plus **Hudl Academy certification
courses** plus a live events calendar. Worth knowing as the ceiling, and worth
ruling out immediately: it is four content operations, and SSA has a founder
who is on a boat from April to September.

**The lesson from the pair.** Catapult's proof is scale; SSA has one paying-ready
customer and cannot borrow that move without lying. Veo's proof is a price and a
two-minute path to a human. **SSA must prove with evidence instead — a real day,
real measured numbers, and eventually a published accuracy figure.** That is not
a consolation prize: nobody in either field publishes one.

---

## 3. Premium software — how a high-price, low-volume product presents

**Linear.** Free / $10 / $16 per user / **Enterprise "Custom — contact sales"**,
with a full feature-comparison matrix under the tiers, and *"Trusted by more
than 40,000 companies"* with customer stories. The tier table is doing real
work: it lets a buyer self-select without a call.

**Superhuman.** The canonical word-of-mouth-at-a-premium product — for years
invite-only, no free tier, a waitlist, and a 1:1 onboarding call with every new
user at $30/month. Worth noting that the site today has moved to "Request a
demo" and enterprise positioning: **the invite-only model is a phase, not a
destination**, which is exactly how the plan treats it (cheap-and-wide is year
two).

The pattern across both: **show the price for the plans a buyer can self-select,
and put one clearly-labelled human path next to them.** Never hide every number.

---

## 4. Pricing against the two that matter

Checked on their own public calculators, 22 Sep 2026. This is the section the
rest of the pricing page has to answer to.

**Njord** — cloud, priced by **boat class × fleet size**, unlimited team members,
30-day free trial, self-serve, excl. EU VAT. Pay per *sailing day* or flat per
year. Loading data older than **180 days is free**.

| bundle (Analytics + Player) | ILCA 7 ×1 | ILCA 7 ×6 | Maxi 72 ×1 | Maxi 72 ×2 |
|---|---|---|---|---|
| per year | €1,199 | €2,749 | €5,599 | **€10,049** |
| per sailing day | €17.99 | €67 | €175 | — |

The dinghy tiers advertise **"TWD data inference"** — Njord already sells wind
from a bare track. The fleet taper is shallow at the dinghy end (each extra ILCA
adds ~26% of the first) and steep at the top (the second Maxi 72 adds 79%).

**KND is two businesses**, and only one competes:

- **ReXY Gold** — desktop, tracker-only, single *and* multi-boat reports,
  GPX/CSV/FIT, **€120/year**, 5-day trial, endorsed by Santi Lange and JB
  Bernaz. The price floor in the dinghy market, and coaches know it.
- **KND performance analysis** — remote or on-site analyst, plus CFD/VPP, quote
  only. Quantum Racing, Ran, Wild Oats XI, Macif, L'Occitane.

### Five things that follow

1. **Njord is the wrong anchor for the top tier; the analyst is.** A grand-prix
   programme does not choose between SSA and Njord — it would buy both. What SSA
   displaces at that end is analyst time, and the plan already anchors there
   (§ commercialisation plan: a day rate of €600–1,200). The Programme plan is
   five to ten analyst days, for a season. Say that on the page.
2. **"Every boat in the programme" is the differentiator, and it is free.**
   Njord's second Maxi 72 costs another €4,450. SSA's data model already treats a
   team as a programme holding several boats, so one price for the campaign is
   both true and checkable against Njord's own calculator.
3. **Do not copy the per-sailing-day meter.** It is clever for Njord and wrong
   for SSA: the strategy needs teams uploading and tagging *every* day, and a day
   meter prices exactly the behaviour SSA wants to encourage. Metered billing
   would also need automation that does not exist while onboarding is manual SQL.
4. **Steal the 180-day rule.** Free import of anything older than six months
   costs almost nothing at ~$15/team/yr of infrastructure and buys corpus, which
   is what gates the analysis. It is also a good closing gift.
5. **The founding rate does the competitive work.** At half list, Programme is
   €3,000 — well under Njord's €5,599 for a single Maxi 72. For the three
   customers 2027 actually needs, *cheaper than Njord and it does more* is
   already true. List price only has to be defensible today, not competitive.

### Where that leaves the ladder

| plan | list | founding | nearest Njord equivalent |
|---|---|---|---|
| Coach, ≤3 boats | €1,200 | €600 | ~€1,819 (3 ILCA, interpolated) |
| Squad, ≤8 boats | €3,000 | €1,500 | ~€3,369 (8 ILCA, interpolated) |
| Programme, every boat | €6,000 | €3,000 | €5,599 one maxi · €10,049 two |

Under Njord at every tier except a single-boat programme, where SSA is 7% over
and wins the moment a second boat appears. ReXY Gold at €120 sits an order of
magnitude below the Coach plan, which is the right distance: close enough that
nobody confuses the two, far enough that the comparison is never made.

**Open consequence, not yet resolved:** the commercialisation plan's Q1 2027
target of *€8–12k booked from three founding customers* was written against
€9,600/€3,600. At the new founding rates, 1 Programme + 2 Squad is **€6,000**.
Either the target or the customer mix needs revising — the ACV band in that plan
(€6–15k for a grand-prix programme) still holds, so this is an arithmetic fix,
not a strategy change.

---

## 5. The discipline: what makes help content good

This is the part with actual research behind it, and it is where most support
pages fail.

### NN/g on FAQs (Farrell, 2014; from a 94-guideline study of 23 organisations)

- **Never invent questions.** Made-up FAQs were #7 on the top-10 web design
  mistakes list. Questions must echo what people actually ask.
- **Use the reader's vocabulary, not yours** — the "verbal disagreement
  phenomenon". People search for *their problem*, not your solution. This is
  also why question phrasing is the SEO.
- **Search is not a substitute.** Your words and the reader's talk past each
  other, and most people are not good at forming queries.
- **Chunk by topic and design for scanning** — the goal is that a reader can
  *rule out* most topics in seconds. Font contrast matters: questions must scan.
- **Under ~10 pages: question list, then the Q&As below it.** Longer or with
  involved answers: a list of questions linking to answer pages.
- **Put the link in the footer.**

And the finding that matters most here — the reader is judging you on questions
they never type. A good FAQ answers these **tacit** ones:

> Could I get an answer easily, or is this an endless loop with no contact
> information? · How credible is this? · Is it factual, or marketing hype? ·
> **Does it openly acknowledge the problems and limitations everyone already
> knows about?** · Can I dismiss all my concerns before spending money? ·
> **How mature is this? What doesn't it do yet?**

For a product with one reference customer, **candour about limitations is not a
risk, it is the credibility mechanism.** A support page that admits what SSA
does not do yet will be trusted on what it says it does.

NN/g also names an audience most sites ignore: FAQs provide decision support for
"prospects, customers, **and recommenders**". Recommenders are the entire
distribution strategy here. The support page is not an after-sales cost — it is
sales collateral for the coach doing the recommending.

### GOV.UK content design

The first website to win the Design Museum's Design of the Year, and the source
of the house style most public-service writing now follows. What transfers:

- Content exists to **meet a user need**, and the need is a task, not a topic.
- **Plain language, short sentences, active voice.** Write for the reader in a
  hurry and under stress — which describes a coach whose day's photos have not
  appeared, exactly.
- **Front-load the answer.** The first sentence answers the question; context
  comes after.
- **Titles start with a verb** — "Upload a day's photos", not "Photo uploads".
- One idea per paragraph. No jargon where a plain word exists — and where the
  jargon *is* the plain word for sailors (TWA, gybe, A2), keep it.

---

## 6. What follows for SSA

### The site's job is to survive being forwarded

Word of mouth here does not look like a funnel. It looks like a coach who uses
SSA sending a link to a programme manager on WhatsApp. That settles the design:

| because the reader is… | the page must… |
|---|---|
| a programme manager who has never heard of it, on a phone, in 40 seconds | say what it is in one sentence, with no adjectives |
| about to spend €4,800–9,600 of someone else's money | **show the price** — a budget holder cannot start an approval without a number, and "contact for pricing" reads as *we will work out what you can afford* |
| responsible for crew video of identifiable people | find the data and privacy answer without asking |
| going to ask "who else uses this?" | see real programmes, not stock photography |
| sceptical of AI claims, because everyone makes them | see evidence: a real day, measured numbers |
| a **recommender** (NN/g) — the coach doing the forwarding | have something quotable to paste |

### Decisions

| decision | choice | why |
|---|---|---|
| where it lives | **`/` for logged-out visitors**; the app at `/` when signed in | it is the front door, and a link with a path on it is not |
| primary CTA | **Request access** → a row in the database | no free tier to offer; and it is a pipeline that can be counted for investors |
| the form | **intent dropdown first**, then boat/class and contact | Veo's move: it qualifies before a human reads it |
| price | **shown in full**, every boat included | Linear/Veo, not Catapult — SSA has no scale to substitute for a number, and §4 gives the number a defence |
| free trial | **none** | it would contradict §2 of the plan on the first screen |
| support | one page, not a help desk | Hudl Academy is four content operations |
| manual | task-grouped chapters, **verb-first titles**, role badges from the real permission matrix | Vantage's structure + GOV.UK's titles + a thing Vantage cannot do |
| FAQ | **only questions actually asked**, in the reader's words, grouped so most can be ruled out fast | NN/g |
| limitations | **stated plainly, in public** | the tacit question, and the fastest way to be believed with one reference customer |
| data & AI | **its own page**, not a clause in a policy | see below — it is a buying requirement, not compliance furniture |

### The Data & AI page is a sales page, not a legal one

Two questions decide a sale to a federation or a funded programme, and a privacy
policy written for a shop answers neither: *where does it live and who can see
it*, and *what happens to our crew's voices and video when you point AI at
them*. The second is the one nobody else in this field answers at all.

SSA has an unusually strong answer and was not using it. From
`SSA_AI_STACK_HANDOVER.md`: **all inference stays inside the Scaleway (EU)
account — nothing to a third-party vendor, confirmed as binding.** Whisper
large-v3 and Mistral Small 3.2 on European hardware, open-weight models, one
team's material per request, a person approving every output before it is saved,
and no training on recordings or debrief text. A national federation's
data-protection officer can approve that; "we use AI to summarise your debriefs"
with no further detail is what gets a procurement blocked.

So `/privacy` states the subprocessor list with regions, the seven-role access
matrix, the squad-sharing defaults (rig numbers off, debriefs never shareable),
the export and deletion rights — and, in the same voice as the rest of the site,
the three things that are **not** settled: debrief-recording consent is a team
process rather than a product feature, there is no automatic retention schedule,
and there is no ISO 27001 or SOC 2 certification. Claiming otherwise would be
the one lie on the site that a serious buyer would actually catch.

### What is deliberately not built

- **No blog.** Three posts and a six-month gap is worse than none.
- **No live chat.** It promises a response time that cannot be kept in June.
- **No newsletter capture.** Nothing to send.
- **No search box on the support page.** NN/g: under ten pages, a scannable
  question list beats a search field that will mostly return nothing.
- **No testimonials until they are real and attributed.** In a sport this small,
  an unattributed quote reads as a fabricated one.
- **No cookie banner**, because there is no analytics cookie to consent to.
  Every competitor has one; not needing it is the better answer.

---

## 7. What shipped

| route | public | what |
|---|---|---|
| `/` | anon only | the front page: what it is, who it is for, evidence, price, request access |
| `/features` | yes | what it does, grouped by the shape of a sailing day rather than by tab |
| `/pricing` | yes | three plans, founding rates, and the questions a budget holder asks |
| `/support` | yes | the manual — task-grouped, verb-first, role-badged — plus the Q&A |
| `/privacy` | yes | where the data lives, who sees it, what AI may do, and what is not settled |
| `/request-access` | yes | the form; writes `access_requests` |

Signed-in users are unaffected: `/` still renders the app and nothing in the
auth gate changed for them.

---

## 8. What to measure

Not a funnel, so funnel metrics would mislead. Three numbers:

1. **Access requests per month, and how many name a referrer.** Word of mouth is
   the strategy; if requests carry no referrer, it is not working yet.
2. **Request → conversation → signed.** Counted by hand, which at this size is
   the right instrument.
3. **Support questions received per active team, month over month.** The manual
   is working when this falls. It is the only metric that predicts whether a
   season at near-zero founder capacity is survivable — and per NN/g, every
   question that still arrives is a UX defect report, to be fixed in the product
   and only then written down.
