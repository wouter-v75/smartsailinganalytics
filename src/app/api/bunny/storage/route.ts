// src/app/api/bunny/storage/route.ts
// GET  ?key=sessions/2024-09-04/log.json  — fetch JSON from Bunny Storage
// PUT  body: { key, data }                — upload JSON to Bunny Storage
import { NextRequest, NextResponse } from "next/server";

const API_KEY = process.env.BUNNY_STORAGE_API_KEY!;
const ZONE    = process.env.BUNNY_STORAGE_ZONE!;
const REGION  = process.env.BUNNY_STORAGE_REGION || "de";

function base() {
  return REGION === "de"
    ? `https://storage.bunnycdn.com`
    : `https://${REGION}.storage.bunnycdn.com`;
}

function safeKey(k: string) {
  return k.replace(/\.\./g, "").replace(/^\/+/, "");
}

// GET /api/bunny/storage?key=sessions/2024-09-04/log.json
export async function GET(req: NextRequest) {
  if (!API_KEY || !ZONE) return NextResponse.json({ error: "Bunny not configured" }, { status: 503 });

  const key = req.nextUrl.searchParams.get("key");
  if (!key) return NextResponse.json({ error: "key required" }, { status: 400 });

  try {
    const res = await fetch(`${base()}/${ZONE}/${safeKey(key)}`, {
      headers: { AccessKey: API_KEY },
    });
    if (res.status === 404) return NextResponse.json({ error: "not found" }, { status: 404 });
    if (!res.ok)            return NextResponse.json({ error: `HTTP ${res.status}` }, { status: 500 });
    const text = await res.text();
    return NextResponse.json(JSON.parse(text));
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// PUT /api/bunny/storage   body: { key: string, data: any }
export async function PUT(req: NextRequest) {
  if (!API_KEY || !ZONE) return NextResponse.json({ error: "Bunny not configured" }, { status: 503 });

  const { key, data } = await req.json();
  if (!key) return NextResponse.json({ error: "key required" }, { status: 400 });

  try {
    const res = await fetch(`${base()}/${ZONE}/${safeKey(key)}`, {
      method: "PUT",
      headers: {
        AccessKey: API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(data),
    });
    if (!res.ok) return NextResponse.json({ error: `HTTP ${res.status}` }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
