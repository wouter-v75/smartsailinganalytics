// Support: the manual and the Q&A, on one page.
//
// Built to the rules in docs/web-and-support-2026-09.md §4:
//   - chapters grouped by TASK, titles starting with a VERB (GOV.UK)
//   - role badges from the real seven-role permission matrix, so a reader can
//     skip what is not theirs (Vantage's structure, done better)
//   - the answer FIRST, context after
//   - questions in the reader's words, grouped so most can be ruled out in
//     seconds, and NO invented questions (NN/g: made-up FAQs were #7 on the
//     top-10 web design mistakes list)
//   - no search box: under ten pages, a scannable list beats a field that
//     mostly returns nothing
//   - limitations stated plainly, because that is the tacit question every
//     reader is really asking
import type { Metadata } from 'next'
import { pageMeta } from '../../lib/siteMeta'
import Link from 'next/link'
import { Shell, Hero } from '../../components/marketing/Shell'

export const metadata: Metadata = pageMeta({
  title: 'Support and manual',
  description:
    'How to import a day, sync video, record a debrief, share with a squad and fix the things that go wrong. Plus what SSA reads, and what it does not do yet.',
  path: '/support',
})

// Only the roles a READER of this manual can hold. The site-admin role is ours,
// not a customer's, and badging a chapter with it told a coach nothing except
// that there is a door they cannot open.
type Role = 'Everyone' | 'Coach' | 'Sailor'

// Every named role gets a colour of its own. Sailor was grey-on-grey, which read
// as "not applicable to you" — the exact opposite of what a badge on a chapter is
// for, and wrong: a sailor may tag, record a note and upload media. 'Everyone'
// stays neutral on purpose; it is the absence of a restriction, not a role you
// are singled out by.
// border-current, not border-accent/50: these colours are CSS variables, and
// Tailwind's /opacity modifier cannot compute alpha from a var() — it silently
// drops the rule and the badge falls back to the default light-grey border,
// which on a dark card is the washed-out look this was meant to fix.
// currentColor gives each badge a border in its own colour, for free.
const ROLE_STYLE: Record<Role, string> = {
  Everyone: 'border-border text-muted',
  Coach: 'border-current text-accent',
  Sailor: 'border-current text-success',
}

type Chapter = { title: string; roles: Role[]; steps: string[]; note?: string }
type Part = { part: string; blurb: string; chapters: Chapter[] }

