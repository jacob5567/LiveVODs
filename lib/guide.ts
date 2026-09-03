import { and, asc, desc, eq, gt, inArray, lt, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import {
  channels,
  programs,
  subjectChannels,
  subjects,
  type Platform,
  type ProgramState,
} from '@/drizzle/schema';
import { HOUR_MS, LIVE_LEAD_MS } from '@/lib/time';
import { dayBounds, programmeWindow, type Appointment, type LibraryItem } from '@/lib/schedule';

/** How far back and forward the guide loads around "now". */
export const GUIDE_PAST_MS = 4 * HOUR_MS;
export const GUIDE_FUTURE_MS = 12 * HOUR_MS;

/**
 * Most recent library items considered per subject. Enough to programme a day
 * without variety suffering, and it stops a subject with years of back
 * catalogue loading all of it on every request.
 */
const LIBRARY_LIMIT = 400;

/**
 * Times cross the server/client boundary as epoch milliseconds rather than Date
 * objects — unambiguous to serialize, and the grid does arithmetic on them anyway.
 */
export interface GuideSlot {
  /** Unique per placement: the same programme may be rerun more than once. */
  key: string;
  programId: number;
  title: string;
  category: string | null;
  /** Where this sits on the grid. For library content, when it is *scheduled*. */
  startsAt: number;
  endsAt: number;
  state: ProgramState;
  endsAtProvisional: boolean;
  /** True for a real broadcast at its real time; false for library fill. */
  isAppointment: boolean;
  isUpload: boolean;
  /** When it actually aired or was published, which a rerun no longer shows. */
  originalStartsAt: number;
  canonicalUrl: string;
  platformRef: string;
  vodRef: string | null;
  channelId: number;
  channelName: string;
  /** Twitch login / YouTube handle — what the embed needs. */
  channelLogin: string;
  platform: Platform;
}

export interface GuideSubject {
  id: number;
  name: string;
  /** Channels feeding this row, for the row header. */
  channelNames: string[];
  slots: GuideSlot[];
}

export interface Guide {
  from: number;
  to: number;
  subjects: GuideSubject[];
}

/**
 * A cheap token that changes whenever any program does.
 *
 * The worker writes and the web process reads, in separate processes with no
 * channel between them, so the live-update endpoint watches this instead of
 * being notified. The row count is part of it so that deletions register too,
 * not just edits.
 */
export function guideRevision(): string {
  const row = db
    .select({
      latest: sql<number>`coalesce(max(${programs.updatedAt}), 0)`,
      count: sql<number>`count(*)`,
    })
    .from(programs)
    .get();

  return `${row?.latest ?? 0}:${row?.count ?? 0}`;
}

export function loadGuide(now: Date = new Date()): Guide {
  return loadGuideWindow(
    new Date(now.getTime() - GUIDE_PAST_MS),
    new Date(now.getTime() + GUIDE_FUTURE_MS),
    now,
  );
}

/**
 * Loads an explicit window rather than one derived from the current time. The
 * client refetches using the window it already has, so a live update swaps the
 * programmes underneath the grid without the whole time axis shifting.
 */
export function loadGuideWindow(from: Date, to: Date, now: Date = new Date()): Guide {
  const fromMs = from.getTime();
  const toMs = to.getTime();
  const nowMs = now.getTime();

  const subjectRows = db
    .select()
    .from(subjects)
    .orderBy(asc(subjects.position), asc(subjects.name))
    .all();

  const memberships = db
    .select({
      subjectId: subjectChannels.subjectId,
      channelId: channels.id,
      displayName: channels.displayName,
      login: channels.login,
      platform: channels.platform,
    })
    .from(subjectChannels)
    .innerJoin(channels, eq(channels.id, subjectChannels.channelId))
    .all();

  const byChannel = new Map(memberships.map((m) => [m.channelId, m]));
  const channelsFor = new Map<number, number[]>();
  for (const m of memberships) {
    const list = channelsFor.get(m.subjectId);
    if (list) list.push(m.channelId);
    else channelsFor.set(m.subjectId, [m.channelId]);
  }

  // Days are programmed whole, so appointments are needed for every day the
  // window touches, not merely the window itself.
  const spanStart = dayBounds(fromMs).start;
  const spanEnd = dayBounds(toMs).end;

  const out: GuideSubject[] = [];

  for (const subject of subjectRows) {
    const channelIds = channelsFor.get(subject.id) ?? [];
    const channelNames = channelIds.map((id) => byChannel.get(id)?.displayName ?? '');

    if (channelIds.length === 0) {
      out.push({ id: subject.id, name: subject.name, channelNames, slots: [] });
      continue;
    }

    const appointmentRows = db
      .select()
      .from(programs)
      .where(
        and(
          inArray(programs.channelId, channelIds),
          inArray(programs.state, ['live', 'scheduled']),
          lt(programs.startsAt, new Date(spanEnd)),
          gt(programs.endsAt, new Date(spanStart)),
        ),
      )
      .all();

    const libraryRows = db
      .select()
      .from(programs)
      .where(and(inArray(programs.channelId, channelIds), eq(programs.state, 'aired')))
      .orderBy(desc(programs.startsAt))
      .limit(LIBRARY_LIMIT)
      .all();

    const detail = new Map([...appointmentRows, ...libraryRows].map((r) => [r.id, r]));

    const appointments: Appointment[] = appointmentRows.map((r) => ({
      programId: r.id,
      startsAt: r.startsAt.getTime(),
      /**
       * A running broadcast's end is a floor, not a fact — the worker pegs it
       * to the last poll, so it trails real time by up to the poll interval.
       * Taken literally, the scheduler fills that lag with library content and
       * the row appears to have moved on while the stream is still going.
       */
      endsAt: r.endsAtProvisional
        ? Math.max(r.endsAt.getTime(), nowMs + LIVE_LEAD_MS)
        : r.endsAt.getTime(),
    }));

    const library: LibraryItem[] = libraryRows.map((r) => ({
      programId: r.id,
      durationMs: r.endsAt.getTime() - r.startsAt.getTime(),
    }));

    const placements = programmeWindow(subject.id, fromMs, toMs, appointments, library);

    const slots: GuideSlot[] = [];
    for (const [index, placement] of placements.entries()) {
      const row = detail.get(placement.programId);
      if (!row) continue;
      const channel = byChannel.get(row.channelId);

      slots.push({
        key: `${placement.programId}:${placement.startsAt}:${index}`,
        programId: row.id,
        title: row.title,
        category: row.category,
        startsAt: placement.startsAt,
        endsAt: placement.endsAt,
        state: row.state,
        endsAtProvisional: placement.isAppointment && row.endsAtProvisional,
        isAppointment: placement.isAppointment,
        isUpload: row.isUpload,
        originalStartsAt: row.startsAt.getTime(),
        canonicalUrl: row.canonicalUrl,
        platformRef: row.platformRef,
        vodRef: row.vodRef,
        channelId: row.channelId,
        channelName: channel?.displayName ?? '',
        channelLogin: channel?.login ?? '',
        platform: channel?.platform ?? 'twitch',
      });
    }

    out.push({ id: subject.id, name: subject.name, channelNames, slots });
  }

  return { from: fromMs, to: toMs, subjects: out };
}
