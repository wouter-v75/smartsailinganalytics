// src/app/api/cloud/status/route.ts
import { NextResponse } from "next/server";

const STORAGE_KEY    = process.env.BUNNY_STORAGE_API_KEY;
const STORAGE_ZONE   = process.env.BUNNY_STORAGE_ZONE;
const STORAGE_REGION = process.env.BUNNY_STORAGE_REGION || "de";
const STREAM_KEY     = process.env.BUNNY_STREAM_API_KEY;
const STREAM_LIB     = process.env.BUNNY_STREAM_LIBRARY_ID;

export async function GET() {
  if (!STORAGE_KEY || !STORAGE_ZONE) {
    return NextResponse.json({
      available: false, storage: false, stream: false,
      reason: "BUNNY_STORAGE_API_KEY or BUNNY_STORAGE_ZONE not set",
    });
  }

  try {
    const base = STORAGE_REGION === "de"
      ? "https://storage.bunnycdn.com"
      : `https://${STORAGE_REGION}.storage.bunnycdn.com`;

    const res = await fetch(`${base}/${STORAGE_ZONE}/`, {
      headers: { AccessKey: STORAGE_KEY },
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      return NextResponse.json({
        available: false, storage: false, stream: false,
        reason: `Bunny Storage auth failed: HTTP ${res.status}`,
      });
    }

    return NextResponse.json({
      available: true,
      storage:  true,
      stream:   !!(STREAM_KEY && STREAM_LIB),
      zone:     STORAGE_ZONE,
      region:   STORAGE_REGION,
      provider: "bunny.net",
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ available: false, storage: false, stream: false, reason: msg });
  }
}
