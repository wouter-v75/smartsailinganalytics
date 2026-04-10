import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";

const STREAM_KEY = process.env.BUNNY_STREAM_API_KEY!;
const LIBRARY_ID = process.env.BUNNY_STREAM_LIBRARY_ID!;

// GET /api/stream/auth?streamId=xxx
// Returns signed credentials the browser needs to upload directly to Bunny.
// The signature is computed server-side so the API key never leaves the server.
// Signature = SHA256(libraryId + apiKey + expiry + videoId)
export async function GET(req: NextRequest) {
  if (!STREAM_KEY || !LIBRARY_ID)
    return NextResponse.json({ error: "Bunny Stream not configured" }, { status: 503 });

  const streamId = req.nextUrl.searchParams.get("streamId");
  if (!streamId)
    return NextResponse.json({ error: "streamId required" }, { status: 400 });

  const expiry = Math.floor(Date.now() / 1000) + 7200; // 2 hours
  const signature = crypto
    .createHash("sha256")
    .update(LIBRARY_ID + STREAM_KEY + expiry + streamId)
    .digest("hex");

  return NextResponse.json({
    signature,
    expiry:    String(expiry),
    libraryId: String(LIBRARY_ID),
    streamId,
  });
}
