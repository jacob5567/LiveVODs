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
  /** Where in the source recording this begins; non-zero only for a later part. */
  offsetMs: number;
  /** 1-based. Both are 1 for anything short enough to air whole. */
  part: number;
  partCount: number;
}

/** A library item as it will actually be broadcast: whole, or one part of it. */
interface Playable {
  programId: number;
  durationMs: number;
  offsetMs: number;
  part: number;
  partCount: number;
}

/**
 * Splits anything too long to air in one sitting into equal consecutive parts.
 * Equal rather than a run of full parts and a stub, so a 14 hour marathon
 * becomes seven two-hour blocks instead of six plus twenty minutes.
 */
function toParts(item: LibraryItem): Playable[] {
  if (item.durationMs <= MAX_SLOT_MS) {
    return [
      { programId: item.programId, durationMs: item.durationMs, offsetMs: 0, part: 1, partCount: 1 },
    ];
  }

  const partCount = Math.ceil(item.durationMs / PART_TARGET_MS);
  const each = Math.floor(item.durationMs / partCount);

  return Array.from({ length: partCount }, (_, i) => ({
    programId: item.programId,
    // The last part carries the remainder, so the parts sum to the whole.
    durationMs: i === partCount - 1 ? item.durationMs - each * (partCount - 1) : each,
    offsetMs: each * i,
    part: i + 1,
    partCount,
  }));
}

/**
 * Carried from one day to the next, which is what removes the seam at midnight.
 *
 * Without it every day restarted at 00:00 with a freshly shuffled order, so the
 * last programme of a day had to end exactly on the boundary — and it never
 * could, leaving dead air, while the reshuffle let a programme close one day
 * and open the next.
 */
export interface Chain {
  /** Where programming has reached. Past midnight when a programme runs over. */
  cursorMs: number;
  /** Position in the endless running order. */
  index: number;
}

/** Gaps shorter than this are left empty rather than filled with a sliver. */
export const MIN_SLOT_MS = 5 * 60_000;

/**
 * Days programmed before the window, so the boundaries inside it are already
 * chained. The window spans at most two midnights, so two days is enough.
 */
export const CHAIN_LOOKBACK_DAYS = 2;

/** Beyond this a library item is broadcast in parts rather than as one block. */
export const MAX_SLOT_MS = 6 * 60 * 60_000;

/**
 * Target length of a part. A speedrunning marathon VOD runs 14 hours or more;
 * as one bar it would own most of a day, and rejecting it lost the content
 * entirely. Split, it behaves the way a marathon actually aired — consecutive
 * blocks, each resuming where the last left off.
 */
export const PART_TARGET_MS = 2 * 60 * 60_000;

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

/**
 * The endless running order: the library shuffled, then reshuffled each time it
 * is exhausted, so a row does not replay in the same sequence forever. Seeded
 * from the subject and the cycle number, never from the date — the order has to
 * continue across midnight rather than restart there.
 */
function itemAt(
  subjectId: number,
  groups: Playable[][],
  length: number,
  index: number,
  cache: Map<number, Playable[]>,
): Playable {
  const cycle = Math.floor(index / length);
  let order = cache.get(cycle);
  if (!order) {
    // Shuffled by recording, then flattened — so the parts of one marathon stay
    // together and in order rather than being dealt out across the evening.
    order = shuffled(groups, seededRandom(hashSeed(`${subjectId}:cycle:${cycle}`))).flat();
    cache.set(cycle, order);
  }
  return order[index % length];
}

/** Local-midnight boundaries of the day containing `ms`. */
export function dayBounds(ms: number): { start: number; end: number } {
  const start = new Date(ms);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start: start.getTime(), end: end.getTime() };
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
 * Programmes one day of one row, continuing from where the previous day left
 * off and handing on where this one reaches.
 *
 * The final programme of a day is allowed to run through midnight — that is the
 * whole point. Ending every day exactly on the boundary is impossible unless
 * the library happens to contain something the exact length of the remainder,
 * so the boundary was costing every row a stretch of dead air.
 */
