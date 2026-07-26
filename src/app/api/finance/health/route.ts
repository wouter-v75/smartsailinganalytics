// Health check for the finance module wiring. Proves: (1) the SSA session is
// validated through the finance identity contract, and (2) the finance DB is
// reachable. Returns 503 (not a crash) when finance isn't configured yet, so this
// route is safe to ship BEFORE the finance project exists.
//
//   GET /api/finance/health
//     200 { ok:true, userId, financeConfigured:true }
//     401 not signed in
//     503 finance DB not configured yet
//     502 finance DB configured but unreachable
import { NextResponse } from 'next/server'
import { getFinanceCaller } from '@/finance/identity'
import { financeConfigured, getFinanceDb } from '@/finance/db'

export const dynamic = 'force-dynamic'

export async function GET() {
  const caller = await getFinanceCaller()
  if (!caller) return NextResponse.json({ ok: false, reason: 'unauthenticated' }, { status: 401 })

  if (!financeConfigured()) {
    return NextResponse.json(
      { ok: false, reason: 'finance-db-not-configured', userId: caller.userId },
      { status: 503 },
    )
  }

  try {
    const db = getFinanceDb()
    const { error } = await db
      .from('finance_members')
      .select('ssa_user_id', { count: 'exact', head: true })
    if (error) throw error
    return NextResponse.json({ ok: true, userId: caller.userId, financeConfigured: true })
  } catch (e) {
    return NextResponse.json(
      { ok: false, reason: 'finance-db-unreachable', detail: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    )
  }
}
