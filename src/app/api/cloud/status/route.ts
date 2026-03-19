// src/app/api/cloud/status/route.ts
import { NextResponse } from "next/server";

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const API_TOKEN  = process.env.CLOUDFLARE_API_TOKEN;
const BUCKET     = process.env.R2_BUCKET_NAME;

export async function GET() {
  const r2Configured     = !!(ACCOUNT_ID && API_TOKEN && BUCKET);
  const streamConfigured = !!(ACCOUNT_ID && API_TOKEN);

  if (!r2Configured) {
    return NextResponse.json({
      available: false,
      r2: false,
      stream: false,
      reason: "CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN or R2_BUCKET_NAME not set in environment variables",
    });
  }

  // Ping R2 to verify credentials are valid
  try {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/r2/buckets/${BUCKET}`,
      {
        headers: { Authorization: `Bearer ${API_TOKEN}` },
        signal: AbortSignal.timeout(5000),
      }
    );
    const data = await res.json();
    if (!res.ok || !data.success) {
      return NextResponse.json({
        available: false, r2: false, stream: false,
        reason: `R2 auth failed: ${data.errors?.[0]?.message || res.status}`,
      });
    }
    return NextResponse.json({
      available: true, r2: true, stream: streamConfigured,
      bucket: BUCKET, accountId: ACCOUNT_ID,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ available: false, r2: false, stream: false, reason: msg });
  }
}
