// src/app/api/stream/delete/route.ts
// DELETE a video from Bunny Stream by its GUID
import { NextRequest, NextResponse } from "next/server";

const STREAM_KEY = process.env.BUNNY_STREAM_API_KEY!;
const LIBRARY_ID = process.env.BUNNY_STREAM_LIBRARY_ID!;

// DELETE /api/stream/delete   body: { streamId }
export async function DELETE(req: NextRequest) {
  if (!STREAM_KEY || !LIBRARY_ID) {
    return NextResponse.json({ error: "Bunny Stream not configured" }, { status: 503 });
  }
  const { streamId } = await req.json();
  if (!streamId) return NextResponse.json({ error: "streamId required" }, { status: 400 });

  try {
    const res = await fetch(
      `https://video.bunnycdn.com/library/${LIBRARY_ID}/videos/${streamId}`,
      { method: "DELETE", headers: { AccessKey: STREAM_KEY } }
    );
    if (!res.ok && res.status !== 404) {
      return NextResponse.json({ error: `Bunny Stream delete failed: ${res.status}` }, { status: 500 });
    }
    return NextResponse.json({ ok: true, streamId });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
