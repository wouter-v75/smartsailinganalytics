import type { Metadata } from 'next'
import { pageMeta } from '../../lib/siteMeta'
import { Shell, Hero } from '../../components/marketing/Shell'
import RequestForm from '../../components/marketing/RequestForm'

export const metadata: Metadata = pageMeta({
  title: 'Request access',
  description:
    'SSA is invite-only. Tell us what you sail and we will show you a real day from a real season.',
  path: '/request-access',
})

export default function RequestAccessPage() {
  return (
    <Shell>
      <Hero eyebrow="Request access" title="Tell us what you sail">
        SSA is invite-only, and onboarding is done with you rather than by a signup form. That
        is a deliberate limit on how many teams come aboard at once — and it means the first
        conversation is a real one rather than a trial that expires.
      </Hero>

      <section className="grid gap-10 py-12 lg:grid-cols-[1fr_260px]">
        <RequestForm />

        <aside className="space-y-5 text-[13px] leading-relaxed text-muted lg:border-l lg:border-border lg:pl-8">
          <div>
            <div className="mb-1.5 text-[12px] font-bold uppercase tracking-[0.14em] text-secondary">
              What happens next
            </div>
            <p>
              We read it ourselves — there is no sales team. If it is a fit, we set up a call and
              go through a real day. If it is not, we will say so and tell you what we would use
              instead.
            </p>
          </div>
          <div>
            <div className="mb-1.5 text-[12px] font-bold uppercase tracking-[0.14em] text-secondary">
              Bring a day
            </div>
            <p>
              Send a log export and a few clips and the first conversation can be about your
              sailing rather than a demo account.
            </p>
          </div>
          <div>
            <div className="mb-1.5 text-[12px] font-bold uppercase tracking-[0.14em] text-secondary">
              What we do with this
            </div>
            <p>
              It is stored in the EU and used to reply to you. No newsletter, no follow-up
              sequence, no third parties.
            </p>
          </div>
          <div>
            <div className="mb-1.5 text-[12px] font-bold uppercase tracking-[0.14em] text-secondary">
              Already a member?
            </div>
            <p>
              If your team already uses SSA, ask your coach or team manager for an invitation —
              this form will only slow you down.
            </p>
          </div>
        </aside>
      </section>
    </Shell>
  )
}
