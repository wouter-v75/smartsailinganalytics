import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";

const STREAM_KEY = process.env.BUNNY_STREAM_API_KEY!;
const LIBRARY_ID = process.env.BUNNY_STREAM_LIBRARY_ID!;

// Bunny Stream TUS requires a SHA256 signature, NOT the raw API key.
// Signature = SHA256(libraryId + apiKey + expiryUnixSecs + videoId)
function makeBunnyAuth(streamId: string) {
  const expiry = Math.floor(Date.now() / 1000) + 7200; // valid for 2 hours
  const signature = crypto
    .createHash("sha256")
    .update(LIBRARY_ID + STREAM_KEY + expiry + streamId)
    .digest("hex");
  return { signature, expiry: String(expiry) };
}

function bunnyHeaders(streamId: string, extra: Record<string, string> = {}) {
  const { signature, expiry } = makeBunnyAuth(streamId);
  return {
    AuthorizationSignature: signature,
    AuthorizationExpire:    expiry,
    VideoId:                streamId,
    LibraryId:              String(LIBRARY_ID),
    "Tus-Resumable":        "1.0.0",
    ...extra,
  };
}

// POST /api/stream/upload
// Initialises a TUS upload session with Bunny.
// Body: { streamId: string, fileSize: number }
export async function POST(req: NextRequest) {
  if (!STREAM_KEY || !LIBRARY_ID)
    return NextResponse.json({ error: "Bunny Stream not configured" }, { status: 503 });

  const { streamId, fileSize } = await req.json();
  if (!streamId || !fileSize)
    return NextResponse.json({ error: "streamId and fileSize required" }, { status: 400 });

  try {
    const res = await fetch("https://video.bunnycdn.com/tusupload", {
      method: "POST",
      headers: bunnyHeaders(streamId, {
        "Upload-Length": String(fileSize),
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      console.error("Bunny TUS init failed:", res.status, body);
      return NextResponse.json(
        { error: `Bunny TUS init: HTTP ${res.status} — ${body}` },
        { status: 500 }
      );
    }
    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

// PATCH /api/stream/upload?streamId=xxx&offset=0
// Uploads one chunk (<=4 MB for Vercel Hobby plan).
export async function PATCH(req: NextRequest) {
  if (!STREAM_KEY || !LIBRARY_ID)
    return NextResponse.json({ error: "Bunny Stream not configured" }, { status: 503 });

  const streamId = req.nextUrl.searchParams.get("streamId");
  const offset   = req.nextUrl.searchParams.get("offset") ?? "0";

  if (!streamId)
    return NextResponse.json({ error: "streamId required" }, { status: 400 });

  try {
    const res = await fetch("https://video.bunnycdn.com/tusupload", {
      method: "PATCH",
      headers: bunnyHeaders(streamId, {
        "Content-Type":  "application/offset+octet-stream",
        "Upload-Offset": offset,
      }),
      body: req.body,
      // @ts-ignore — required for Node.js fetch streaming
      duplex: "half",
    });

    if (!res.ok && res.status !== 204) {
      const body = await res.text();
      console.error(`Bunny chunk failed at offset ${offset}:`, res.status, body);
    }

    return new NextResponse(null, { status: res.status });
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
