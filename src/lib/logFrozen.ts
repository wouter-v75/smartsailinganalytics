// src/lib/logFrozen.ts
// ─────────────────────────────────────────────────────────────────────────────
// Spans where a log channel STOPPED UPDATING but kept being logged.
//
// Baraka, 11 Oct 2026, 08:22:20 → 08:26:24: `twa` held at exactly −53.6 for four
// minutes, with `tws`, `awa`, `bsp` and `vmg` equally frozen, and then jumped
// 100° in a single step at 08:26:30. She tacked in the middle of that. Heel —
// a different sensor — tracked it correctly the whole way (11.8 → −8.2 → −10.2
// → −13.5), which is the only reason anything noticed.
//
// A frozen channel is worse than a missing one, because everything downstream
// treats it as a reading:
//
//   · a photograph in the span gets those values as its instrument data, and
//     SailTrim takes the TACK from the sign of that stale twa — which put a
//     starboard-tack frame on port, flipped the sign of every millimetre on it
//     (leewardSign), and then, because the triangulation drops the minority
//     tack, cut that set from four frames spanning 8.7° to three spanning 4.2°;
//   · manoeuvre detection runs on twa sign changes, so the tack is reported
//     where the feed RESUMED rather than where the boat turned;
//   · a phase mean over the span averages one value repeated.
//
// It is not detectable from one row, and a steady boat genuinely does hold a
// value for a few seconds, so the test is a channel bit-identical for longer
// than any helmsman holds it WHILE another channel proves the boat was moving.
// Heel is the witness: it comes off the IMU rather than the masthead, so the two
// fail independently.
// ─────────────────────────────────────────────────────────────────────────────

export interface LogRowLike {
  utc: number
  [k: string]: number | null | undefined
}

export interface FrozenSpan {
  channel: string
  /** First and last row holding the value, ms. */
  fromUtc: number
  toUtc: number
  /**
   * When the feed CAME BACK: the first row carrying a different value, or
   * `toUtc` when the log ends frozen.
   *
   * This, not `toUtc`, is when the staleness ends — and the difference is not
   * academic. Baraka's twa froze through 08:26:24 and resumed at 08:26:30; the
   * photograph that got mislabelled was taken at 08:26:25, in the six seconds
   * between. Its nearest row is the frozen one, so its instruments are stale,
   * and a span ending at the last repeated row says otherwise.
   */
  staleUntilUtc: number
  seconds: number
  value: number
  rows: number
  /**
   * How far the WITNESS channel moved across the span. A large number means the
   * boat was demonstrably not holding still, so the frozen channel is a dead
   * feed rather than a steady one.
   */
  witnessRange: number | null
}

/** The channels that come off the masthead/speedo and freeze together. */
export const WIND_CHANNELS = ['twa', 'tws', 'awa', 'aws', 'bsp', 'vmg', 'twd'] as const

/**
 * Spans where `channel` is bit-identical for at least `minSeconds`.
 *
 * `witness` is a channel expected to keep moving (heel, off the IMU). Its range
 * across the span is reported so a caller can tell a dead feed from a boat
 * sitting still — both look identical in the frozen channel alone.
 */
export function frozenSpans(
  rows: LogRowLike[],
  channel: string,
  { minSeconds = 30, witness = 'heel' }: { minSeconds?: number; witness?: string } = {},
): FrozenSpan[] {
  const out: FrozenSpan[] = []
  const live = rows
    .filter((r) => Number.isFinite(r.utc) && Number.isFinite(r[channel] as number))
    .sort((a, b) => a.utc - b.utc)
  let i = 0
  while (i < live.length) {
    const v = live[i][channel] as number
    let j = i
    // Bit-identical, deliberately: a real sensor's last digit moves. Anything
    // that holds a float EXACTLY is repeating a stored value, not measuring.
    while (j + 1 < live.length && (live[j + 1][channel] as number) === v) j++
    const seconds = (live[j].utc - live[i].utc) / 1000
    if (j > i && seconds >= minSeconds) {
      const resumed = j + 1 < live.length ? live[j + 1].utc : live[j].utc
      const w = live.slice(i, j + 1).map((r) => r[witness]).filter((x): x is number => Number.isFinite(x as number))
      out.push({
        channel,
        fromUtc: live[i].utc,
        toUtc: live[j].utc,
        staleUntilUtc: resumed,
        seconds,
        value: v,
        rows: j - i + 1,
        witnessRange: w.length > 1 ? Math.max(...w) - Math.min(...w) : null,
      })
    }
    i = j + 1
  }
  return out
}

/** Every wind/speed channel's frozen spans, worst first. */
export function frozenReport(
  rows: LogRowLike[],
  opts: { minSeconds?: number; witness?: string; channels?: readonly string[] } = {},
): FrozenSpan[] {
  const channels = opts.channels ?? WIND_CHANNELS
  return channels
    .flatMap((c) => frozenSpans(rows, c, opts))
    .sort((a, b) => b.seconds - a.seconds)
}

/**
 * Is this instant inside a frozen span — i.e. are its instruments stale?
 *
 * Runs to `staleUntilUtc`, the moment the feed came back, because the nearest
 * row to an instant in the gap is the frozen one. See that field's note.
 */
export function frozenAt(spans: FrozenSpan[], utcMs: number): FrozenSpan[] {
  return spans.filter((s) => utcMs >= s.fromUtc && utcMs < s.staleUntilUtc)
}