const MANUAL: Part[] = [
  {
    part: 'Get started',
    blurb: 'First day on SSA. Fifteen minutes, once.',
    chapters: [
      {
        title: 'Accept your invitation',
        roles: ['Everyone'],
        steps: [
          'Open the invitation link your coach or team manager sent you.',
          'Set a password, or sign in if you already have an account.',
          'You land on the most recent day for your boat.',
        ],
        note: 'Accounts are created by invitation only — there is no public signup. If the link has expired, ask whoever invited you to send another.',
      },
      {
        title: 'Find your way around',
        roles: ['Everyone'],
        steps: [
          'Pick the boat and the date at the top — everything on screen follows that choice.',
          'Campaign is the day itself: plan, weather, the debrief and the notes.',
          'Videos, Photos and Analytics are the day’s material and its numbers.',
          'Timeline zooms out: season, regatta, day, race.',
        ],
      },
      {
        title: 'Set up your boat',
        roles: ['Coach'],
        steps: [
          'Open Boat config and add the boat’s sail wardrobe.',
          'Add the rig settings you start the season on.',
          'Tell us what the boat records — instruments, a tracker, or nothing — so the analysis matches.',
        ],
        note: 'The sail wardrobe is not paperwork for its own sake: it feeds the debrief transcription, so your sail names come out right instead of as mishearings.',
      },
    ],
  },
  {
    part: 'Record a day',
    blurb: 'Getting the day off the boat and into SSA. This is where most problems start, so it is worth doing in this order.',
    chapters: [
      {
        title: 'Import the day’s log',
        roles: ['Coach', 'Sailor'],
        steps: [
          'Open Upload and drop in the day’s log export.',
          'Check the date and boat SSA inferred, and correct them if they are wrong.',
          'Confirm. The log is parsed, the phases found, and the day appears.',
        ],
        note: 'Senior sailors can import too, not just the coach — which is the point for a squad, where the coach does not hold everyone’s tracker and each sailor uploads their own track to their own boat. If Upload refuses you, ask your coach to move you up a level. Import a day once: re-importing the same day’s log replaces what is stored for it, so if you are trying to fix something else, ask us first.',
      },
      {
        title: 'Upload video and photos',
        roles: ['Coach', 'Sailor'],
        steps: [
          'Drop clips and photos into Upload — phone, GoPro, drone or coach boat.',
          'Leave the tab open while they transcode. Large clips take a while.',
          'Photos pick up the instrument state at the moment of the shutter automatically.',
        ],
        note: 'Upload the day’s log BEFORE its photos. The instrument data attached to a photo is read from the log, so photos imported first come out blank for everyone except you.',
      },
      {
        title: 'Sync a clip to the data',
        roles: ['Coach', 'Sailor'],
        steps: [
          'Open the clip in Videos and find a moment you can also see in the data — a tack works well.',
          'Nudge the offset until the two agree.',
          'Save. Every tag and chart on that clip now lines up.',
        ],
        note: 'Camera clocks drift and are usually set to a different timezone from the boat. A clip that looks a few minutes out is normal and is exactly what this fixes.',
      },
    ],
  },
  {
    part: 'Debrief',
    blurb: 'The part that decides whether recording the day was worth it.',
    chapters: [
      {
        title: 'Record a spoken note',
        roles: ['Coach', 'Sailor'],
        steps: [
          'Press Record on any note — the plan, the weather, or a debrief field.',
          'Talk. Press Stop.',
          'Read what comes back against what you said, edit it, then add it to the note.',
        ],
        note: 'Works on a phone, so it works on the dock. Nothing is saved to a note until you approve it, and if the tidy-up fails you get the raw transcript rather than losing what you said.',
      },
      {
        title: 'Summarise a whole meeting',
        roles: ['Coach'],
        steps: [
          'Record the debrief on any device, then open the section it belongs to.',
          'Choose Summarise from a recording and pick the audio file.',
          'Review the draft section by section before saving.',
        ],
        note: 'Desktop only — an hour of audio is real work for a laptop and too much for a phone. Always read the draft against what was said: it is a good assistant and a bad witness.',
      },
      {
        title: 'Tag the moments that mattered',
        roles: ['Coach', 'Sailor'],
        steps: [
          'Mark a moment on the track, a clip or a photo.',
          'Pick a tag from the team’s vocabulary, or add a new one.',
          'Find it again from any day in the season.',
        ],
      },
    ],
  },
  {
    part: 'Share',
    blurb: 'Getting the day in front of people — which is the whole point.',
    chapters: [
      {
        title: 'Invite your crew',
        roles: ['Coach'],
        steps: [
          'Open the team’s people list and send an invitation.',
          'Pick the role: coach, sailor, consultant or guest.',
          'For a consultant, set the dates their access starts and stops.',
        ],
        note: 'A consultant’s access ends by itself on the date you set. You do not have to remember to remove them.',
      },
      {
        title: 'Send one clip to someone outside the team',
        roles: ['Coach', 'Sailor'],
        steps: [
          'Open the clip and choose Share.',
          'Send the link. The recipient needs no account.',
          'Revoke it whenever you like.',
        ],
        note: 'A share link grants exactly one clip and nothing else.',
      },
      {
        title: 'Share days with another boat',
        roles: ['Coach'],
        steps: [
          'Set up a squad with the other owners.',
          'Choose which categories you contribute: tracks and analysis, photos, video.',
          'Contribute a day to pull a day.',
        ],
        note: 'Rig settings and tuning numbers are off by default and stay off unless you turn them on. Debriefs and notes are not shareable at all — a team’s own words about its own performance stay with that team.',
      },
    ],
  },
  {
    part: 'When something is wrong',
    blurb: 'The things that actually go wrong, and what to do about them.',
    chapters: [
      {
        title: 'Fix photos that are blank for everyone but you',
        roles: ['Coach'],
        steps: [
          'Check that the day’s log was imported before the photos.',
          'If it was not, tell us the date and boat — we can repair it without you re-importing.',
        ],
        note: 'This is the single most common problem. The instrument data behind a photo is attached at import, so if the photos went up first they look right to you and empty to everyone else.',
      },
      {
        title: 'Fix a clip that will not play on a phone',
        roles: ['Everyone'],
        steps: [
          'Give it a few minutes — a clip is not playable until it has finished transcoding.',
          'Reload the day.',
          'If it still fails, send us the clip name and the day.',
        ],
      },
      {
        title: 'Fix a day on the wrong date',
        roles: ['Coach'],
        steps: [
          'Check the timezone the log was exported in.',
          'Tell us the boat and what the date should be.',
        ],
        note: 'Log exports, camera clocks and photo timestamps are all local wall-time even when they are labelled UTC. A day that lands one date out is almost always this.',
      },
      {
        title: 'Get help',
        roles: ['Everyone'],
        steps: [
          'Email wouterv@runbox.com with the boat, the date and what you expected to see.',
          'A screenshot saves a round trip.',
        ],
        note: 'Out of season, replies are usually same-day. Between April and September we are on the water a lot ourselves, so it can be a tad slow — anything that stops a team working is still handled first.',
      },
    ],
  },
]

