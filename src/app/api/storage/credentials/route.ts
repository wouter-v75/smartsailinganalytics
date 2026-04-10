import { NextResponse } from "next/server";

// Read/write key — separate from the read-only key used in /api/bunny/storage
const STORAGE_WRITE_KEY = process.env.BUNNY_STORAGE_WRITE_KEY!;
const STORAGE_ZONE      = process.env.BUNNY_STORAGE_ZONE!;
const STORAGE_REGION    = process.env.BUNNY_STORAGE_REGION || "de";

// GET /api/storage/credentials
// Returns Bunny Storage write credentials for direct browser uploads.
// Uses the read/write key (BUNNY_STORAGE_WRITE_KEY), NOT the read-only key.
export async function GET() {
  if (!STORAGE_WRITE_KEY || !STORAGE_ZONE)
    return NextResponse.json({ error: "Bunny Storage write key not configured" }, { status: 503 });

  const host = STORAGE_REGION === "de"
    ? "https://storage.bunnycdn.com"
    : `https://${STORAGE_REGION}.storage.bunnycdn.com`;

  return NextResponse.json({
    accessKey: STORAGE_WRITE_KEY,
    zone:      STORAGE_ZONE,
    host,
  });
}
