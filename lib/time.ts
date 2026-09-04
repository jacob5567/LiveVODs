export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;


/**
 * How far a stream may start from its scheduled slot and still be treated as
 * that scheduled program rather than an unrelated ad-hoc broadcast. Streamers
 * routinely start late, so this is generous.
 */
export const SLOT_TOLERANCE_MS = 30 * MINUTE_MS;

/**
 * Length assumed for a scheduled program whose end time the platform doesn't
 * give us. Twitch schedule segments carry an end_time; YouTube premieres and
 * upcoming live streams only carry scheduledStartTime.
 */
export const DEFAULT_SLOT_MS = 2 * HOUR_MS;

/** A stream that just went live still gets a bar wide enough to click. */
export const MIN_LIVE_BAR_MS = 15 * MINUTE_MS;

/**
 * How far past the present a still-running broadcast's bar reaches.
 *
 * Ending it exactly on the current instant leaves a boundary the library can
 * claim, because a programme occupies [start, end) — so the row would hand out
 * a repeat while the stream is still on. A broadcast confirmed live will be
 * confirmed again within a poll, so reaching one poll ahead is honest.
 */
export const LIVE_LEAD_MS = MINUTE_MS;

/** Grace period after a scheduled slot ends before it is written off as missed. */
export const MISSED_GRACE_MS = 30 * MINUTE_MS;

export function overlaps(
  a: { startsAt: Date; endsAt: Date },
  windowStart: Date,
  windowEnd: Date,
): boolean {
  return a.startsAt.getTime() < windowEnd.getTime() && a.endsAt.getTime() > windowStart.getTime();
}

/**
 * YouTube's quota resets at midnight America/Los_Angeles, so budget rows are
 * keyed by the Pacific date rather than UTC.
 */
export function pacificDay(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}
