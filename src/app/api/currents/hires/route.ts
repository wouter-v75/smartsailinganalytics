import { NextRequest, NextResponse } from "next/server";

// GET /api/currents/hires?lat=49.66&lon=-1.62
// Returns ONLY a ~20x20 km clip of the native 1.5 km AMM15 current field around
// (lat,lon). The full hires file is fetched server-side (fast, cached ~15 min) so
// the browser/mobile downloads just the small clip — not the whole 0.8 MB field.

const PULL_BASE = process.env.NEXT_PUBLIC_ICONRACE_BASE; // public pull-zone fronting Caddy www/icon-race
const API_KEY = process.env.BUNNY_STORAGE_API_KEY;
const ZONE = process.env.BUNNY_STORAGE_ZONE;
const REGION = process.env.BUNNY_STORAGE_REGION || "de";
const KEY = "icon-race/currents/channel/field_hires.json";
const HALF_KM = 10; // 20x20 km box

function storageBase() {
  return REGION === "de"
    ? "https://storage.bunnycdn.com"
    : `https://${REGION}.storage.bunnycdn.com`;
}

// The box publishes via Caddy -> pull zone (same place the overview is read from),
// so prefer the public base; fall back to the storage zone only if no base is set.
async function fetchFullHires() {
  if (PULL_BASE) return fetch(`${PULL_BASE}/currents/channel/field_hires.json`, { next: { revalidate: 900 } });
  if (API_KEY && ZONE) return fetch(`${storageBase()}/${ZONE}/${KEY}`, { headers: { AccessKey: API_KEY }, next: { revalidate: 900 } });
  return null;
}

type Frame = { u: number[]; v: number[] };
type Header = { nx: number; ny: number; lo1: number; la1: number; dx: number; dy: number };

export async function GET(req: NextRequest) {
  const lat = parseFloat(req.nextUrl.searchParams.get("lat") || "");
  const lon = parseFloat(req.nextUrl.searchParams.get("lon") || "");
  if (Number.isNaN(lat) || Number.isNaN(lon))
    return NextResponse.json({ error: "lat & lon required" }, { status: 400 });

  try {
    const res = await fetchFullHires();
    if (!res)
      return NextResponse.json({ error: "currents source not configured" }, { status: 503 });
    if (res.status === 404)
      return NextResponse.json({ error: "no hires field" }, { status: 404 });
    if (!res.ok)
      return NextResponse.json({ error: `Bunny HTTP ${res.status}` }, { status: 500 });

    const field = JSON.parse(await res.text());
    const h: Header = field.header;
    const dLat = HALF_KM / 111;
    const dLon = HALF_KM / (111 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)));
    const west = lon - dLon, east = lon + dLon, north = lat + dLat, south = lat - dLat;
    const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

    let i0 = clamp(Math.floor((west - h.lo1) / h.dx), 0, h.nx - 1);
    let i1 = clamp(Math.ceil((east - h.lo1) / h.dx), 0, h.nx - 1);
    let j0 = clamp(Math.floor((h.la1 - north) / h.dy), 0, h.ny - 1); // larger lat -> smaller row
    let j1 = clamp(Math.ceil((h.la1 - south) / h.dy), 0, h.ny - 1);
    if (i1 < i0) [i0, i1] = [i1, i0];
    if (j1 < j0) [j0, j1] = [j1, j0];

    const nx = i1 - i0 + 1, ny = j1 - j0 + 1;
    if (nx < 2 || ny < 2)
      return NextResponse.json({ error: "point outside current coverage" }, { status: 404 });

    const sub = (arr: number[]) => {
      const out = new Array(nx * ny);
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) out[j * nx + i] = arr[(j0 + j) * h.nx + (i0 + i)];
      return out;
    };
    const frames = (field.frames as Frame[]).map((f) => ({ u: sub(f.u), v: sub(f.v) }));

    return NextResponse.json({
      model: field.model, units: field.units, res_km: field.res_km, updated: field.updated, tier: "hires20",
      header: { nx, ny, lo1: h.lo1 + i0 * h.dx, la1: h.la1 - j0 * h.dy, dx: h.dx, dy: h.dy },
      times: field.times, frames,
    });
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
