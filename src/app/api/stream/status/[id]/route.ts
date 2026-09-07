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

    const v = (await res.json()) as {
      status?: number; encodeProgress?: number; storageSize?: number; length?: number
    };

    // Bunny's own status enum. Naming it here means the UI never has to carry a
    // second copy, and a caller reading the JSON can tell a queue from a stall
    // without knowing Bunny's numbering.
    const PHASE: Record<number, string> = {
      0: 'created', 1: 'uploaded', 2: 'queued', 3: 'encoding',
      4: 'ready', 5: 'failed', 6: 'upload failed',
    };
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
      // WHY these three: on 7 Sept five clips sat at status 2 for an hour and there
      // was no way to tell a backed-up queue from a stalled job without them.
      //   phase          — the status number in words
      //   encodeProgress — 0-100; moving means it is working, stuck at 0 means queued
      //   storageSize    — bytes Bunny actually received; 0 means the upload never
      //                    landed, which looks identical to "queued" from outside
      phase: PHASE[v.status as number] ?? `unknown (${v.status})`,
      encodeProgress: typeof v.encodeProgress === 'number' ? v.encodeProgress : null,
      storageSize: typeof v.storageSize === 'number' ? v.storageSize : null,
      // Bunny sets these once it has probed the file; their absence while "queued"
      // is another sign the upload did not complete.
      length: typeof v.length === 'number' ? v.length : null,
      failed: v.status === 5 || v.status === 6,
      playbackUrl,
      thumbnailUrl,
      streamId: id,
    });
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
