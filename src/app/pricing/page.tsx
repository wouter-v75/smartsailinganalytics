// Pricing, in full, with the questions a budget holder actually asks.
//
// Showing every number is the deliberate choice (docs/web-and-support-2026-09.md
// §5): SSA has no scale to substitute for a price the way Catapult does, and
// "contact for pricing" reads to a programme manager as "we will work out what
// you can afford". The questions below are procurement questions — ownership,
// GDPR, exit, who can see what — not invented enthusiasm.
import type { Metadata } from 'next'
import { pageMeta } from '../../lib/siteMeta'
import Link from 'next/link'
import { Shell, Hero, Section } from '../../components/marketing/Shell'

export const metadata: Metadata = pageMeta({
  title: 'Pricing',
  description:
    'Coach €1,200, Squad €3,000, Programme €6,000 per year. Every boat in the programme included, no per-seat charge. Founding rates until 31 March 2027.',
  path: '/pricing',
})

const PLANS = [
  {
    name: 'Coach',
    price: '€1,200',
    founding: '€600',
    who: 'One coach, up to 3 boats.',
    includes: [
      'Tracker and log import',
      'Wind derived from the track',
      'Phase, manoeuvre and start analysis',
      'Video, photos and the debrief',
      'Everyone the coach invites',
    ],
  },
  {
    name: 'Squad',
    price: '€3,000',
    founding: '€1,500',
    who: 'A coach and up to 8 boats — a class squad or a national programme.',
    highlight: true,
    includes: [
      'Everything in Coach',
      'Squad sharing between boats, category by category',
      'Boat-against-boat comparison',
      'Season trends across the squad',
      'Unlimited crew and staff',
    ],
  },
  {
    name: 'Programme',
    price: '€6,000',
    founding: '€3,000',
    who: 'One instrumented grand-prix campaign — every boat it runs, included.',
    includes: [
      'Everything in Squad',
      'Full instrument logs at full rate',
      'SailScan sail shape, lidar where you have it',
      'Rig and sail versioning',
      'Time-windowed consultant access',
      'Direct support line',
    ],
  },
]

const QA = [
  {
    q: 'Who owns the data?',
    a: 'You do. Your logs, video, photos and debriefs are yours, and you can export them. Our contract asks separately for permission to use de-identified days to improve the analysis — you can say no to that and keep everything else.',
  },
  {
    q: 'Where is it stored, and is it GDPR-compliant?',
    a: 'In the EU, with no US fallback \u2014 database in Ireland, video on European edge storage, and all AI inference inside an EU account in France. Video and photographs of identifiable crew are personal data, so a data-processing agreement is part of the contract rather than an afterthought. The full subprocessor list and the AI rules are on the Data & AI page.',
  },
  {
    q: 'What happens if we stop paying?',
    a: 'You get your data out. We will not hold a season hostage to a renewal — export first, then close the account.',
  },
  {
    q: 'Who on the team can see what?',
    a: 'Roles are per team and per boat: coaches and team managers see everything, sailors see the day and its media, consultants get access only inside a date window that you set, and guests see the latest day only. Rig numbers and tuning are never shared with another boat unless you turn it on.',
  },
  {
    q: 'Do you work with our instruments?',
    a: 'Expedition and the common log exports, plus Vakaros, Sailmon, Velocitek, phones, watches and GoPro. If the boat records nothing at all, a GPS tracker is enough. The honest answer for your boat is a two-minute conversation.',
  },
  {
    q: 'Is there a free trial?',
    a: 'No. Onboarding is done with you rather than by a signup form, which limits how many teams come aboard at once. What we do instead is show you a real day from a real season — yours, if you can send a log and a few clips.',
  },
  {
    q: 'Why is there no per-sailor price?',
    a: 'Because the product is worth something only when the whole team is on it. Every plan includes everyone on the programme — crew, coach, analyst, owner — with no per-seat charge.',
  },
  {
    q: 'What does a founding rate commit us to?',
    a: 'Half price for two years, in exchange for a signed contract before 31 March 2027, permission to use your days de-identified, and an agreed number of properly tagged and debriefed days a season. We are buying evidence and a reference, and saying so.',
  },
  {
    q: 'What if we have more than one boat?',
    a: 'A programme is not a boat, and the Programme plan includes every boat the campaign runs. This is the main way SSA differs from tools priced per hull: a team running a 72 and a 76 is one customer here, and two everywhere else.',
  },
  {
    q: 'How does this compare with Njord?',
    a: 'Njord prices per boat and per class — at the time of writing, €5,599 a year for a single Maxi 72 and €10,049 for two, on their own published calculator. SSA is one price for the whole programme. At the dinghy end Njord is the cheaper option for a single boat, and we would tell you so. The two products also do different things: Njord is analysis and a video player, SSA adds the recorded debrief, sail shape and getting the day to the whole crew.',
  },
  {
    q: 'We have three seasons of old data. Does importing it cost extra?',
    a: 'No. Anything older than 180 days loads free, on any plan, however much of it there is. Bring your history — it makes the season trends useful on day one rather than in a year.',
  },
]