const QA: { group: string; items: { q: string; a: string }[] }[] = [
  {
    group: 'Getting in',
    items: [
      {
        q: 'I cannot sign up',
        a: 'There is no public signup. Accounts are created by invitation from your coach or team manager — ask them to send you one.',
      },
      {
        q: 'My account says it is awaiting approval',
        a: 'Your team manager activates it — ask them, it takes them a moment. Only come to us if there is nobody in your team who can.',
      },
      {
        q: 'Can I use it on my phone?',
        a: 'Yes, and most of the team only ever does. Watching the day, reading the debrief, tagging and recording a spoken note all work on a phone. Importing a day and summarising a long meeting are desktop jobs.',
      },
    ],
  },
  {
    group: 'Data and privacy',
    items: [
      {
        q: 'Who can see our video?',
        a: 'Only people your team has invited, and only for the boats they are on. Nothing is public. A share link grants exactly one clip and can be revoked.',
      },
      {
        q: 'Where is our data held?',
        a: 'In the EU — the database in Ireland, video on European edge storage.',
      },
      {
        q: 'Do you use our data to train anything?',
        a: 'No model is trained on your recordings, video or debrief text, ever. Improving the analysis uses de-identified sailing data only \u2014 tracks, wind, manoeuvres \u2014 with separate permission you can decline. See the Data & AI page for the whole of it.',
      },
      {
        q: 'Can we get our data out?',
        a: 'Yes, including if you leave. Ask and we will export it.',
      },
    ],
  },
  {
    group: 'Boats and equipment',
    items: [
      {
        q: 'Our boat has no instruments at all',
        a: 'That is fine and increasingly the normal case. A GPS tracker — Vakaros, Sailmon, Velocitek, a phone or a watch — is enough. SSA derives the wind from the track and the same analysis follows.',
      },
      {
        q: 'Do you support our class?',
        a: 'SSA is not organised by class. What matters is which channels the boat records, which is why the honest answer is a short conversation rather than a list.',
      },
      {
        q: 'How accurate is the derived wind?',
        a: 'We have not published a figure yet, and we are not going to quote one until we can defend it. It is being built on 109 hours of measured wind recorded alongside raw GPS track. When there is a number it will be published against the best public benchmark in the field.',
      },
    ],
  },
]

