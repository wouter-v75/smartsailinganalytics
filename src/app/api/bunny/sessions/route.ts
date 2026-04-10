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
// Lists all session dates available in Bunny Storage by reading the sessions/ folder.
export async function GET() {
  if (!API_KEY || !ZONE)
    return NextResponse.json([], { status: 200 }); // not configured → empty list

  try {
    const res = await fetch(`${base()}/${ZONE}/sessions/`, {
      headers: { AccessKey: API_KEY },
    });
    if (!res.ok) return NextResponse.json([]);

    // Bunny returns JSON array of file/folder objects
    const items: { ObjectName: string; IsDirectory: boolean }[] = await res.json();
    const dates = items
      .filter(i => i.IsDirectory && /^\d{4}-\d{2}-\d{2}$/.test(i.ObjectName))
      .map(i => ({ date: i.ObjectName, source: "cloud" }))
      .sort((a, b) => b.date.localeCompare(a.date));

    return NextResponse.json(dates);
  } catch (e: unknown) {
    return NextResponse.json([]);
  }
}
