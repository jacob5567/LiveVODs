/**
 * The only place reconciler output touches the database.
 *
 * Keeping this separate is what lets reconcile.ts stay pure and fully testable;
 * everything here is mechanical translation.
 */
import { and, eq, gt, inArray, like, lt, not, notInArray, or } from 'drizzle-orm';
import { db } from '@/lib/db';
import { channels, programs, subjectChannels } from '@/drizzle/schema';
import type { ProgramRecord, Write } from './reconcile';

/** How far back a finished program stays in the reconciler's working set. */
const LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How far ahead announced slots are considered.
 *
 * Wide enough to cover everything the schedule feeds can produce: Twitch
 * returns recurring segments months out, and a slot beyond this bound is one
 * the reconciler can never see. It would then be re-inserted on every pass,
 * and the upsert would rewrite it with a fresh updated_at — which moves the
 * guide revision token and makes every connected browser refetch the whole
 * guide for data that did not change.
 */
const LOOKAHEAD_MS = 180 * 24 * 60 * 60 * 1000;

/**
 * How far ahead an announced slot is worth re-checking on the live poll.
 *
 * The live pass exists to catch the moment a slot starts broadcasting, and on
 * YouTube it is metered — a unit per fifty ids, every minute. A premiere three
 * months out cannot start today, and the hourly discovery pass keeps it fresh
 * in the meantime, so watching it every minute buys nothing.
 */
const WATCH_HORIZON_MS = 2 * 24 * 60 * 60 * 1000;

/**
 * Load the programs a reconcile pass could plausibly touch.
 *
 * Bounded on purpose: the reconciler matches live streams against nearby slots
 * and VODs against recent broadcasts, so it needs a window around now — never
 * the full history, which would grow without limit.
 */
export function loadWorkingSet(channelIds: number[], now: Date): ProgramRecord[] {
  if (channelIds.length === 0) return [];

  return db
    .select()
    .from(programs)
    .where(
      and(
        inArray(programs.channelId, channelIds),
        gt(programs.endsAt, new Date(now.getTime() - LOOKBACK_MS)),
        lt(programs.startsAt, new Date(now.getTime() + LOOKAHEAD_MS)),
      ),
    )
    .all()
    .map(
      (row): ProgramRecord => ({
        id: row.id,
        channelId: row.channelId,
        platformRef: row.platformRef,
        title: row.title,
        category: row.category,
        startsAt: row.startsAt,
        endsAt: row.endsAt,
        endsAtProvisional: row.endsAtProvisional,
        state: row.state,
        canonicalUrl: row.canonicalUrl,
        thumbnailUrl: row.thumbnailUrl,
        vodRef: row.vodRef,
        isUpload: row.isUpload,
      }),
    );
}

/**
 * Platform refs currently worth re-checking, grouped by channel.
 *
 * YouTube has no affordable "is this channel live" endpoint, so it re-checks
 * known video ids instead. Anything already finished is excluded — its state
 * cannot change again.
 */
export function loadWatchRefs(
  channelIds: number[],
  now: Date = new Date(),
): Map<number, string[]> {
  const out = new Map<number, string[]>();
  if (channelIds.length === 0) return out;

  const rows = db
    .select({ channelId: programs.channelId, platformRef: programs.platformRef })
    .from(programs)
    .where(
      and(
        inArray(programs.channelId, channelIds),
        or(
          eq(programs.state, 'live'),
          and(
            eq(programs.state, 'scheduled'),
            lt(programs.startsAt, new Date(now.getTime() + WATCH_HORIZON_MS)),
          ),
        ),
      ),
    )
    .all();

  for (const row of rows) {
    const list = out.get(row.channelId);
    if (list) list.push(row.platformRef);
    else out.set(row.channelId, [row.platformRef]);
  }

  return out;
}

export interface ApplyResult {
  inserted: number;
  updated: number;
}

export function applyWrites(writes: Write[], now: Date = new Date()): ApplyResult {
  if (writes.length === 0) return { inserted: 0, updated: 0 };

  let inserted = 0;
  let updated = 0;

  // One transaction per pass: a poll either lands whole or not at all, so the
  // guide is never read mid-update.
  db.transaction((tx) => {
    for (const write of writes) {
      if (write.op === 'insert') {
        tx.insert(programs)
          .values({ ...write.row, updatedAt: now })
          // A concurrent pass may have inserted the same broadcast already.
          .onConflictDoUpdate({
            target: [programs.channelId, programs.platformRef],
            set: { ...write.row, updatedAt: now },
          })
          .run();
        inserted += 1;
      } else {
        tx.update(programs)
          .set({ ...write.patch, updatedAt: now })
          .where(eq(programs.id, write.id))
          .run();
        updated += 1;
      }
    }
  });

  return { inserted, updated };
}

/**
 * Closes broadcasts belonging to channels that are no longer polled.
 *
 * Only channels that feed a subject are polled, so dropping one from
 * config/channels.yml stops anything ever observing it again — and a broadcast
 * that was live at that moment stays live forever, because the offline edge
 * that would have ended it is never seen. Re-add the channel later and the
 * guide shows a phantom broadcast pinned to the present, holding the row and
 * blocking every repeat behind it.
 *
 * Only live rows are closed. An announced slot on a dropped channel is inert —
 * nothing polls it, nothing renders it — and leaving it scheduled is what lets
 * it come back intact if the channel returns to the lineup. Writing it off as
 * missed would be a one-way door, since applyScheduled only ever updates a row
 * that is still scheduled.
 *
 * Demo fixtures are left alone: scripts/seed-demo.ts plants live rows on
 * purpose and they are excluded from polling for the same reason.
 */
export function closeUntrackedPrograms(now: Date = new Date()): number {
  const untracked = db
    .select({ id: channels.id })
    .from(channels)
    .where(
      and(
        not(like(channels.platformChannelId, 'demo-%')),
        or(
          eq(channels.enabled, false),
          notInArray(
            channels.id,
            db.select({ id: subjectChannels.channelId }).from(subjectChannels),
          ),
        ),
      ),
    )
    .all()
    .map((row) => row.id);

  if (untracked.length === 0) return 0;

  // endsAt keeps its last provisional value, which is the closest estimate of
  // when the broadcast stopped that anything ever recorded.
  const ended = db
    .update(programs)
    .set({ state: 'aired', endsAtProvisional: false, updatedAt: now })
    .where(and(inArray(programs.channelId, untracked), eq(programs.state, 'live')))
    .run();

  return ended.changes;
}
