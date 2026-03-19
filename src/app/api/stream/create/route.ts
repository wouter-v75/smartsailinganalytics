// src/app/api/stream/create/route.ts
// Creates a Bunny Stream video entry and returns a TUS upload URL.
// The client uploads directly to Bunny — video never passes through this server.
import { NextRequest, NextResponse } from "next/server";

const STREAM_KEY = process.env.BUNNY_STREAM_API_KEY!;
const LIBRARY_ID = process.env.BUNNY_STREAM_LIBRARY_ID!;

// POST /api/stream/create  { fileName, fileSizeBytes }
export async function POST(req: NextRequest) {
  if (!STREAM_KEY || !LIBRARY_ID) {
    return NextResponse.json({ error: "Bunny Stream not configured" }, { status: 503 });
  }

  const { fileName, fileSizeBytes } = await req.json();
  if (!fileName || !fileSizeBytes) {
    return NextResponse.json({ error: "fileName and fileSizeBytes required" }, { status: 400 });
  }

  try {
    // Step 1: Create the video object in Bunny Stream
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

    if (!createRes.ok) {
      const text = await createRes.text();
      return NextResponse.json(
        { error: `Bunny Stream create failed: ${createRes.status} ${text}` },
        { status: 500 }
      );
    }

    const video = await createRes.json();
    const streamId = video.guid as string;

    // Step 2: Get a TUS upload URL for this video
    // Bunny Stream TUS endpoint: https://video.bunnycdn.com/tusupload
    const tusRes = await fetch(
      `https://video.bunnycdn.com/tusupload`,
      {
        method: "POST",
        headers: {
          AccessKey: STREAM_KEY,
          "Upload-Length": String(fileSizeBytes),
          "Upload-Metadata": [
            `filetype ${Buffer.from("video/mp4").toString("base64")}`,
            `title ${Buffer.from(fileName).toString("base64")}`,
            `videoid ${Buffer.from(streamId).toString("base64")}`,
            `libraryId ${Buffer.from(LIBRARY_ID).toString("base64")}`,
          ].join(","),
          "Tus-Resumable": "1.0.0",
          "Content-Length": "0",
        },
      }
    );

    if (!tusRes.ok) {
      const text = await tusRes.text();
      return NextResponse.json(
        { error: `Bunny TUS create failed: ${tusRes.status} ${text}` },
        { status: 500 }
      );
    }

    // Bunny returns the TUS upload URL in the Location header
    const uploadUrl = tusRes.headers.get("location");
    if (!uploadUrl) {
      return NextResponse.json(
        { error: "Bunny did not return a TUS upload URL" },
        { status: 500 }
      );
    }

    return NextResponse.json({ streamId, uploadUrl });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
