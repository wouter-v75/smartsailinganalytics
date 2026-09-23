// POST /api/access-request — the public "Request access" form.
//
// The only route in the app that an ANONYMOUS visitor may write through, so it
// does its own gatekeeping rather than leaning on a session:
//   - a honeypot field bots fill in and humans never see
//   - a coarse per-IP rate limit
//   - strict validation and length caps on every field
//   - a unique index on (lower(email), created_at::date) that turns a
//     double-click, or a second thought an hour later, into one row
//
// The table has RLS on with no policies at all, so the insert goes through the
// service role. Nothing is ever read back out here.
//
// Always answers 200 with { ok: true } for anything that is not a validation
// error — a duplicate submission is a success from the sender's point of view,
// and telling a bot which addresses are already on file is not useful to us.

import { NextRequest, NextResponse } from 'next/server'
import { getServiceSupabase } from '../../../lib/supabase/server'

export const dynamic = 'force-dynamic'

const INTENTS = new Set(['programme', 'squad', 'coach', 'partner', 'other'])

// Deliberately generous caps: a long message is a good sign, not an attack.
const CAPS: Record<string, number> = {
  name: 120, email: 200, organisation: 160, boat_class: 80,
  country: 80, message: 4000, referrer: 160, source_path: 200,
}

// Serverless resets this on a cold start, which is fine — it is a speed bump
// for a form that should see single-digit submissions a week, not a security
// control. The real controls are the honeypot and the unique index.
const hits = new Map<string, number[]>()
const WINDOW_MS = 60 * 60 * 1000
const MAX_PER_WINDOW = 5

function rateLimited(ip: string): boolean {
  const now = Date.now()
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS)
  recent.push(now)
  hits.set(ip, recent)
  if (hits.size > 5000) hits.clear() // never let the map be the leak
  return recent.length > MAX_PER_WINDOW
}

const str = (v: unknown, key: string): string | null => {
  if (typeof v !== 'string') return null
  const s = v.trim()
  if (!s) return null
  return s.slice(0, CAPS[key] ?? 200)
}

// Not a full RFC validator — those reject real addresses. Enough to catch a
// typo and a bot posting rubbish.
const looksLikeEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s)

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>
  try { body = (await req.json()) as Record<string, unknown> }
  catch { return NextResponse.json({ error: 'expected JSON' }, { status: 400 }) }

  // Honeypot. The field is rendered off-screen and unlabelled; a human never
  // fills it. Answer 200 so the bot has nothing to learn from the difference.
  if (typeof body.website === 'string' && body.website.trim()) {
    return NextResponse.json({ ok: true })
  }

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
  if (rateLimited(ip)) {
    return NextResponse.json(
      { error: 'Too many requests from here. Email us instead and we will pick it up.' },
      { status: 429 },
    )
  }

  const name = str(body.name, 'name')
  const email = str(body.email, 'email')
  const intent = typeof body.intent === 'string' ? body.intent : ''

  if (!name) return NextResponse.json({ error: 'Please tell us your name.' }, { status: 400 })
  if (!email || !looksLikeEmail(email)) {
    return NextResponse.json({ error: 'That email address does not look right.' }, { status: 400 })
  }
  if (!INTENTS.has(intent)) {
    return NextResponse.json({ error: 'Please choose what you are after.' }, { status: 400 })
  }

  const row = {
    intent,
    name,
    email: email.toLowerCase(),
    organisation: str(body.organisation, 'organisation'),
    boat_class: str(body.boat_class, 'boat_class'),
    country: str(body.country, 'country'),
    message: str(body.message, 'message'),
    referrer: str(body.referrer, 'referrer'),
    source_path: str(body.source_path, 'source_path'),
  }

  try {
    const { error } = await getServiceSupabase().from('access_requests').insert(row)
    if (error) {
      // 23505 = the (email, day) unique index. They already asked today; from
      // their side that worked, so say so.
      if (error.code === '23505') return NextResponse.json({ ok: true, duplicate: true })
      console.warn('[access-request] insert failed:', error.message)
      return NextResponse.json(
        { error: 'Could not save that. Email wouterv@runbox.com and we will pick it up.' },
        { status: 500 },
      )
    }
  } catch (e) {
    console.warn('[access-request] insert threw:', e instanceof Error ? e.message : e)
    return NextResponse.json(
      { error: 'Could not save that. Email wouterv@runbox.com and we will pick it up.' },
      { status: 500 },
    )
  }

  return NextResponse.json({ ok: true })
}
