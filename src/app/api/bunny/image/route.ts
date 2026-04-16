import { NextRequest, NextResponse } from "next/server";

// Binary image proxy for Bunny Storage.
// Used for reading photo thumbnails and (optionally) full-resolution originals.
// The JSON proxy at /api/bunny/storage can't serve binary data, so we have this
// dedicated endpoint.
//
// GET /api/bunny/image?key=sessions/2026-04-16/photos/p_xxx_thumb.jpg
//
// Returns raw image bytes with correct Content-Type.

const API_KEY = process.env.BUNNY_STORAGE_API_KEY!;
const ZONE    = process.env.BUNNY_STORAGE_ZONE!;
const REGION  = process.env.BUNNY_STORAGE_REGION || "de";

function base() {
  return REGION === "de"
    ? "https://storage.bunnycdn.com"
    : `https://${REGION}.storage.bunnycdn.com`;
}

function safeKey(k: string) {
  return k.replace(/\.\./g, "").replace(/^\/+/, "");
}

function contentTypeFor(key: string) {
  const lower = key.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  return "application/octet-stream";
}

export async function GET(req: NextRequest) {
  if (!API_KEY || !ZONE)
    return NextResponse.json({ error: "Bunny Storage not configured" }, { status: 503 });

  const key = req.nextUrl.searchParams.get("key");
  if (!key)
    return NextResponse.json({ error: "key required" }, { status: 400 });

  try {
    const res = await fetch(`${base()}/${ZONE}/${safeKey(key)}`, {
      headers: { AccessKey: API_KEY },
    });
    if (res.status === 404)
      return NextResponse.json({ error: "not found" }, { status: 404 });
    if (!res.ok)
      return NextResponse.json({ error: `Bunny HTTP ${res.status}` }, { status: 500 });

    const buf = await res.arrayBuffer();
    const headers = new Headers();
    headers.set("Content-Type", res.headers.get("Content-Type") || contentTypeFor(key));
    headers.set("Cache-Control", "public, max-age=3600");
    const contentLength = res.headers.get("Content-Length");
    if (contentLength) headers.set("Content-Length", contentLength);
    return new NextResponse(buf, { status: 200, headers });
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
