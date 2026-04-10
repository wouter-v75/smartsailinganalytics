import { NextRequest, NextResponse } from "next/server";

const STREAM_KEY = process.env.BUNNY_STREAM_API_KEY!;
const LIBRARY_ID = process.env.BUNNY_STREAM_LIBRARY_ID!;
const CDN_HOST   = process.env.BUNNY_CDN_HOSTNAME || "";

// GET /api/stream/status/[id]
export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  if (!STREAM_KEY || !LIBRARY_ID)
    return NextResponse.json({ error: "Bunny Stream not configured" }, { status: 503 });

  const { id } = params;
  try {
    const res = await fetch(
      `https://video.bunnycdn.com/library/${LIBRARY_ID}/videos/${id}`,
      { headers: { AccessKey: STREAM_KEY } }
    );
    if (!res.ok)
      return NextResponse.json({ error: `HTTP ${res.status}` }, { status: 500 });

    const v = await res.json();

    // status 4 = finished encoding
    const ready = v.status === 4;
    const playbackUrl = ready && CDN_HOST
      ? `https://${CDN_HOST}/${id}/playlist.m3u8`
      : null;
    const thumbnailUrl = CDN_HOST
      ? `https://${CDN_HOST}/${id}/thumbnail.jpg`
      : null;

    return NextResponse.json({
      ready,
      status: v.status,
      playbackUrl,
      thumbnailUrl,
      streamId: id,
    });
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
