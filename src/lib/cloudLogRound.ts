// How much precision a log row keeps on its way to the cloud.
//
// The cloud copy is shrunk hard — a day has to fit inside one request — and one of the
// savings was rounding every number to 2 dp. Instrument data is meaningless past 2 dp,
// so that is right for boat speed, wind and heel. It is catastrophic for POSITION:
// 0.01° of latitude is about 1.1 km, so a whole day of sailing snaps onto a kilometre
// grid and the track redraws itself as a staircase of right angles. That is not a
// drawing bug to be smoothed over — the positions themselves are gone.
//
// Five decimals is about a metre, which is finer than the GPS, and costs a few bytes a
// row against a track that is actually the track.

/** Decimals kept per column; anything not named keeps the default. */
export const CLOUD_DP: Record<string, number> = {
  lat: 5, lon: 5,
}

export const DEFAULT_CLOUD_DP = 2

export function roundForCloud(key: string, value: unknown): unknown {
  if (typeof value !== 'number' || !Number.isFinite(value)) return value
  // Integers are already short, and rounding them can only lose a digit.
  if (Number.isInteger(value)) return value
  const f = 10 ** (CLOUD_DP[key] ?? DEFAULT_CLOUD_DP)
  return Math.round(value * f) / f
}

/** One row, slimmed to `keep` and rounded per column. */
export function slimRowForCloud(
  row: Record<string, unknown>, keep: readonly string[]
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of keep) {
    const v = row[k]
    if (v != null) out[k] = roundForCloud(k, v)
  }
  return out
}
