import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";

const STREAM_KEY = process.env.BUNNY_STREAM_API_KEY!;
const LIBRARY_ID = process.env.BUNNY_STREAM_LIBRARY_ID!;

// POST /api/stream/upload
// Returns signed credentials for the browser to upload directly via tus-js-client.
// Signature = SHA256(libraryId + apiKey + expiry + videoId)
export async function POST(req: NextRequest) {
  if (!STREAM_KEY || !LIBRARY_ID)
    return NextResponse.json({ error: "Bunny Stream not configured" }, { status: 503 });

  const { streamId, fileSize } = await req.json();
  if (!streamId || !fileSize)
    return NextResponse.json({ error: "streamId and fileSize required" }, { status: 400 });

  const expiry = Math.floor(Date.now() / 1000) + 86400; // 24 hours
  const signature = crypto
    .createHash("sha256")
    .update(`${LIBRARY_ID}${STREAM_KEY}${expiry}${streamId}`)
    .digest("hex");

  return NextResponse.json({
    signature,
    expiry:    String(expiry),
    libraryId: String(LIBRARY_ID),
    streamId,
  });
}
