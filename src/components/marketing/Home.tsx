// The front page. Its job is not to convert a stranger — it is to survive being
// forwarded, because word of mouth here looks like a coach sending a programme
// manager a link on WhatsApp (docs/web-and-support-2026-09.md §5).
//
// So: one sentence saying what it is, the price in full, evidence rather than
// adjectives, and a plain statement of what it does not do yet. The last of
// those is the credibility mechanism, not a risk — with one reference customer,
// candour is the fastest route to being believed.
import Link from 'next/link'
import { Shell, Card } from './Shell'
import HeroVideo from './HeroVideo'
import CountUp from './CountUp'

// The four numbers that carry the "measured, not claimed" claim. They count up
// when they scroll into view — see CountUp for why that is the one piece of
// JavaScript on this page's motion layer.
const STATS = [
  { v: 731, s: '', l: 'clips joined to the day they were shot' },
  { v: 133000, s: '', l: 'rows of instrument data on one season' },
  { v: 109, s: ' h', l: 'of measured wind paired with raw GPS track' },
  { v: 1067, s: '', l: 'tacks and gybes measured, not estimated' },
]

export default function Home() {
  return (
    <Shell>
      {/* ── What it is, in one sentence a coach can paste ─────────────────── */}
      <section className="border-b border-border py-16 sm:py-24">
        <div className="mb-4 text-[12px] font-bold uppercase tracking-[0.14em] text-accent">
          Built with the 2026 Maxi World Champion
        </div>
        <h1 className="max-w-3xl text-[30px] font-bold leading-[1.18] tracking-tight sm:text-[44px] sm:leading-[1.1]">
          The whole of a sailing day, on one timeline, with the whole team — before dinner.
        </h1>
        <p className="mt-6 max-w-2xl text-[16px] leading-relaxed text-secondary">
          Video, photos, instrument data, the forecast, sail shape, rig numbers and what the
          team actually said about it — joined to the minute they happened, and shared with
          everyone on the programme rather than sitting on the analyst&rsquo;s laptop.
        </p>
        <div className="mt-8 flex flex-wrap items-center gap-3">
          <Link href="/request-access" className="ssa-lift rounded-lg bg-accent px-5 py-2.5 text-[14px] font-semibold text-accent-fg transition-opacity hover:opacity-90">
            Request access
          </Link>
          <Link href="/features" className="rounded-lg border border-border px-5 py-2.5 text-[14px] text-secondary transition-colors hover:border-border-strong hover:text-fg">
            What it does
          </Link>
          <span className="text-[13px] text-muted">From €1,200/yr. Every boat included. No free tier.</span>
        </div>

        {/* The boat, before the claims. A programme manager who has never heard
            of SSA reads the headline and then wants to know whether these people
            actually sail — this answers that before the evidence section has to. */}
        <div className="mt-12">
          <HeroVideo />
        </div>
      </section>

      {/* ── Two front doors, one product ──────────────────────────────────── */}
      <section className="ssa-reveal border-b border-border py-12 sm:py-16">
        <h2 className="ssa-rule text-[20px] font-bold tracking-tight sm:text-[24px]">Who it is for</h2>
        <div className="mt-7 grid gap-4 sm:grid-cols-2">
          <Card title="Grand-prix programmes" index={0}>
            A fully instrumented boat: Expedition logs, masthead wind, lidar sail shape, rig
            loads. SSA joins all of it to the day&rsquo;s video and photos, runs the phase and
            manoeuvre analysis, and puts the result in front of the whole crew — not just
            whoever imported the data.
          </Card>
          <Card title="Olympic and class squads" index={1}>
            Boats with a GPS tracker and nothing else. SSA derives the wind from the track,
            so the same phase stats, manoeuvre analysis and start work apply — and a squad
            can compare its boats against each other, day by day.
          </Card>
        </div>
        <p className="mt-5 max-w-2xl text-[14px] leading-relaxed text-muted">
          One product, not two. What changes between an ILCA and a 76-foot maxi is which
          channels the boat records, and SSA states which of those every number came from —
          measured, derived, or modelled.
        </p>
      </section>

      {/* ── Evidence, not adjectives ──────────────────────────────────────── */}
      <section className="ssa-reveal border-b border-border py-12 sm:py-16">
        <h2 className="ssa-rule text-[20px] font-bold tracking-tight sm:text-[24px]">Measured, not claimed</h2>
        <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-secondary">
          Every sailing-analytics tool says it finds the wind from your track. None of them
          publishes how close it gets. These are SSA&rsquo;s own numbers, from real seasons.
        </p>
        <div className="mt-7 grid gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-4">
          {STATS.map((stat, i) => (
            <div
              key={stat.l}
              className="ssa-reveal-item bg-surface-1 p-5"
              style={{ '--i': i } as React.CSSProperties}
            >
              <div className="text-[26px] font-bold tracking-tight text-accent">
                <CountUp value={stat.v} suffix={stat.s} />
              </div>
              <div className="mt-1.5 text-[13px] leading-snug text-muted">{stat.l}</div>
            </div>
          ))}
        </div>
        <p className="mt-5 max-w-2xl text-[14px] leading-relaxed text-muted">
          The last two are the ones that matter. Measured wind recorded alongside the same raw
          track a tracker-only boat produces is what makes deriving wind from a bare GPS trace
          checkable rather than a claim — and it is a by-product of serving instrumented boats
          and dinghies on one platform.
        </p>
      </section>

      {/* ── What it does not do. The credibility mechanism. ────────────────── */}
      <section className="ssa-reveal border-b border-border py-12 sm:py-16">
        <h2 className="ssa-rule text-[20px] font-bold tracking-tight sm:text-[24px]">Where SSA is today</h2>
        <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-secondary">
          You are going to ask, so here it is without the varnish.
        </p>
        <ul className="mt-6 max-w-2xl space-y-3 text-[14px] leading-relaxed text-secondary">
          <li className="border-l-2 border-border pl-4">
            <b className="text-fg">It is in daily use by one grand-prix programme</b> — Northstar,
            which won the 2026 Maxi World Championship — across two boats and a full season. One
            programme is still one programme, and we are looking for three more teams for 2027,
            which is why the founding rates exist.
          </li>
          <li className="border-l-2 border-border pl-4">
            <b className="text-fg">Wind from a GPS track is being built now</b>, on the paired data
            above. We have not published an accuracy figure yet. When we do it will be a number
            you can hold us to, against the best public benchmark in the field.
          </li>
          <li className="border-l-2 border-border pl-4">
            <b className="text-fg">There is no individual-sailor plan</b> and there will not be one
            this year. SSA is sold to programmes and squads, with everyone on the team included.
          </li>
          <li className="border-l-2 border-border pl-4">
            <b className="text-fg">Onboarding is done with you, not by a signup form.</b> That is a
            deliberate limit on how many teams come aboard at once, and it is why there is no
            free trial button on this page.
          </li>
        </ul>
      </section>

      {/* ── Price, in full ────────────────────────────────────────────────── */}
      <section className="ssa-reveal border-b border-border py-12 sm:py-16">
        <h2 className="ssa-rule text-[20px] font-bold tracking-tight sm:text-[24px]">What it costs</h2>
        <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-secondary">
          Annual, invoiced, everyone on the team included — and every boat in the programme,
          which is where tools priced per hull charge you twice. A budget holder cannot start
          an approval without a number, so here are all of them.
        </p>
        <div className="mt-7 grid gap-4 sm:grid-cols-3">
          {[
            { name: 'Coach', price: '€1,200', who: 'One coach, up to 3 boats' },
            { name: 'Squad', price: '€3,000', who: 'A coach and up to 8 boats' },
            { name: 'Programme', price: '€6,000', who: 'One instrumented campaign, every boat included' },
          ].map((p) => (
            <div key={p.name} className="ssa-card rounded-xl border border-border bg-surface-1 p-5">
              <div className="text-[13px] font-bold uppercase tracking-wider text-muted">{p.name}</div>
              <div className="mt-2 text-[24px] font-bold tracking-tight">{p.price}<span className="text-[14px] font-normal text-muted">/year</span></div>
              <div className="mt-2 text-[13px] leading-snug text-secondary">{p.who}</div>
            </div>
          ))}
        </div>
        <p className="mt-5 text-[14px] text-muted">
          Founding rates are half of these for contracts signed before 31 March 2027, held for
          two years. <Link href="/pricing" className="text-accent hover:underline">Full pricing and questions →</Link>
        </p>
      </section>

      {/* ── Close ─────────────────────────────────────────────────────────── */}
      <section className="ssa-reveal py-16 sm:py-20">
        <h2 className="max-w-2xl text-[22px] font-bold leading-snug tracking-tight sm:text-[28px]">
          If someone on your programme sent you this, they have already done the hard part.
        </h2>
        <p className="mt-4 max-w-2xl text-[15px] leading-relaxed text-secondary">
          Tell us what you sail and we will show you a real day from a real season — yours, if
          you can send us a log and a few clips.
        </p>
        <div className="mt-7 flex flex-wrap items-center gap-3">
          <Link href="/request-access" className="ssa-lift rounded-lg bg-accent px-5 py-2.5 text-[14px] font-semibold text-accent-fg transition-opacity hover:opacity-90">
            Request access
          </Link>
          <a href="mailto:wouterv@runbox.com" className="text-[14px] text-secondary hover:text-fg">
            or email wouterv@runbox.com
          </a>
        </div>
      </section>
    </Shell>
  )
}
