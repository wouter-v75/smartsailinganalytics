import { NextResponse } from "next/server";
import { requireActiveUser } from '@/lib/supabase/admin-guard'

// Read/write key — separate from the read-only key used in /api/bunny/storage
const STORAGE_WRITE_KEY = process.env.BUNNY_STORAGE_WRITE_KEY!;
const STORAGE_ZONE      = process.env.BUNNY_STORAGE_ZONE!;
const STORAGE_REGION    = process.env.BUNNY_STORAGE_REGION || "de";

// GET /api/storage/credentials
// Returns Bunny Storage write credentials for direct browser uploads.
// Uses the read/write key (BUNNY_STORAGE_WRITE_KEY), NOT the read-only key.
//
// SIGNED-IN, APPROVED USERS ONLY. This used to answer anyone: an anonymous GET
// returned a zone-wide read/write/delete key in plaintext. The guard is the fix
// that was available; it is not the fix one would want.
//
// Why the key still reaches the browser at all: photo originals, proxies and
// clip originals are multi-hundred-MB PUTs that must go browser → Bunny
// directly. Routing them through here would send every byte twice and run into
// Vercel's ~4.5 MB request cap. Bunny Storage offers no scoped or short-lived
// write token — the zone password is the only write credential it has — so
// there is nothing narrower to hand out.
//
// What that leaves: any approved user can write or delete anywhere in the zone,
// including another team's day. See the storage-key namespacing note in
// src/lib/bunny.js — the keys carry no team or boat, which is the deeper
// problem this endpoint merely exposes.
export async function GET() {
  const gate = await requireActiveUser()
  if (!gate.ok) return gate.response

  if (!STORAGE_WRITE_KEY || !STORAGE_ZONE)
    return NextResponse.json({ error: "Bunny Storage write key not configured" }, { status: 503 });

  const host = STORAGE_REGION === "de"
    ? "https://storage.bunnycdn.com"
    : `https://${STORAGE_REGION}.storage.bunnycdn.com`;

  return NextResponse.json({
    accessKey: STORAGE_WRITE_KEY,
    zone:      STORAGE_ZONE,
    host,
  }, { headers: { 'Cache-Control': 'no-store' } });
}
