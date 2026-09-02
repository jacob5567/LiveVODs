/**
 * The only place reconciler output touches the database.
 *
 * Keeping this separate is what lets reconcile.ts stay pure and fully testable;
 * everything here is mechanical translation.
 */
import { and, eq, gt, inArray, lt } from 'drizzle-orm';
import { db } from '@/lib/db';
import { programs } from '@/drizzle/schema';
import type { ProgramRecord, Write } from './reconcile';

/** How far back a finished program stays in the reconciler's working set. */
const LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
/** How far ahead announced slots are considered. */
const LOOKAHEAD_MS = 21 * 24 * 60 * 60 * 1000;

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
export function loadWatchRefs(channelIds: number[]): Map<number, string[]> {
  const out = new Map<number, string[]>();
  if (channelIds.length === 0) return out;

  const rows = db
    .select({ channelId: programs.channelId, platformRef: programs.platformRef })
    .from(programs)
    .where(
      and(
        inArray(programs.channelId, channelIds),
        inArray(programs.state, ['scheduled', 'live']),
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
