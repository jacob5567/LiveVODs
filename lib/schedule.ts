/**
 * Programming a subject's row, the way a television station programmes a day.
 *
 * A row has two kinds of content. Anything live or scheduled is an
 * *appointment*: it happens at a real time and nothing may displace it.
 * Everything already published — YouTube uploads, past streams, Twitch VODs —
 * is *library*, and gets scheduled into the gaps around those appointments so
 * the row is never blank. That is the whole reason rows are subjects rather
 * than single creators: one creator rarely has enough back catalogue to fill a
 * day, several together do.
 *
 * Two properties this has to have:
 *
 *  - Deterministic. The schedule is derived at read time, not stored, and the
 *    guide refetches whenever the worker writes anything. If the fill were
 *    random the whole row would reshuffle under the viewer every few seconds.
 *    Same subject, same day, same library ⇒ same schedule.
 *
 *  - Bounded. Programming is done one day at a time, so the work never depends
 *    on how far the window reaches or how much history exists.
 *
 * Pure: no database, no clock, no network.
 */

/** A real broadcast, at its real time. Never moved. */
export interface Appointment {
  programId: number;
  startsAt: number;
  endsAt: number;
}

/** Something already published, available to fill a gap. */
export interface LibraryItem {
  programId: number;
  /** Real length. Items are never stretched or trimmed to fit. */
  durationMs: number;
}

export interface Placement {
  programId: number;
  startsAt: number;
  endsAt: number;
  /** False for library content, which is playing at a time it never aired. */
  isAppointment: boolean;
}

/** Gaps shorter than this are left empty rather than filled with a sliver. */
export const MIN_SLOT_MS = 5 * 60_000;

/** Library items longer than this are skipped; nothing should own a whole day. */
export const MAX_SLOT_MS = 6 * 60 * 60_000;

/**
 * mulberry32 — small, fast, and good enough to shuffle a playlist. Seeded from
 * the subject and the date so a given row's day is always programmed the same
 * way, however often the guide refetches.
 */
function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** Fisher-Yates against a seeded generator, so the order is reproducible. */
function shuffled<T>(items: T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Local-midnight boundaries of the day containing `ms`. */
export function dayBounds(ms: number): { start: number; end: number } {
  const start = new Date(ms);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start: start.getTime(), end: end.getTime() };
}

/** Stable key for seeding: the local date, not a UTC one. */
function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/**
 * Appointments may overlap — two channels in one subject can broadcast at once.
 * Only one can hold the row, so the earlier start wins and ties go to the
 * longer programme. The loser is dropped from the row for that period rather
 * than being drawn on top of the winner.
 */
function resolveOverlaps(appointments: Appointment[]): Appointment[] {
  const sorted = [...appointments].sort(
    (a, b) => a.startsAt - b.startsAt || b.endsAt - a.endsAt,
  );

  const kept: Appointment[] = [];
  for (const appointment of sorted) {
    const previous = kept[kept.length - 1];
    if (previous && appointment.startsAt < previous.endsAt) continue;
    kept.push(appointment);
  }
  return kept;
}

/**
 * Programmes one day of one row.
 *
 * `subjectId` and the day together seed the shuffle, so two subjects sharing a
 * channel do not play the same video at the same moment, and a given row's
 * Tuesday looks different from its Wednesday.
 */
export function programmeDay(
  subjectId: number,
  dayStartMs: number,
  appointments: Appointment[],
  library: LibraryItem[],
): Placement[] {
  const { start, end } = dayBounds(dayStartMs);

  const fixed = resolveOverlaps(
    appointments.filter((a) => a.endsAt > start && a.startsAt < end),
  );

  const placements: Placement[] = fixed.map((a) => ({
    programId: a.programId,
    startsAt: a.startsAt,
    endsAt: a.endsAt,
    isAppointment: true,
  }));

  const usable = library.filter(
    (item) => item.durationMs >= MIN_SLOT_MS && item.durationMs <= MAX_SLOT_MS,
  );

  if (usable.length === 0) return placements.sort((a, b) => a.startsAt - b.startsAt);

  const random = seededRandom(hashSeed(`${subjectId}:${dayKey(dayStartMs)}`));
  const playlist = shuffled(usable, random);

  // A single cursor walked across the whole day, so the running order carries
  // through the gaps instead of restarting after every appointment — and no
  // item repeats until the library has been exhausted.
  let next = 0;

  const gaps: Array<[number, number]> = [];
  let cursor = start;
  for (const appointment of fixed) {
    if (appointment.startsAt > cursor) gaps.push([cursor, appointment.startsAt]);
    cursor = Math.max(cursor, appointment.endsAt);
  }
  if (cursor < end) gaps.push([cursor, end]);

  for (const [gapStart, gapEnd] of gaps) {
    let at = gapStart;
    let skipped = 0;

    while (gapEnd - at >= MIN_SLOT_MS && skipped < playlist.length) {
      const item = playlist[next % playlist.length];
      next += 1;

      if (item.durationMs > gapEnd - at) {
        // Too long for what is left here. Leave it for a wider gap rather than
        // truncating it — a bar should represent the real length of the thing.
        skipped += 1;
        continue;
      }

      placements.push({
        programId: item.programId,
        startsAt: at,
        endsAt: at + item.durationMs,
        isAppointment: false,
      });
      at += item.durationMs;
      skipped = 0;
    }
  }

  return placements.sort((a, b) => a.startsAt - b.startsAt);
}

/**
 * Programmes every day a window touches, then clips to the window. Days are
 * programmed whole so that scrolling into tomorrow shows the same schedule it
 * would have shown had the window started there.
 */
export function programmeWindow(
  subjectId: number,
  fromMs: number,
  toMs: number,
  appointments: Appointment[],
  library: LibraryItem[],
): Placement[] {
  const out: Placement[] = [];

  for (let day = dayBounds(fromMs).start; day < toMs; day = dayBounds(day).end) {
    for (const placement of programmeDay(subjectId, day, appointments, library)) {
      if (placement.endsAt > fromMs && placement.startsAt < toMs) out.push(placement);
    }
  }

  return out.sort((a, b) => a.startsAt - b.startsAt);
}
