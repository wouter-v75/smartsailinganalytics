// Data protection and AI handling.
//
// Not boilerplate, and not a legal page pretending to be one. A sailing team's
// data is video and audio of identifiable people — crew, and often minors in a
// squad — plus a programme's genuinely confidential rig numbers. Two questions
// decide the sale with a federation or a funded programme, and neither is
// answered by a privacy policy written for a shop:
//
//   1. where does it live, and who can see it?
//   2. what happens to our voices and video when you point AI at them?
//
// Everything below is checkable against the code: the Scaleway constraint is in
// docs/SSA_AI_STACK_HANDOVER.md ("all inference stays inside the Scaleway (EU)
// account, nothing to a third-party vendor — confirmed as binding"), the roles
// are docs/auth/permissions.md, and the squad defaults are
// docs/squad-sharing-design-2026-09.md. Where something is not settled yet, it
// says so rather than implying a policy that does not exist.
import type { Metadata } from 'next'
import { pageMeta } from '../../lib/siteMeta'
import Link from 'next/link'
import { Shell, Hero, Section } from '../../components/marketing/Shell'

export const metadata: Metadata = pageMeta({
  title: 'Data and AI',
  description:
    'Where your data lives, who can see it, and exactly what happens when AI touches your crew’s video and voices. All inference runs inside an EU account; no model vendor receives your data.',
  path: '/privacy',
})

const SUBPROCESSORS = [
  ['Supabase', 'Database, authentication, file storage', 'Ireland (eu-west-1)'],
  ['Bunny.net', 'Video transcoding and delivery', 'EU edge storage'],
  ['Scaleway', 'All AI inference — transcription and summarisation', 'France'],
  ['Vercel', 'Application hosting', 'EU region'],
  ['Open-Meteo', 'Weather forecasts (venue coordinates only — no personal data)', 'EU'],
]

const WHO_SEES = [
  ['Admin', 'Everything, across all teams. That is one person: the founder.'],
  ['Team manager', 'Everything for their own programme, including rig and tuning.'],
  ['Coach', 'Everything for the boats they coach.'],
  ['Sailor', 'Their boat’s days, media, analysis and debriefs.'],
  ['Consultant', 'The same as a coach, but only inside a date window you set. Access ends by itself.'],
  ['Guest', 'The most recent day only.'],
  ['Share link', 'Exactly one clip. No account needed, revocable at any time.'],
]

