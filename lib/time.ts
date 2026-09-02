export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;

/** Horizontal scale of the guide. One hour of programming is 240px wide. */
export const PX_PER_MINUTE = 4;

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

/** Grace period after a scheduled slot ends before it is written off as missed. */
export const MISSED_GRACE_MS = 30 * MINUTE_MS;

export function overlaps(
  a: { startsAt: Date; endsAt: Date },
  windowStart: Date,
  windowEnd: Date,
): boolean {
  return a.startsAt.getTime() < windowEnd.getTime() && a.endsAt.getTime() > windowStart.getTime();
}

/** Horizontal offset in px for `time` within a viewport beginning at `viewportStart`. */
export function xForTime(time: Date, viewportStart: Date): number {
  return ((time.getTime() - viewportStart.getTime()) / MINUTE_MS) * PX_PER_MINUTE;
}

export function widthForSpan(startsAt: Date, endsAt: Date): number {
  return Math.max(0, ((endsAt.getTime() - startsAt.getTime()) / MINUTE_MS) * PX_PER_MINUTE);
}

export function floorToHalfHour(d: Date): Date {
  const out = new Date(d);
  out.setSeconds(0, 0);
  out.setMinutes(out.getMinutes() < 30 ? 0 : 30);
  return out;
}

/**
 * The guide opens looking slightly into the past so a stream that started a
 * while ago is still visible, and a few hours ahead for scheduled programming.
 */
export function defaultViewport(now: Date): { from: Date; to: Date } {
  const from = floorToHalfHour(new Date(now.getTime() - HOUR_MS));
  return { from, to: new Date(from.getTime() + 4 * HOUR_MS) };
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
