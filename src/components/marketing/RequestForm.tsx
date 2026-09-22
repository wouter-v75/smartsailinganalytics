'use client'

// The one interactive thing on the public site.
//
// Intent first, following Veo: asking what someone is after before asking who
// they are qualifies the lead before a human reads it, and it routes the reply.
// Only name, email and intent are required — every extra required field is a
// reason to close the tab.
import { useState } from 'react'

const INTENTS = [
  { v: 'programme', l: 'We run a grand-prix campaign', d: 'Instrumented boat, full logs, lidar or rig loads' },
  { v: 'squad', l: 'We are an Olympic or class squad', d: 'Several boats, trackers, a coach across them' },
  { v: 'coach', l: 'I coach one or a few boats', d: 'Just me and the boats I work with' },
  { v: 'partner', l: 'Partnership or something else', d: 'Hardware, class association, event, federation' },
] as const

const input =
  'w-full rounded-lg border border-border bg-surface-0 px-3 py-2.5 text-[14px] text-fg placeholder:text-faint focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent'
const label = 'mb-1.5 block text-[13px] font-semibold text-secondary'

export default function RequestForm() {
  const [intent, setIntent] = useState<string>('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setErr(null)
    const fd = new FormData(e.currentTarget)
    const body = Object.fromEntries(fd.entries())
    setBusy(true)
    try {
      const res = await fetch('/api/access-request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, intent, source_path: '/request-access' }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) { setErr(j?.error || 'Something went wrong. Please email wouterv@runbox.com.'); return }
      setDone(true)
    } catch {
      setErr('Could not reach the server. Please email wouterv@runbox.com.')
    } finally { setBusy(false) }
  }

  if (done) {
    return (
      <div className="rounded-xl border border-accent bg-surface-1 p-6">
        <h2 className="text-[18px] font-bold">Got it — thank you.</h2>
        <p className="mt-3 text-[15px] leading-relaxed text-secondary">
          We read every one of these ourselves; there is no queue and no sales team. Expect a
          reply within a couple of days out of season, and a little longer between April and
          September.
        </p>
        <p className="mt-3 text-[15px] leading-relaxed text-secondary">
          If you can send a day&rsquo;s log and a few clips in the meantime, the first
          conversation can be about <i>your</i> sailing rather than a demo account.
        </p>
      </div>
    )
  }

  return (
    <form onSubmit={onSubmit} className="space-y-7">
      {/* ── Intent first ─────────────────────────────────────────────────── */}
      <fieldset>
        <legend className={label}>What are you after? <span className="text-accent">*</span></legend>
        <div className="grid gap-2.5 sm:grid-cols-2">
          {INTENTS.map((i) => (
            <label
              key={i.v}
              className={`cursor-pointer rounded-lg border p-4 transition-colors ${
                intent === i.v ? 'border-accent bg-accent-bg' : 'border-border bg-surface-1 hover:border-border-strong'
              }`}
            >
              <input
                type="radio" name="intentChoice" value={i.v} className="sr-only"
                checked={intent === i.v} onChange={() => setIntent(i.v)}
              />
              <div className="text-[14px] font-semibold">{i.l}</div>
              <div className="mt-1 text-[12px] leading-snug text-muted">{i.d}</div>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="grid gap-5 sm:grid-cols-2">
        <div>
          <label className={label} htmlFor="name">Your name <span className="text-accent">*</span></label>
          <input id="name" name="name" required className={input} autoComplete="name" />
        </div>
        <div>
          <label className={label} htmlFor="email">Email <span className="text-accent">*</span></label>
          <input id="email" name="email" type="email" required className={input} autoComplete="email" />
        </div>
        <div>
          <label className={label} htmlFor="organisation">Team, programme or club</label>
          <input id="organisation" name="organisation" className={input} />
        </div>
        <div>
          <label className={label} htmlFor="boat_class">Boat or class</label>
          <input id="boat_class" name="boat_class" className={input} placeholder="Northstar 76, ILCA 7, 49er…" />
        </div>
        <div>
          <label className={label} htmlFor="country">Country</label>
          <input id="country" name="country" className={input} />
        </div>
        <div>
          <label className={label} htmlFor="referrer">Who sent you?</label>
          <input id="referrer" name="referrer" className={input} placeholder="A coach, a teammate, a regatta…" />
        </div>
      </div>

      <div>
        <label className={label} htmlFor="message">What are you trying to solve?</label>
        <textarea
          id="message" name="message" rows={5} className={input}
          placeholder="What the boat records, how many days a year you sail, and what currently happens to the day&rsquo;s video and data."
        />
        <p className="mt-2 text-[12px] text-muted">
          The more concrete this is, the more useful the first reply will be.
        </p>
      </div>

      {/* Honeypot: off-screen, unlabelled, never focusable by a person. */}
      <div aria-hidden="true" className="absolute left-[-9999px] top-0 h-0 w-0 overflow-hidden">
        <label htmlFor="website">Website</label>
        <input id="website" name="website" tabIndex={-1} autoComplete="off" />
      </div>

      {err && (
        <div className="rounded-lg border border-danger bg-danger-bg px-4 py-3 text-[14px] text-danger">{err}</div>
      )}

      <div className="flex flex-wrap items-center gap-4">
        <button
          type="submit" disabled={busy || !intent}
          className="rounded-lg bg-accent px-5 py-2.5 text-[14px] font-semibold text-accent-fg transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? 'Sending…' : 'Send request'}
        </button>
        <span className="text-[13px] text-muted">
          {intent ? 'No newsletter, no follow-up sequence.' : 'Pick one above to continue.'}
        </span>
      </div>
    </form>
  )
}