export default function PrivacyPage() {
  return (
    <Shell>
      <Hero eyebrow="Data and AI" title="Where your data lives, and what AI is allowed to do with it">
        SSA holds video and audio of identifiable people, and a programme&rsquo;s confidential
        numbers. Two questions decide whether that is acceptable, and both are answered in
        full on this page rather than in a policy nobody reads.
      </Hero>

      {/* ── 1. Where it lives ─────────────────────────────────────────────── */}
      <Section
        id="where"
        title="Everything stays in the EU"
        lead="Not &ldquo;EU-friendly&rdquo; or &ldquo;EU-available&rdquo;. Every subprocessor below is an EU region, and there is no US fallback."
      >
        <div className="overflow-hidden rounded-xl border border-border">
          <table className="w-full text-left text-[13px]">
            <thead className="bg-surface-2 text-[11px] font-bold uppercase tracking-wider text-muted">
              <tr>
                <th className="px-4 py-2.5">Who</th>
                <th className="px-4 py-2.5">What for</th>
                <th className="px-4 py-2.5">Where</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border bg-surface-1">
              {SUBPROCESSORS.map(([name, use, where]) => (
                <tr key={name}>
                  <td className="px-4 py-3 font-semibold text-fg">{name}</td>
                  <td className="px-4 py-3 text-secondary">{use}</td>
                  <td className="px-4 py-3 text-muted">{where}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-5 max-w-2xl text-[14px] leading-relaxed text-muted">
          Video and photographs of identifiable crew are personal data under the GDPR, and so is
          a debrief recording of someone&rsquo;s voice. A data-processing agreement is part of the
          contract rather than something to ask for afterwards, and this list is the
          subprocessor schedule to it. If it changes, you are told before it changes.
        </p>
      </Section>

      {/* ── 2. The AI question. The one that actually decides the sale. ───── */}
      <Section
        id="ai"
        title="What AI does, and what it is not allowed to do"
        lead="Debrief recordings are transcribed and summarised by a model. That is the single most sensitive thing SSA does, so here is the whole of it."
      >
        <div className="rounded-xl border border-accent bg-surface-1 p-5">
          <h3 className="text-[15px] font-bold">
            No third-party AI vendor ever receives your data.
          </h3>
          <p className="mt-2 text-[14px] leading-relaxed text-secondary">
            All inference runs inside SSA&rsquo;s own account at Scaleway, a French provider, on
            European hardware. Your crew&rsquo;s voices and your team&rsquo;s words are never sent
            to OpenAI, Google, Anthropic, Meta or any other model vendor. This is an
            architectural constraint, not a setting — there is no code path that would send a
            recording anywhere else.
          </p>
        </div>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div className="rounded-xl border border-border bg-surface-1 p-5">
            <div className="text-[13px] font-bold uppercase tracking-wider text-muted">What runs</div>
            <ul className="mt-3 space-y-2 text-[14px] leading-relaxed text-secondary">
              <li><b className="text-fg">Whisper large-v3</b> — turns a recording into text.</li>
              <li><b className="text-fg">Mistral Small 3.2 (24B)</b> — tidies the text into your own vocabulary and drafts a summary.</li>
              <li>Both hosted by Scaleway. Open-weight models, not a vendor&rsquo;s private API.</li>
            </ul>
          </div>
          <div className="rounded-xl border border-border bg-surface-1 p-5">
            <div className="text-[13px] font-bold uppercase tracking-wider text-muted">What it is given</div>
            <ul className="mt-3 space-y-2 text-[14px] leading-relaxed text-secondary">
              <li>The recording you chose to process, and nothing else.</li>
              <li>Your team&rsquo;s glossary — sail names, crew names, class jargon — so it
                transcribes <i>A2</i> and <i>gybe</i> rather than guessing.</li>
              <li>No other team&rsquo;s data is ever in the same request. There is no shared context
                between teams.</li>
            </ul>
          </div>
        </div>

        <div className="mt-4 rounded-xl border border-border bg-surface-1 p-5">
          <div className="text-[13px] font-bold uppercase tracking-wider text-muted">The rules it runs under</div>
          <ul className="mt-3 space-y-2.5 text-[14px] leading-relaxed text-secondary">
            <li className="border-l-2 border-border pl-4">
              <b className="text-fg">Nothing is trained on.</b> Your recordings and text are not
              used to train or fine-tune any model, by us or by Scaleway. Improving SSA&rsquo;s
              analysis uses <i>sailing data</i> — tracks, wind, manoeuvres — and only with the
              separate permission described below.
            </li>
            <li className="border-l-2 border-border pl-4">
              <b className="text-fg">AI only runs when a person asks it to.</b> Nothing is
              transcribed in the background. A coach presses record, or picks a file, every time.
            </li>
            <li className="border-l-2 border-border pl-4">
              <b className="text-fg">A person approves the output before it is saved.</b> The
              draft is shown for review and editing first. It is a good assistant and a bad
              witness, and the product treats it that way.
            </li>
            <li className="border-l-2 border-border pl-4">
              <b className="text-fg">It cannot reach across teams.</b> The model is given one
              team&rsquo;s material in one request. It has no index of everyone&rsquo;s seasons to
              draw on and cannot leak one team&rsquo;s day into another&rsquo;s summary.
            </li>
            <li className="border-l-2 border-border pl-4">
              <b className="text-fg">Everyone in the room has to agree first.</b> The team
              debrief recorder does not run until every sailor and coach on the team has ticked
              the consent box in their own profile. It is asked at signup, it defaults to no,
              and anyone can withdraw it at any time — which stops the recorder for the whole
              team until they agree again. Owners, consultants and guests are not counted,
              because they are not in the debrief.
            </li>
            <li className="border-l-2 border-border pl-4">
              <b className="text-fg">You can switch it off.</b> A team that does not want AI
              transcription simply does not use it; every note can be typed. Nothing else in SSA
              depends on it.
            </li>
          </ul>
        </div>
      </Section>

      {/* ── 3. Who can see what ───────────────────────────────────────────── */}
      <Section
        id="access"
        title="Who can see what"
        lead="Access is per team and per boat, enforced in the database rather than in the interface."
      >
        <div className="overflow-hidden rounded-xl border border-border">
          <table className="w-full text-left text-[13px]">
            <tbody className="divide-y divide-border bg-surface-1">
              {WHO_SEES.map(([role, what]) => (
                <tr key={role}>
                  <td className="w-40 px-4 py-3 font-semibold text-fg">{role}</td>
                  <td className="px-4 py-3 text-secondary">{what}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div className="rounded-xl border border-border bg-surface-1 p-5 text-[14px] leading-relaxed text-secondary">
            <b className="text-fg">Squad sharing is opt-in, per category.</b> When boats from
            different owners share days, you choose what goes: tracks and analysis, photos,
            video. <b className="text-fg">Rig settings and tuning are off by default</b> and stay
            off until you turn them on.
          </div>
          <div className="rounded-xl border border-border bg-surface-1 p-5 text-[14px] leading-relaxed text-secondary">
            <b className="text-fg">Debriefs are never shareable.</b> Not to a squad, not to a
            partner boat, not by link. What a team says about its own performance stays inside
            that team, and there is no setting that changes it.
          </div>
        </div>
      </Section>

      {/* ── 4. Your data, your call ───────────────────────────────────────── */}
      <Section id="rights" title="It is your data">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="rounded-xl border border-border bg-surface-1 p-5 text-[14px] leading-relaxed text-secondary">
            <b className="text-fg">Export whenever you want</b>, including on the way out. We will
            not hold a season hostage to a renewal.
          </div>
          <div className="rounded-xl border border-border bg-surface-1 p-5 text-[14px] leading-relaxed text-secondary">
            <b className="text-fg">Deletion is real.</b> Ask and it is removed from the database
            and from video storage, not flagged as hidden.
          </div>
          <div className="rounded-xl border border-border bg-surface-1 p-5 text-[14px] leading-relaxed text-secondary">
            <b className="text-fg">Consent is recorded and revocable.</b> Agreeing to be
            recorded is a tick box in your own profile, dated when you set it, and untickable
            at any time without asking anyone.
          </div>
          <div className="rounded-xl border border-border bg-surface-1 p-5 text-[14px] leading-relaxed text-secondary">
            <b className="text-fg">A crew member can ask for their own data.</b> Access, correction
            and erasure requests go to the team manager or straight to us, and we answer within a
            month as the GDPR requires.
          </div>
          <div className="rounded-xl border border-border bg-surface-1 p-5 text-[14px] leading-relaxed text-secondary">
            <b className="text-fg">Improving the analysis needs your separate permission.</b>
            It is its own clause in the contract, it covers de-identified sailing data only —
            never video, audio or debrief text — and you can decline it and keep everything else.
          </div>
        </div>
      </Section>

      {/* ── 5. Honest about what is not finished ──────────────────────────── */}
      <Section
        id="open"
        title="What is not settled yet"
        lead="A privacy page that claims everything is finished is the one you should not believe."
      >
        <ul className="max-w-2xl space-y-3 text-[14px] leading-relaxed text-secondary">
          <li className="border-l-2 border-border pl-4">
            <b className="text-fg">There is no automatic retention schedule.</b> Data stays until
            you ask for it to go. Some programmes want a fixed deletion horizon; if you need one,
            it is a contract term today rather than a switch in the app.
          </li>
          <li className="border-l-2 border-border pl-4">
            <b className="text-fg">No formal certification.</b> SSA is not ISO 27001 or SOC 2
            certified, and saying otherwise would be a lie. What exists is EU-only hosting, a
            DPA, database-level access control and the AI constraints above.
          </li>
        </ul>
      </Section>

      <section className="ssa-reveal py-14">
        <h2 className="ssa-rule text-[20px] font-bold tracking-tight sm:text-[24px]">Questions your legal team needs answered?</h2>
        <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-secondary">
          Send them straight over. A federation&rsquo;s data-protection officer asking hard questions
          is a good sign, not an obstacle, and the answers above are the ones we would give them.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <a href="mailto:wouterv@runbox.com" className="rounded-lg bg-accent px-5 py-2.5 text-[14px] font-semibold text-accent-fg hover:opacity-90">
            Email us
          </a>
          <Link href="/support" className="rounded-lg border border-border px-5 py-2.5 text-[14px] text-secondary hover:border-border-strong hover:text-fg">
            Support and manual
          </Link>
        </div>
      </section>
    </Shell>
  )
}
