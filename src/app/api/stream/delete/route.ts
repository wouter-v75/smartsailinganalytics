import { NextRequest, NextResponse } from "next/server";
import { requireActiveUser } from '@/lib/supabase/admin-guard'

const STREAM_KEY = process.env.BUNNY_STREAM_API_KEY!;
const LIBRARY_ID = process.env.BUNNY_STREAM_LIBRARY_ID!;

// DELETE /api/stream/delete   body: { streamId: string }
export async function DELETE(req: NextRequest) {
  const gate = await requireActiveUser()
  if (!gate.ok) return gate.response

  if (!STREAM_KEY || !LIBRARY_ID)
    return NextResponse.json({ error: "Bunny Stream not configured" }, { status: 503 });

  const { streamId } = await req.json();
  if (!streamId)
    return NextResponse.json({ error: "streamId required" }, { status: 400 });

  try {
    const res = await fetch(
      `https://video.bunnycdn.com/library/${LIBRARY_ID}/videos/${streamId}`,
      {
        method: "DELETE",
        headers: { AccessKey: STREAM_KEY },
      }
    );
    if (!res.ok)
      return NextResponse.json({ error: `HTTP ${res.status}` }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
