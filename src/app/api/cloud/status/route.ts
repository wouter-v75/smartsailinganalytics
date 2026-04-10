import { NextResponse } from "next/server";

const STORAGE_KEY    = process.env.BUNNY_STORAGE_API_KEY;
const STORAGE_ZONE   = process.env.BUNNY_STORAGE_ZONE;
const STORAGE_REGION = process.env.BUNNY_STORAGE_REGION || "de";
const STREAM_KEY     = process.env.BUNNY_STREAM_API_KEY;
const LIBRARY_ID     = process.env.BUNNY_STREAM_LIBRARY_ID;

// GET /api/cloud/status
// Returns { available, storage, stream, zone, region }
export async function GET() {
  const storageConfigured = !!(STORAGE_KEY && STORAGE_ZONE);
  const streamConfigured  = !!(STREAM_KEY && LIBRARY_ID);

  if (!storageConfigured && !streamConfigured) {
    return NextResponse.json({
      available: false,
      storage: false,
      stream: false,
      zone: null,
      region: STORAGE_REGION,
    });
  }

  // Quick liveness ping for storage — list root folder (cheap, doesn't transfer data)
  let storageOk = false;
  if (storageConfigured) {
    try {
      const base = STORAGE_REGION === "de"
        ? "https://storage.bunnycdn.com"
        : `https://${STORAGE_REGION}.storage.bunnycdn.com`;
      const res = await fetch(`${base}/${STORAGE_ZONE}/`, {
        headers: { AccessKey: STORAGE_KEY! },
        signal: AbortSignal.timeout(4000),
      });
      storageOk = res.ok || res.status === 404; // 404 = empty zone, still connected
    } catch {
      storageOk = false;
    }
  }

  // Quick liveness ping for stream — get library info
  let streamOk = false;
  if (streamConfigured) {
    try {
      const res = await fetch(
        `https://video.bunnycdn.com/library/${LIBRARY_ID}`,
        {
          headers: { AccessKey: STREAM_KEY! },
          signal: AbortSignal.timeout(4000),
        }
      );
      streamOk = res.ok;
    } catch {
      streamOk = false;
    }
  }

  return NextResponse.json({
    available: storageOk || streamOk,
    storage: storageOk,
    stream: streamOk,
    zone: STORAGE_ZONE || null,
    region: STORAGE_REGION,
  });
}