export function programmeDay(
  subjectId: number,
  dayStartMs: number,
  appointments: Appointment[],
  library: LibraryItem[],
  chain: Chain = { cursorMs: 0, index: 0 },
  cache: Map<number, Playable[]> = new Map(),
): { placements: Placement[]; chain: Chain } {
  const { start, end } = dayBounds(dayStartMs);

  const fixed = resolveOverlaps(
    appointments.filter((a) => a.endsAt > start && a.startsAt < end),
  );

  const placements: Placement[] = fixed.map((a) => ({
    programId: a.programId,
    startsAt: a.startsAt,
    endsAt: a.endsAt,
    isAppointment: true,
    offsetMs: 0,
    part: 1,
    partCount: 1,
  }));

  // Nothing is rejected for being long any more; it is broadcast in parts.
  const groups = library
    .filter((item) => item.durationMs >= MIN_SLOT_MS)
    .map(toParts)
    .filter((parts) => parts.every((p) => p.durationMs >= MIN_SLOT_MS));
  const playlistLength = groups.reduce((n, g) => n + g.length, 0);

  // Programming resumes wherever the previous day reached, which may be inside
  // this one if a programme ran over.
  let cursor = Math.max(start, chain.cursorMs);
  let index = chain.index;

  if (playlistLength === 0) {
    return {
      placements: placements.sort((a, b) => a.startsAt - b.startsAt),
      chain: { cursorMs: cursor, index },
    };
  }

  const gaps: Array<[number, number]> = [];
  for (const appointment of fixed) {
    if (appointment.startsAt > cursor) gaps.push([cursor, appointment.startsAt]);
    cursor = Math.max(cursor, appointment.endsAt);
  }
  if (cursor < end) gaps.push([cursor, end]);

  /**
   * How far the last programme of the day may run past midnight: up to the
   * next appointment, since overrunning into a live broadcast would put two
   * things on the row at once.
   */
  const nextAppointment = appointments
    .filter((a) => a.startsAt >= end)
    .reduce((soonest, a) => Math.min(soonest, a.startsAt), Number.POSITIVE_INFINITY);
  const overrunLimit = Math.min(nextAppointment, end + MAX_SLOT_MS);

  for (const [gapStart, gapEnd] of gaps) {
    // Only the gap that runs to midnight may be overrun; one ending at an
    // appointment must not.
    const ceiling = gapEnd === end ? overrunLimit : gapEnd;
    let at = gapStart;
    let skipped = 0;

    while (gapEnd - at >= MIN_SLOT_MS && skipped < playlistLength) {
      const item = itemAt(subjectId, groups, playlistLength, index, cache);
      index += 1;

      if (at + item.durationMs > ceiling) {
        // Too long even allowing for the overrun. Leave it for a wider gap
        // rather than truncating it — a bar should be the real length.
        skipped += 1;
        continue;
      }

      placements.push({
        programId: item.programId,
        startsAt: at,
        endsAt: at + item.durationMs,
        isAppointment: false,
        offsetMs: item.offsetMs,
        part: item.part,
        partCount: item.partCount,
      });
      at += item.durationMs;
      skipped = 0;
    }

    cursor = Math.max(cursor, at);
  }

  return {
    placements: placements.sort((a, b) => a.startsAt - b.startsAt),
    chain: { cursorMs: cursor, index },
  };
}

/**
 * Programmes every day the window touches and clips to it.
 *
 * Days before the window are programmed too, so the boundaries inside it are
 * already chained rather than starting cold. Note this makes a day's schedule
 * depend on where the chain began: two windows starting on different days can
 * differ in their deep past. Within one window it is stable, which is what the
 * live-update refetch relies on.
 */
export function programmeWindow(
  subjectId: number,
  fromMs: number,
  toMs: number,
  appointments: Appointment[],
  library: LibraryItem[],
): Placement[] {
  const out: Placement[] = [];
  const cache = new Map<number, Playable[]>();
  // An appointment spanning midnight belongs to both days; it is placed once.
  const placedAppointments = new Set<number>();

  const firstDay = dayBounds(
    dayBounds(fromMs).start - CHAIN_LOOKBACK_DAYS * 24 * 60 * 60_000,
  ).start;

  let chain: Chain = { cursorMs: firstDay, index: 0 };

  for (let day = firstDay; day < toMs; day = dayBounds(day).end) {
    const result = programmeDay(subjectId, day, appointments, library, chain, cache);
    chain = result.chain;

    for (const placement of result.placements) {
      if (placement.isAppointment) {
        if (placedAppointments.has(placement.programId)) continue;
        placedAppointments.add(placement.programId);
      }
      if (placement.endsAt > fromMs && placement.startsAt < toMs) out.push(placement);
    }
  }

  return out.sort((a, b) => a.startsAt - b.startsAt);
}
