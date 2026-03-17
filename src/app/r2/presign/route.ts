// src/app/api/r2/presign/route.ts
import { NextRequest, NextResponse } from "next/server";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID!;
const ACCESS_KEY = process.env.R2_ACCESS_KEY_ID!;       // R2-specific key (not API token)
const SECRET_KEY = process.env.R2_SECRET_ACCESS_KEY!;   // R2-specific secret
const BUCKET     = process.env.R2_BUCKET_NAME!;

function getS3Client() {
  return new S3Client({
    region: "auto",
    endpoint: `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
  });
}

// POST /api/r2/presign  { key, contentType, operation: "put"|"get" }
export async function POST(req: NextRequest) {
  if (!ACCOUNT_ID || !ACCESS_KEY || !SECRET_KEY || !BUCKET) {
    return NextResponse.json({ error: "R2 not configured" }, { status: 503 });
  }

  const { key, contentType = "application/json", operation = "put" } = await req.json();
  if (!key) return NextResponse.json({ error: "key required" }, { status: 400 });

  // Sanitise key — prevent path traversal
  const safeKey = key.replace(/\.\./g, "").replace(/^\/+/, "");

  try {
    const client  = getS3Client();
    const command = operation === "get"
      ? new GetObjectCommand({ Bucket: BUCKET, Key: safeKey })
      : new PutObjectCommand({ Bucket: BUCKET, Key: safeKey, ContentType: contentType });

    const url = await getSignedUrl(client, command, { expiresIn: 3600 });
    return NextResponse.json({ url, key: safeKey });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
