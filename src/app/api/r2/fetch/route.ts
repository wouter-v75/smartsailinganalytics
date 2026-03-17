// src/app/api/r2/fetch/route.ts
import { NextRequest, NextResponse } from "next/server";
import { S3Client, GetObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID!;
const ACCESS_KEY = process.env.R2_ACCESS_KEY_ID!;
const SECRET_KEY = process.env.R2_SECRET_ACCESS_KEY!;
const BUCKET     = process.env.R2_BUCKET_NAME!;

function getClient() {
  return new S3Client({
    region: "auto",
    endpoint: `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
  });
}

// GET /api/r2/fetch?key=sessions/2024-09-04/log.json
export async function GET(req: NextRequest) {
  if (!ACCOUNT_ID || !ACCESS_KEY || !BUCKET) {
    return NextResponse.json({ error: "R2 not configured" }, { status: 503 });
  }

  const key = req.nextUrl.searchParams.get("key");
  if (!key) return NextResponse.json({ error: "key required" }, { status: 400 });

  const safeKey = key.replace(/\.\./g, "").replace(/^\/+/, "");

  try {
    const client = getClient();
    const cmd    = new GetObjectCommand({ Bucket: BUCKET, Key: safeKey });
    const obj    = await client.send(cmd);
    const text   = await obj.Body?.transformToString("utf-8");
    if (!text) return NextResponse.json({ error: "empty object" }, { status: 404 });
    return NextResponse.json(JSON.parse(text));
  } catch (e: any) {
    if (e.name === "NoSuchKey") return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
