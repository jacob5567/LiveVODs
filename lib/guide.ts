import { and, asc, gt, lt, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { channels, programs, type Platform, type ProgramState } from '@/drizzle/schema';
import { HOUR_MS } from '@/lib/time';

/** How far back and forward the guide loads around "now". */
export const GUIDE_PAST_MS = 4 * HOUR_MS;
export const GUIDE_FUTURE_MS = 12 * HOUR_MS;

/**
 * Times cross the server/client boundary as epoch milliseconds rather than Date
 * objects — unambiguous to serialize, and the grid does arithmetic on them anyway.
 */
export interface GuideProgram {
  id: number;
  /** Twitch stream id, or the YouTube video id the player embeds directly. */
  platformRef: string;
  title: string;
  category: string | null;
  startsAt: number;
  endsAt: number;
  endsAtProvisional: boolean;
  state: ProgramState;
  canonicalUrl: string;
  vodRef: string | null;
}

export interface GuideChannel {
  id: number;
  platform: Platform;
  login: string;
  displayName: string;
  avatarUrl: string | null;
  programs: GuideProgram[];
}

export interface Guide {
  from: number;
  to: number;
  channels: GuideChannel[];
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
  );
}

/**
 * Loads an explicit window rather than one derived from the current time. The
 * client refetches using the window it already has, so a live update swaps the
 * programs underneath the grid without the whole time axis shifting.
 */
export function loadGuideWindow(from: Date, to: Date): Guide {
  const channelRows = db
    .select()
    .from(channels)
    // Stable ordering, like real channel numbers. Sorting live-first would make
    // rows jump around underneath the viewer every time a stream starts or ends.
    .orderBy(asc(channels.displayName))
    .all();

  const programRows = db
    .select()
    .from(programs)
    // Anything overlapping the window, not just what starts inside it — a stream
    // that began before `from` and is still running must still appear.
    .where(and(lt(programs.startsAt, to), gt(programs.endsAt, from)))
    .orderBy(asc(programs.startsAt))
    .all();

  const byChannel = new Map<number, GuideProgram[]>();
  for (const row of programRows) {
    const list = byChannel.get(row.channelId);
    const program: GuideProgram = {
      id: row.id,
      platformRef: row.platformRef,
      title: row.title,
      category: row.category,
      startsAt: row.startsAt.getTime(),
      endsAt: row.endsAt.getTime(),
      endsAtProvisional: row.endsAtProvisional,
      state: row.state,
      canonicalUrl: row.canonicalUrl,
      vodRef: row.vodRef,
    };
    if (list) list.push(program);
    else byChannel.set(row.channelId, [program]);
  }

  return {
    from: from.getTime(),
    to: to.getTime(),
    channels: channelRows.map((c) => ({
      id: c.id,
      platform: c.platform,
      login: c.login,
      displayName: c.displayName,
      avatarUrl: c.avatarUrl,
      programs: byChannel.get(c.id) ?? [],
    })),
  };
}