export default function PricingPage() {
  return (
    <Shell>
      <Hero eyebrow="Pricing" title="Annual, invoiced, everyone on the team included">
        No per-seat charge, no free tier, no usage meter, and every boat in the programme
        included. A grand-prix plan is five to ten days of a freelance analyst&rsquo;s time, for a
        season. A budget holder cannot start an approval without a number, so all of them are
        on this page.
      </Hero>

      <Section title="Plans">
        <div className="grid gap-4 lg:grid-cols-3">
          {PLANS.map((p, i) => (
            <div
              key={p.name}
              style={{ '--i': i } as React.CSSProperties}
              className={`ssa-card ssa-reveal-item flex flex-col rounded-xl border bg-surface-1 p-6 ${
                p.highlight ? 'border-accent' : 'border-border'
              }`}
            >
              <div className="flex items-center gap-2">
                <div className="text-[13px] font-bold uppercase tracking-wider text-muted">{p.name}</div>
                {p.highlight && (
                  <span className="rounded-full bg-accent-bg px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-accent">
                    Most teams
                  </span>
                )}
              </div>
              <div className="mt-3 text-[30px] font-bold tracking-tight">
                {p.price}
                <span className="text-[14px] font-normal text-muted">/year</span>
              </div>
              <div className="mt-1 text-[13px] text-accent">{p.founding}/year at the founding rate</div>
              <p className="mt-3 text-[13px] leading-relaxed text-secondary">{p.who}</p>
              <ul className="mt-5 flex-1 space-y-2 text-[13px] leading-relaxed text-secondary">
                {p.includes.map((i) => (
                  <li key={i} className="flex gap-2">
                    <span aria-hidden="true" className="text-accent">·</span>
                    <span>{i}</span>
                  </li>
                ))}
              </ul>
              <Link
                href="/request-access"
                className={`mt-6 rounded-lg px-4 py-2.5 text-center text-[14px] font-semibold transition-opacity hover:opacity-90 ${
                  p.highlight
                    ? 'bg-accent text-accent-fg'
                    : 'border border-border text-secondary hover:border-border-strong hover:text-fg'
                }`}
              >
                Request access
              </Link>
            </div>
          ))}
        </div>

        <div className="mt-6 rounded-xl border border-border bg-surface-1 p-5 text-[14px] leading-relaxed text-secondary">
          <b className="text-fg">Founding rates</b> are half list, held for two years, for contracts
          signed before <b className="text-fg">31 March 2027</b>. They are the only discount that
          exists — there is no negotiation ladder, and nobody who signs later pays less than
          someone who signed early.
        </div>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div className="rounded-xl border border-border bg-surface-1 p-5 text-[14px] leading-relaxed text-secondary">
            <b className="text-fg">Every boat in the programme is included.</b> Tools priced per
            hull charge again for the second boat. A campaign running a 72 and a 76 pays once
            here — which is the main reason the Programme plan is worth its number.
          </div>
          <div className="rounded-xl border border-border bg-surface-1 p-5 text-[14px] leading-relaxed text-secondary">
            <b className="text-fg">Old data is free to load.</b> Anything recorded more than 180
            days ago imports at no charge, on any plan. Your season trends should start full, not
            empty.
          </div>
        </div>
      </Section>

      <Section
        title="Questions a budget holder asks"
        lead="These are the ones that come up in every conversation, answered the way they get answered on a call."
      >
        <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface-1">
          {QA.map((item) => (
            <div key={item.q} className="p-5">
              <h3 className="text-[15px] font-bold">{item.q}</h3>
              <p className="mt-2 text-[14px] leading-relaxed text-secondary">{item.a}</p>
            </div>
          ))}
        </div>
      </Section>

      <section className="ssa-reveal py-14">
        <h2 className="ssa-rule text-[20px] font-bold tracking-tight sm:text-[24px]">Still the wrong shape?</h2>
        <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-secondary">
          Class associations, federations and events are priced case by case, and hardware or
          service partners are a different conversation again. Say which you are and we will
          answer properly rather than steering you into a plan.
        </p>
        <div className="mt-6">
          <Link href="/request-access" className="rounded-lg bg-accent px-5 py-2.5 text-[14px] font-semibold text-accent-fg hover:opacity-90">
            Start the conversation
          </Link>
        </div>
      </section>
    </Shell>
  )
}
