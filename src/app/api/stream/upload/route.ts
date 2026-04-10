import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";

const STREAM_KEY = process.env.BUNNY_STREAM_API_KEY!;
const LIBRARY_ID = process.env.BUNNY_STREAM_LIBRARY_ID!;

function makeBunnyAuth(streamId: string) {
  const expiry = Math.floor(Date.now() / 1000) + 7200;
  const signature = crypto
    .createHash("sha256")
    .update(LIBRARY_ID + STREAM_KEY + expiry + streamId)
    .digest("hex");
  return { signature, expiry: String(expiry) };
}

function tusHeaders(streamId: string, extra: Record<string, string> = {}) {
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
// Initialises a TUS session with Bunny server-side so we can read the
// Location header (not accessible from the browser due to CORS).
// Body: { streamId: string, fileSize: number }
// Returns: { locationUrl, signature, expiry, libraryId }
export async function POST(req: NextRequest) {
  if (!STREAM_KEY || !LIBRARY_ID)
    return NextResponse.json({ error: "Bunny Stream not configured" }, { status: 503 });

  const { streamId, fileSize } = await req.json();
  if (!streamId || !fileSize)
    return NextResponse.json({ error: "streamId and fileSize required" }, { status: 400 });

  try {
    const res = await fetch("https://video.bunnycdn.com/tusupload", {
      method: "POST",
      headers: tusHeaders(streamId, { "Upload-Length": String(fileSize) }),
    });

    if (!res.ok) {
      const body = await res.text();
      console.error("Bunny TUS init failed:", res.status, body);
      return NextResponse.json({ error: `TUS init HTTP ${res.status}: ${body}` }, { status: 500 });
    }

    // Read the Location header — this is the URL the browser must PATCH to
    const locationUrl = res.headers.get("Location") ?? "https://video.bunnycdn.com/tusupload";

    // Return location + fresh auth so the browser can PATCH directly
    const { signature, expiry } = makeBunnyAuth(streamId);
    return NextResponse.json({ locationUrl, signature, expiry, libraryId: String(LIBRARY_ID) });
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
