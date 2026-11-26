import { NextRequest, NextResponse } from "next/server";
import { requireActiveUser } from '@/lib/supabase/admin-guard'

const STREAM_KEY = process.env.BUNNY_STREAM_API_KEY!;
const LIBRARY_ID = process.env.BUNNY_STREAM_LIBRARY_ID!;

// POST /api/stream/create
// Body: { fileName: string, fileSizeBytes: number }
// Returns: { streamId: string, uploadUrl: string }
export async function POST(req: NextRequest) {
  const gate = await requireActiveUser()
  if (!gate.ok) return gate.response

  if (!STREAM_KEY || !LIBRARY_ID)
    return NextResponse.json({ error: "Bunny Stream not configured" }, { status: 503 });

  // fileSizeBytes is accepted for call-site compatibility but not forwarded:
  // Bunny sizes the video from the upload itself.
  const { fileName } = await req.json();
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
        // ONLY the title. This used to send `enabledResolutions` here with a
        // comment saying it set the full ladder, and it never did: Bunny's
        // CreateVideoModel documents exactly title / collectionId /
        // thumbnailTime and is declared `additionalProperties: false`, so the
        // field was dropped on the floor. Every ladder this app has ever got
        // from this path came from the LIBRARY default instead.
        //
        // Where the ladder is actually chosen: the `EnabledResolutions` HEADER
        // on the TUS upload (src/lib/bunny.js — Bunny reads the encoding
        // headers from the request that completes the upload), or the
        // `enabledResolutions` QUERY parameter on a direct PUT. Neither is a
        // create-time option, and `videos/fetch` has no equivalent at all,
        // which is why the proxy path takes the library default.
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

    // NOTE: never return STREAM_KEY to the browser. The TUS upload is
    // authorised separately via the short-lived signature from /stream/upload.
    return NextResponse.json({ streamId, uploadUrl, libraryId: LIBRARY_ID });
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
