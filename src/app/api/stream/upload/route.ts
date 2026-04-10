import { NextRequest, NextResponse } from "next/server";

const STREAM_KEY = process.env.BUNNY_STREAM_API_KEY!;
const LIBRARY_ID = process.env.BUNNY_STREAM_LIBRARY_ID!;

// App Router — no bodyParser config needed, body is streamed via req.body.
// Each PATCH carries one chunk (≤ 4 MB), well within Vercel Hobby's 4.5 MB limit.

function bunnyHeaders(streamId: string, extra: Record<string, string> = {}) {
  return {
    AuthorizationSignature: STREAM_KEY,
    AuthorizationExpire:    "0",
    VideoId:                streamId,
    LibraryId:              String(LIBRARY_ID),
    "Tus-Resumable":        "1.0.0",
    ...extra,
  };
}

// ── POST /api/stream/upload ───────────────────────────────────────────────────
// Initialises a TUS upload session with Bunny for a given streamId + total size.
// Body: { streamId: string, fileSize: number }
// Returns: { ok: true } on success.
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
      return NextResponse.json({ error: `Bunny TUS init failed: ${res.status} ${body}` }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

// ── PATCH /api/stream/upload?streamId=xxx&offset=0 ───────────────────────────
// Uploads one chunk. The client slices the file and calls this once per chunk.
// Query params:
//   streamId — Bunny Stream video GUID
//   offset   — byte offset of this chunk within the full file
// Body: raw bytes of the chunk (≤ 4 MB recommended for Vercel Hobby plan)
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
      // Stream the chunk body through without buffering
      body: req.body,
      // @ts-ignore — required for Node.js fetch to allow streaming body
      duplex: "half",
    });

    // Return Bunny's status code. 204 = chunk accepted.
    return new NextResponse(null, { status: res.status });
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
