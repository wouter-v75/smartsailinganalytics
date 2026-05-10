// Per-user storage quota helpers.
//
// Schema (from 0001):
//   user_quota: user_id PK, bytes_used, bytes_limit (NULL = unlimited),
//               warned_80, warned_100, updated_at
//
// Workflow:
//   - Every video/photo POST calls `addToQuota(userId, bytes)` after the
//     row is inserted.
//   - When usage crosses 80% or 100% for the first time (warned_* flag
//     not yet set), the helper fires the appropriate email and flips
//     the flag so we don't spam.
//   - 100% case also CCs the global admin so they're aware.
//   - `getQuota` is read-only and used by the UI quota indicator.
//
// Service-role only (we update quota rows directly; RLS would block).

import { getServiceSupabase } from './supabase/server'
import { sendEmail } from './email'

const ADMIN_EMAIL = process.env.ADMIN_NOTIFY_EMAIL || 'wouterv@runbox.com'

export interface QuotaState {
  bytes_used: number
  bytes_limit: number | null // null = unlimited
  percent: number // 0–100, or 0 when unlimited
  blocked: boolean // true when bytes_used >= bytes_limit (and limit is set)
}

function compute(used: number, limit: number | null): QuotaState {
  if (limit == null) {
    return { bytes_used: used, bytes_limit: null, percent: 0, blocked: false }
  }
  const percent = Math.min(100, Math.round((used / limit) * 100))
  return {
    bytes_used: used,
    bytes_limit: limit,
    percent,
    blocked: used >= limit,
  }
}

export async function getQuota(userId: string): Promise<QuotaState | null> {
  const service = getServiceSupabase()
  const { data } = await service
    .from('user_quota')
    .select('bytes_used, bytes_limit')
    .eq('user_id', userId)
    .maybeSingle()
  if (!data) return null
  return compute(data.bytes_used, data.bytes_limit)
}

interface AddResult {
  state: QuotaState
  warning_fired: '80' | '100' | null
}

export async function addToQuota(
  userId: string,
  bytesAdded: number
): Promise<AddResult> {
  if (!bytesAdded || bytesAdded <= 0) {
    const state = await getQuota(userId)
    return {
      state:
        state ??
        compute(0, null),
      warning_fired: null,
    }
  }

  const service = getServiceSupabase()
  const { data: cur } = await service
    .from('user_quota')
    .select('bytes_used, bytes_limit, warned_80, warned_100')
    .eq('user_id', userId)
    .maybeSingle()

  if (!cur) {
    // Should never happen — handle_new_user trigger creates the row at
    // signup. If somehow missing, create with default limit.
    await service.from('user_quota').insert({
      user_id: userId,
      bytes_used: bytesAdded,
      bytes_limit: 5 * 1024 * 1024 * 1024,
    })
    return {
      state: compute(bytesAdded, 5 * 1024 * 1024 * 1024),
      warning_fired: null,
    }
  }

  const newUsed = cur.bytes_used + bytesAdded
  const limit = cur.bytes_limit

  let warningFired: '80' | '100' | null = null
  const update: Record<string, unknown> = {
    bytes_used: newUsed,
    updated_at: new Date().toISOString(),
  }

  if (limit != null) {
    const prevPct = (cur.bytes_used / limit) * 100
    const newPct = (newUsed / limit) * 100
    if (!cur.warned_80 && prevPct < 80 && newPct >= 80) {
      warningFired = '80'
      update.warned_80 = true
    }
    if (!cur.warned_100 && prevPct < 100 && newPct >= 100) {
      warningFired = '100'
      update.warned_100 = true
    }
  }

  await service
    .from('user_quota')
    .update(update)
    .eq('user_id', userId)

  // Fire email asynchronously (best-effort, don't block the upload path).
  if (warningFired) {
    fireWarningEmail(userId, newUsed, limit, warningFired).catch(() => {})
  }

  // Audit
  if (warningFired) {
    await service.from('events').insert({
      user_id: userId,
      action: warningFired === '80' ? 'quota_warn_80' : 'quota_block',
      details: { bytes_used: newUsed, bytes_limit: limit },
    })
  }

  return { state: compute(newUsed, limit), warning_fired: warningFired }
}

async function fireWarningEmail(
  userId: string,
  bytesUsed: number,
  bytesLimit: number | null,
  level: '80' | '100'
): Promise<void> {
  const service = getServiceSupabase()
  const { data: u } = await service
    .from('users')
    .select('email, name')
    .eq('id', userId)
    .maybeSingle()
  if (!u?.email) return

  const usedGb = (bytesUsed / (1024 * 1024 * 1024)).toFixed(2)
  const limitGb = bytesLimit
    ? (bytesLimit / (1024 * 1024 * 1024)).toFixed(0)
    : '∞'

  if (level === '80') {
    await sendEmail({
      to: u.email,
      subject: 'SSA: storage 80% full',
      html: `
        <div style="font-family:-apple-system,system-ui,sans-serif;max-width:540px;margin:0 auto;padding:24px;color:#1e293b">
          <h2>You're nearing your SSA storage limit</h2>
          <p>Hi ${escape(u.name || u.email)},</p>
          <p>You've used <strong>${usedGb} GB</strong> of your <strong>${limitGb} GB</strong> SSA storage limit (about 80%).</p>
          <p>You can keep uploading until 100%. After that, new uploads will be blocked until you free space or contact the admin to raise your limit.</p>
          <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0"/>
          <p style="font-size:12px;color:#94a3b8">Smart Sailing Analytics</p>
        </div>
      `,
    })
  } else {
    // Level 100 — notify user AND admin.
    await Promise.all([
      sendEmail({
        to: u.email,
        subject: 'SSA: storage limit reached — uploads blocked',
        html: `
          <div style="font-family:-apple-system,system-ui,sans-serif;max-width:540px;margin:0 auto;padding:24px;color:#1e293b">
            <h2>SSA storage full</h2>
            <p>Hi ${escape(u.name || u.email)},</p>
            <p>You've reached your <strong>${limitGb} GB</strong> SSA storage limit. New uploads are blocked until either:</p>
            <ul>
              <li>Existing uploads are deleted by your team coach to free space.</li>
              <li>The admin raises your limit.</li>
            </ul>
            <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0"/>
            <p style="font-size:12px;color:#94a3b8">Smart Sailing Analytics</p>
          </div>
        `,
      }),
      sendEmail({
        to: ADMIN_EMAIL,
        subject: `SSA: ${u.email} hit 100% storage`,
        html: `
          <div style="font-family:-apple-system,system-ui,sans-serif;max-width:540px;margin:0 auto;padding:24px;color:#1e293b">
            <h2>User hit 100% storage</h2>
            <p><strong>${escape(u.name || u.email)}</strong> (${escape(u.email)}) used all ${limitGb} GB of their quota.</p>
            <p>Open the <a href="https://ssa.wvsailing.co.uk/admin/users">admin users page</a> to raise their quota or review usage.</p>
          </div>
        `,
      }),
    ])
  }
}

function escape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