export default function SupportPage() {
  return (
    <Shell>
      <Hero eyebrow="Support" title="The manual, and the questions people actually ask">
        Written for someone in a hurry who has just lost a day&rsquo;s photos. Every chapter
        says who it is for, so you can skip what is not yours.
      </Hero>

      {/* Contents — the reader should be able to rule out most of this in seconds. */}
      <nav className="border-b border-border py-8" aria-label="Contents">
        <div className="text-[12px] font-bold uppercase tracking-[0.14em] text-muted">Contents</div>
        <div className="mt-4 grid gap-2 sm:grid-cols-3">
          {MANUAL.map((p) => (
            <a key={p.part} href={`#${slug(p.part)}`} className="ssa-lift rounded-lg border border-border bg-surface-1 px-4 py-3 text-[14px] font-semibold transition-colors hover:border-border-strong">
              {p.part}
            </a>
          ))}
          <a href="#qa" className="ssa-lift rounded-lg border border-border bg-surface-1 px-4 py-3 text-[14px] font-semibold transition-colors hover:border-border-strong">
            Common questions
          </a>
          <a href="#classes" className="ssa-lift rounded-lg border border-border bg-surface-1 px-4 py-3 text-[14px] font-semibold transition-colors hover:border-border-strong">
            What SSA reads
          </a>
          <a href="#limits" className="ssa-lift rounded-lg border border-border bg-surface-1 px-4 py-3 text-[14px] font-semibold transition-colors hover:border-border-strong">
            What it does not do yet
          </a>
        </div>
      </nav>

      {MANUAL.map((part) => (
        <section key={part.part} id={slug(part.part)} className="ssa-reveal scroll-mt-24 border-b border-border py-12">
          <h2 className="ssa-rule text-[20px] font-bold tracking-tight sm:text-[24px]">{part.part}</h2>
          <p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-secondary">{part.blurb}</p>

          <div className="mt-7 space-y-4">
            {part.chapters.map((c, i) => (
              <article
                key={c.title}
                style={{ '--i': i } as React.CSSProperties}
                className="ssa-card ssa-reveal-item rounded-xl border border-border bg-surface-1 p-5"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-[15px] font-bold">{c.title}</h3>
                  {c.roles.map((r) => (
                    <span key={r} className={`rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${ROLE_STYLE[r]}`}>
                      {r}
                    </span>
                  ))}
                </div>
                <ol className="mt-3 space-y-2">
                  {c.steps.map((s, i) => (
                    <li key={s} className="flex gap-3 text-[14px] leading-relaxed text-secondary">
                      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-border text-[11px] font-bold text-muted">
                        {i + 1}
                      </span>
                      <span>{s}</span>
                    </li>
                  ))}
                </ol>
                {c.note && (
                  <p className="mt-4 border-l-2 border-accent/50 pl-3 text-[13px] leading-relaxed text-muted">
                    {c.note}
                  </p>
                )}
              </article>
            ))}
          </div>
        </section>
      ))}

      {/* ── Q&A ───────────────────────────────────────────────────────────── */}
      <section id="qa" className="scroll-mt-24 border-b border-border py-12">
        <h2 className="ssa-rule text-[20px] font-bold tracking-tight sm:text-[24px]">Common questions</h2>
        <p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-secondary">
          Grouped so you can rule out most of them at a glance.
        </p>
        <div className="mt-7 space-y-8">
          {QA.map((g) => (
            <div key={g.group}>
              <div className="mb-3 text-[12px] font-bold uppercase tracking-[0.14em] text-accent">{g.group}</div>
              <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface-1">
                {g.items.map((item) => (
                  <div key={item.q} className="p-5">
                    <h3 className="text-[15px] font-bold">{item.q}</h3>
                    <p className="mt-2 text-[14px] leading-relaxed text-secondary">{item.a}</p>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ── What SSA reads ────────────────────────────────────────────────── */}
      <section id="classes" className="scroll-mt-24 border-b border-border py-12">
        <h2 className="ssa-rule text-[20px] font-bold tracking-tight sm:text-[24px]">What SSA reads</h2>
        <p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-secondary">
          SSA is organised by what a boat records, not by class. A 76-foot maxi and an ILCA use
          the same product; what differs is how many of these rows apply.
        </p>
        <div className="mt-7 grid gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-2">
          {[
            ['Instrument logs', 'Expedition and the common flat log exports, at full rate.'],
            ['GPS trackers', 'Vakaros, Sailmon, Velocitek, phone, watch, GoPro.'],
            ['Event and race files', 'Race guns, marks and leg structure where the boat has them.'],
            ['Video', 'Phone, GoPro, drone, coach boat — most formats.'],
            ['Photos', 'Any camera. Sail photos are read for shape where the sail has stripes.'],
            ['Lidar', 'Sail-shape logs where the boat carries a scanner.'],
            ['Forecast', 'High-resolution venue forecasts, joined to the day automatically.'],
            ['Nothing at all', 'A phone in a pocket is a tracker. Start there.'],
          ].map(([t, d]) => (
            <div key={t} className="bg-surface-1 p-5">
              <div className="text-[14px] font-bold">{t}</div>
              <div className="mt-1.5 text-[13px] leading-relaxed text-muted">{d}</div>
            </div>
          ))}
        </div>
      </section>

      {/* ── Limitations. The tacit question. ──────────────────────────────── */}
      <section id="limits" className="scroll-mt-24 border-b border-border py-12">
        <h2 className="ssa-rule text-[20px] font-bold tracking-tight sm:text-[24px]">What it does not do yet</h2>
        <p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-secondary">
          You are going to find this out anyway, so you may as well find it out here.
        </p>
        <ul className="mt-6 max-w-2xl space-y-3 text-[14px] leading-relaxed text-secondary">
          <li className="border-l-2 border-border pl-4">
            <b className="text-fg">No published wind-accuracy figure.</b> Deriving wind from a bare
            GPS track is being built on measured data now. Until there is a number we will defend,
            there is no number.
          </li>
          <li className="border-l-2 border-border pl-4">
            <b className="text-fg">No live on-the-water use.</b> SSA is for before and after, not
            during. Nothing streams off the boat while you are racing.
          </li>
          <li className="border-l-2 border-border pl-4">
            <b className="text-fg">No individual-sailor plan.</b> Sold to programmes and squads,
            with the whole team included.
          </li>
          <li className="border-l-2 border-border pl-4">
            <b className="text-fg">Support is slower in season, because we sail too — a lot.</b>
            Out of season a reply is usually same-day. Between April and September it can be a tad
            slow, with anything that stops a team working handled first. If that is a problem for
            how your programme runs, say so before you sign rather than after.
          </li>
        </ul>
      </section>

      <section className="py-14">
        <h2 className="ssa-rule text-[20px] font-bold tracking-tight sm:text-[24px]">Not answered here?</h2>
        <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-secondary">
          Email <a href="mailto:wouterv@runbox.com" className="text-accent hover:underline">wouterv@runbox.com</a> with
          the boat, the date and what you expected to see. Every question that arrives is treated
          as something the product or this page got wrong, and fixed in that order.
        </p>
        <div className="mt-6">
          <Link href="/request-access" className="rounded-lg border border-border px-5 py-2.5 text-[14px] text-secondary hover:border-border-strong hover:text-fg">
            Not a customer yet? Request access
          </Link>
        </div>
      </section>
    </Shell>
  )
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-')
