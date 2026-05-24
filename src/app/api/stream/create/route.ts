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
        // Encode the full ladder so adaptive streaming has low rungs to drop
        // to on weak wifi. Bunny only produces renditions up to the source
        // resolution, so a 720p proxy yields 240–720p and a full original
        // yields 240–1080p — listing 1080p here is harmless for the proxy.
        body: JSON.stringify({ title: fileName, enabledResolutions: "240p,360p,480p,720p,1080p" }),
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

    // NOTE: never return STREAM_KEY to the browser. The TUS upload is
    // authorised separately via the short-lived signature from /stream/upload.
    return NextResponse.json({ streamId, uploadUrl, libraryId: LIBRARY_ID });
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
