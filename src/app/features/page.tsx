// Features, grouped by the shape of a sailing day rather than by the app's tabs.
// Nobody arrives wanting to read about "the Analytics tab"; they arrive with a
// day that needs turning into something the team can learn from.
import type { Metadata } from 'next'
import { pageMeta } from '../../lib/siteMeta'
import Link from 'next/link'
import { Shell, Hero, Section, Card } from '../../components/marketing/Shell'

export const metadata: Metadata = pageMeta({
  title: 'Features',
  description:
    'Video, photos, instrument data, forecast, sail shape and the debrief, joined to the minute they happened and shared with the whole programme.',
  path: '/features',
})

export default function FeaturesPage() {
  return (
    <Shell>
      <Hero eyebrow="Features" title="Built around the day, not around the data">
        A sailing day is a plan, six hours on the water and a conversation about what
        happened. SSA follows that shape. Everything below is one product — what changes
        between a maxi and an ILCA is which channels the boat records.
      </Hero>

      <Section
        title="Before you go out"
        lead="The day starts before the dock-out, and what was expected is half of what makes the debrief useful."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Card title="Forecast decks and venue model" index={0}>
            High-resolution forecast for the venue, with the team&rsquo;s own read on it written
            alongside — expected shifts, sea-breeze timing, what the models do not say.
          </Card>
          <Card title="The plan and the timings" index={1}>
            Dock-out, warning signal, first start, the drills to run and the intent for the
            day. Dictate it instead of typing it if you are already on the dock.
          </Card>
          <Card title="Rig and sail setup" index={2}>
            The rig numbers you went out with, versioned, and the sail wardrobe that was
            aboard. What you changed, when, and what it did.
          </Card>
          <Card title="Wind weight" index={3}>
            Which sails suit the day, from the forecast and the boat&rsquo;s own history rather
            than from a rule of thumb.
          </Card>
        </div>
      </Section>

      <Section
        title="On the water"
        lead="Record what the day actually was, from whatever the boat carries."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Card title="Instrument logs" badge="Instrumented" index={0}>
            Expedition and the common log exports, at full rate. Boat speed, wind, heel,
            leeway, rudder, loads, keel and mast angles — whatever the system records.
          </Card>
          <Card title="GPS trackers" badge="Tracker-only" index={1}>
            Vakaros, Sailmon, Velocitek, phone or watch. SSA derives true wind, angle and the
            phase structure from the track, so a boat with no instruments gets the same
            analysis as one with a full system.
          </Card>
          <Card title="Video from anything" index={2}>
            Phone, GoPro, drone, coach boat. Uploaded, transcoded and time-synced to the log,
            so a moment on a chart and a moment in a clip are the same moment.
          </Card>
          <Card title="Photos and sail shape" index={3}>
            Sail photos carry the instrument state at the instant of the shutter. SailScan
            reads draft, camber and twist off the stripes; lidar where the boat has it.
          </Card>
        </div>
      </Section>

      <Section
        title="After racing"
        lead="The part that decides whether the day was worth recording — and the part every other tool leaves to a folder of unwatched footage."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Card title="The debrief, recorded" index={0}>
            Press record and talk. The recording is transcribed and tidied into your own
            vocabulary — your sail names, your crew, your jargon — and shown for review
            before anything is saved. Works on a phone, on the dock.
          </Card>
          <Card title="Phase and manoeuvre analysis" index={1}>
            Every tack, gybe, start and leg found and measured: loss through the manoeuvre,
            target versus actual, mode, and how it compares with the rest of the season.
          </Card>
          <Card title="Tagging" index={2}>
            Mark the moments that mattered, in the team&rsquo;s own vocabulary, and find them
            again across the season. Tags carry through to video, photos and the track.
          </Card>
          <Card title="Shared with the whole team" index={3}>
            The point of the product. Every crew member sees the day on their phone, with the
            clips, the numbers and the debrief — not just whoever did the import.
          </Card>
        </div>
      </Section>

      <Section
        title="Across the season"
        lead="One day is an anecdote. The value is in the fourth time you have seen the same thing."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Card title="Season trends" index={0}>
            Targets, modes and manoeuvre quality tracked across a campaign, by wind band and
            by venue, so improvement is visible rather than asserted.
          </Card>
          <Card title="Squad sharing" index={1}>
            Boats from different owners can share days with each other, category by category —
            tracks and analysis by default, rig numbers never unless you say so. Contribute a
            day to pull a day.
          </Card>
          <Card title="Ask it questions" index={2}>
            Plain-language questions over your own season: what your fast days had in common,
            what changed between two regattas, where the time actually went.
          </Card>
          <Card title="Provenance on every number" index={3}>
            Measured, derived, modelled or unavailable — stated, always. A derived wind angle
            never pretends to be a measured one.
          </Card>
        </div>
      </Section>

      <section className="ssa-reveal py-14">
        <h2 className="ssa-rule text-[20px] font-bold tracking-tight sm:text-[24px]">Does it work with what we have?</h2>
        <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-secondary">
          Most likely. The honest answer depends on what your boat records, which is a
          two-minute conversation rather than a compatibility table.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Link href="/request-access" className="ssa-lift rounded-lg bg-accent px-5 py-2.5 text-[14px] font-semibold text-accent-fg hover:opacity-90">
            Ask about your boat
          </Link>
          <Link href="/support#classes" className="rounded-lg border border-border px-5 py-2.5 text-[14px] text-secondary hover:border-border-strong hover:text-fg">
            What SSA reads
          </Link>
        </div>
      </section>
    </Shell>
  )
}
