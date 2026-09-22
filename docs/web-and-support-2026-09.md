# The public face of SSA — what best-in-class does, and what we do instead

_22 Sep 2026. Research behind the marketing site and the support centre, and
the design decisions that fall out of it. Companion to
[commercialisation-plan-2026-27.md](commercialisation-plan-2026-27.md), whose
strategy this has to serve: **word of mouth, and a small number of key teams
that pay.**_

---

## 1. What the field actually ships

Visited 22 Sep 2026. This is deliberately not the feature survey — that is in
`dinghy-gps-prior-art-and-twd-2026-09.md`. This is about the *front door*: what
their sites are for, how they price in public, and how they support people.

| | Vantage | SailSync | OutSail.pro | Hudl (the precedent) |
|---|---|---|---|---|
| landing page is… | a marketing site | **a signup form** | marketing + free tier | a marketing site |
| free tier | yes ("Starter") | yes | yes | no |
| public price | $119.99/yr PRO · $179.99/yr Coach | $20.99–62.99/mo | €15/mo · €60/mo pro · €3,000/yr club | "contact us" |
| high-end | **"Organization Plans — contact us"** | coach tiers | club tier | enterprise sales |
| signup | app-store, 30-day trial | email/Garmin/Strava/Google/Apple, **Sailor or Coach chosen at signup** | web | school/club contract |
| support | Help Center + a structured manual | in-app | thin | Help Center + YouTube + **Hudl Academy certification** + events |

### What Vantage's manual gets right, and we should copy

Their "Getting Started" is the best-structured documentation in the category,
and the structure is the valuable part:

- **Chapters grouped by TASK, not by feature** — *Getting Started · Recording &
  Importing · Editing Activities · Logging Data · Performance Analysis ·
  Managing Activities · Data Comparison · Sharing.* Nobody arrives wanting to
  read about "the Analytics tab"; they arrive having lost a day's photos.
- **Role badges on each chapter** — `Sailor` / `Coach`. A reader skips what is
  not theirs. SSA has a *seven*-role permission matrix already written down in
  `docs/auth/permissions.md`, so this costs nothing and pays more than it does
  for them.
- **Tier badges** — `PRO` against the chapters a free user cannot use.
- **Numbered steps**, with the decision points called out ("the boat profile may
  not necessarily represent a physical boat").
- **Previous / Next chapter** at the foot, so it reads as a manual and not a
  pile of articles.
- A **Supported Classes** page in the footer. In sailing this is a trust signal:
  a coach checks whether their class is there before reading anything else.

### What the whole field does that we must NOT copy

**They are all volume funnels.** Free tier, app-store trial, self-serve signup,
"Start Free Trial" as the primary button. That is coherent for a product at
$119/year selling to thousands of individuals. It is incoherent for SSA:

- There is **no free tier** in the pricing (§2 of the plan), so a "Start free"
  button would be a lie on the first screen.
- Self-serve signup manufactures exactly the support load that cannot be carried
  from April to September.
- It aims at the individual sailor — the one buyer the plan explicitly defers to
  year two, because it is where the competitors already live and where the
  margin dies at 10× usage.

**The one thing to steal from them is the escape hatch.** Vantage's
"Organization Plans — for pricing, volume licensing and tailored setups, reach
out" is, for them, the small door at the back. For SSA it is the *only* door,
and it is the front one.

---

## 2. What the site is actually for

Word of mouth in this sport does not look like a funnel. It looks like this:

> A coach who already uses SSA tells a programme manager about it, in a
> WhatsApp message, with a link.

So the site's job is not to convert a stranger. It is to **survive being
forwarded**. That single sentence settles most of the design:

| because the reader is… | the page must… |
|---|---|
| a programme manager who has never heard of it, reading on a phone, in 40 seconds | say what it is in one sentence, without adjectives |
| about to spend €4,800–9,600 of someone else's money | **show the price**. "Contact for pricing" reads as *we will work out what you can afford*, and a budget holder cannot start an approval without a number |
| responsible for crew video of identifiable people | find the data and privacy answer without asking |
| going to ask "who else uses this?" | see real programmes, not stock photography |
| suspicious of AI claims, because everyone claims them | see **evidence**: a real day, real numbers, a published accuracy figure |

And the coach who forwarded it needs something to paste. That is why the
headline has to be a sentence, not a slogan.

### The evidence advantage

Nobody in the survey publishes an accuracy number for their wind estimation.
RaceQs is the only one with a public figure at all (3–5° single boat, ~1° with
five) and it is not even a competitor. Everyone else says "ML-based" and stops.

SSA is about to have a defensible number (§7 of the plan: 109 paired hours,
1,067 paired manoeuvres already in hand). **Publishing it is the single most
differentiating thing the site can do**, because it is the one claim a
better-funded competitor cannot match by shipping faster — they would have to
go and get the paired data first.

Until it exists, the site says what is measured today and does not bluff.

---

## 3. Decisions

| decision | choice | why |
|---|---|---|
| where it lives | **`/` for logged-out visitors**, the app at `/` for signed-in | it is the front door; a link with a path on it is not |
| primary CTA | **Request access** → a row in the database | no free tier to offer, and it gives a pipeline that can be counted for investors |
| secondary CTA | Sign in | the crew's daily path, never buried |
| price | **shown, in full** | filters the wrong buyer before they cost you a call, and anchors against an analyst's day rate |
| free trial | **none** | it would contradict §2 of the plan on the first screen |
| support | one page, not a help desk | a solo founder cannot staff Hudl Academy |
| manual structure | task-grouped chapters + **role badges from the real permission matrix** | Vantage's structure, with the thing they cannot do |

### What is deliberately not built

- **No blog.** A blog with three posts and a six-month gap is worse than none.
- **No live chat.** It promises a response time that cannot be kept in June.
- **No newsletter capture.** Nothing to send.
- **No testimonials until they are real and attributed.** In a sport this small
  an unattributed quote is read as a fabricated one.
- **No cookie banner**, because there is no analytics cookie to consent to.
  Every competitor has one; not needing it is the better answer.

---

## 4. What shipped

| route | public | what |
|---|---|---|
| `/` | anon only | front page: what it is, who it is for (two front doors), evidence, price, request access |
| `/features` | yes | what the product does, grouped by the day rather than by tab |
| `/pricing` | yes | the three plans, founding rates, and the FAQ a budget holder asks |
| `/support` | yes | the manual: task-grouped chapters with role badges, plus Q&A |
| `/request-access` | yes | the form; writes `access_requests` |

Signed-in users are unaffected: `/` still renders the app, and nothing in the
auth gate changed for them.

---

## 5. What to measure

The site is not a funnel, so funnel metrics would mislead. Three numbers:

1. **Access requests per month, and how many came from a named referrer.**
   Word of mouth is the strategy; if requests do not carry a referrer, it is not
   working and the site is not the reason.
2. **Request → conversation → signed.** With a handful of customers this is
   counted by hand, which is appropriate.
3. **Support-page reads against support messages received.** The manual is doing
   its job when the second number falls while the first rises. That is the only
   metric that matters for surviving a season at near-zero founder capacity.
