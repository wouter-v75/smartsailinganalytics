import { NextRequest, NextResponse } from "next/server";

const STREAM_KEY = process.env.BUNNY_STREAM_API_KEY!;
const LIBRARY_ID = process.env.BUNNY_STREAM_LIBRARY_ID!;

// POST /api/stream/create
// Body: { fileName: string, fileSizeBytes: number }
// Returns: { streamId: string, uploadUrl: string }
export async function POST(req: NextRequest) {
  if (!STREAM_KEY || !LIBRARY_ID)
    return NextResponse.json({ error: "Bunny Stream not configured" }, { status: 503 });

  const { fileName, fileSizeBytes } = await req.json();
  if (!fileName)
    return NextResponse.json({ error: "fileName required" }, { status: 400 });

  try {
    // 1. Create a video object in the library
    const createRes = await fetch(
      `https://video.bunnycdn.com/library/${LIBRARY_ID}/videos`,
      {
        method: "POST",
        headers: {
          AccessKey: STREAM_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ title: fileName }),
      }
    );
    if (!createRes.ok)
      return NextResponse.json({ error: `Stream create HTTP ${createRes.status}` }, { status: 500 });

    const video = await createRes.json();
    const streamId: string = video.guid;

    // 2. Build the TUS upload URL
    // Bunny Stream TUS endpoint: https://video.bunnycdn.com/tusupload
    // Required headers for the actual PATCH are set client-side; we just return the URL + streamId.
    const uploadUrl = `https://video.bunnycdn.com/tusupload`;

    return NextResponse.json({ streamId, uploadUrl, libraryId: LIBRARY_ID, apiKey: STREAM_KEY });
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
