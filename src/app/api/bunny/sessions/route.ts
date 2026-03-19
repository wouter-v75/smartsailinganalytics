// src/app/api/bunny/sessions/route.ts
// Lists all sessions stored in Bunny Storage by reading each meta.json.
// Returns array of session objects sorted newest first.
import { NextResponse } from "next/server";

const API_KEY = process.env.BUNNY_STORAGE_API_KEY!;
const ZONE    = process.env.BUNNY_STORAGE_ZONE!;
const REGION  = process.env.BUNNY_STORAGE_REGION || "de";

function base() {
  return REGION === "de"
    ? "https://storage.bunnycdn.com"
    : `https://${REGION}.storage.bunnycdn.com`;
}

// GET /api/bunny/sessions
export async function GET() {
  if (!API_KEY || !ZONE) return NextResponse.json([]);

  try {
    // List the sessions/ directory to get date folders
    const listRes = await fetch(`${base()}/${ZONE}/sessions/`, {
      headers: { AccessKey: API_KEY },
    });

    if (!listRes.ok) return NextResponse.json([]);

    const items: any[] = await listRes.json();

    // Filter to directories only (folders have IsDirectory: true)
    const dateFolders = items
      .filter((i) => i.IsDirectory)
      .map((i) => i.ObjectName.replace(/\/$/, ""))
      .filter((name) => /^\d{4}-\d{2}-\d{2}$/.test(name))
      .sort((a, b) => b.localeCompare(a))
      .slice(0, 60);

    // Fetch each meta.json in parallel
    const metas = await Promise.all(
      dateFolders.map(async (date) => {
        try {
          const r = await fetch(`${base()}/${ZONE}/sessions/${date}/meta.json`, {
            headers: { AccessKey: API_KEY },
          });
          if (!r.ok) return null;
          const m = await r.json();
          return { date, ...m, source: "cloud" };
        } catch {
          return null;
        }
      })
    );

    return NextResponse.json(metas.filter(Boolean));
  } catch {
    return NextResponse.json([]);
  }
}
