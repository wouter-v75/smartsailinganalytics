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

// PATCH /api/stream/chunk?streamId=xxx&offset=0
// Uploads one chunk (<=4 MB) to Bunny Stream via server-side proxy.
export async function PATCH(req: NextRequest) {
  if (!STREAM_KEY || !LIBRARY_ID)
    return NextResponse.json({ error: "Bunny Stream not configured" }, { status: 503 });

  const streamId = req.nextUrl.searchParams.get("streamId");
  const offset   = req.nextUrl.searchParams.get("offset") ?? "0";
  if (!streamId)
    return NextResponse.json({ error: "streamId required" }, { status: 400 });

  const { signature, expiry } = makeBunnyAuth(streamId);

  try {
    const res = await fetch("https://video.bunnycdn.com/tusupload", {
      method: "PATCH",
      headers: {
        AuthorizationSignature: signature,
        AuthorizationExpire:    expiry,
        VideoId:                streamId,
        LibraryId:              String(LIBRARY_ID),
        "Tus-Resumable":        "1.0.0",
        "Content-Type":         "application/offset+octet-stream",
        "Upload-Offset":        offset,
      },
      body: req.body,
      // @ts-ignore
      duplex: "half",
    });

    if (!res.ok && res.status !== 204) {
      const body = await res.text();
      console.error(`Bunny chunk at offset ${offset}: HTTP ${res.status}`, body);
    }

    return new NextResponse(null, { status: res.status });
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
