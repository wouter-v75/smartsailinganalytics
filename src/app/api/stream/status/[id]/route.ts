// src/app/api/stream/status/[id]/route.ts
// Returns playback status for a Bunny Stream video.
// Returns { ready, playbackUrl, thumbnailUrl, duration, status }
import { NextRequest, NextResponse } from "next/server";

const STREAM_KEY = process.env.BUNNY_STREAM_API_KEY!;
const LIBRARY_ID = process.env.BUNNY_STREAM_LIBRARY_ID!;
const CDN_HOST   = process.env.BUNNY_CDN_HOSTNAME || "";

// GET /api/stream/status/{videoGuid}
export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  if (!STREAM_KEY || !LIBRARY_ID) {
    return NextResponse.json({ error: "Bunny Stream not configured" }, { status: 503 });
  }

  const { id } = params;
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  try {
    const res = await fetch(
      `https://video.bunnycdn.com/library/${LIBRARY_ID}/videos/${id}`,
      { headers: { AccessKey: STREAM_KEY } }
    );

    if (!res.ok) {
      return NextResponse.json({ ready: false, status: "error" });
    }

    const v = await res.json();

    // Bunny Stream status: 0=queued, 1=processing, 2=encoding, 3=finished, 4=error, 5=uploading
    const ready = v.status === 4; // 4 = finished/ready (Bunny uses 4 for "ready")
    // Note: Bunny encodeProgress goes 0–100; status 4 means fully processed

    // HLS playback URL pattern for Bunny Stream
    const pullZone = CDN_HOST || `${v.videoLibraryId}.b-cdn.net`;
    const playbackUrl  = ready ? `https://${pullZone}/${id}/playlist.m3u8` : null;
    const thumbnailUrl = ready ? `https://${pullZone}/${id}/thumbnail.jpg` : null;

    const statusLabel = (
      { 0: "queued", 1: "processing", 2: "encoding", 3: "uploading", 4: "ready", 5: "error" } as Record<number, string>
    )[v.status as number] ?? "processing";

    return NextResponse.json({
      ready,
      playbackUrl,
      thumbnailUrl,
      duration:    v.length      || null,
      status:      statusLabel,
      streamId:    id,
      encodeProgress: v.encodeProgress ?? null,
      size:        v.storageSize  || null,
    });
  } catch (e: any) {
    return NextResponse.json({ ready: false, status: "error", error: e.message });
  }
}
