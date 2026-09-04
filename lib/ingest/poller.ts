/**
 * The polling ingest loop.
 *
 * Polling is the default transport because both push mechanisms (Twitch EventSub
 * webhooks and YouTube WebSub) need a publicly reachable HTTPS callback, which a
 * self-hosted box usually does not have. This works behind NAT with no inbound
 * firewall rule. Push is the milestone-8 upgrade and writes through the same
 * reconciler.
 */
import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { channels, channelSyncState, subjectChannels, type Platform } from '@/drizzle/schema';
import type { ChannelRef, Connector, QuotaLedger } from '@/lib/connectors/types';
import { QuotaExhaustedError } from '@/lib/connectors/youtube';
import type { Observation } from './reconcile';
import { reconcile } from './reconcile';
import { applyWrites, loadWatchRefs, loadWorkingSet } from './persist';

export const LIVE_INTERVAL_MS = 60_000;
export const SCHEDULE_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const VOD_INTERVAL_MS = 60 * 60 * 1000;
export const BACKFILL_INTERVAL_MS = 5 * 60 * 1000;

/** Spacing between per-channel requests, so a big lineup does not burst. */
const REQUEST_SPACING_MS = 120;

/**
 * Channels refreshed per discovery pass.
 *
 * Discovery costs two quota units per channel, so sweeping the whole lineup
 * every pass makes the daily spend proportional to how many channels there
 * are — at 131 channels that projected 25,000 units against a 9,500 budget,
 * and ingest would simply stop until the quota reset. Refreshing a rotating
 * slice keeps the cost per pass flat however far the lineup grows; a channel
 * comes round roughly hourly, which is ample for noticing a new upload.
 */
const DISCOVERY_BATCH = 30;

/** Channels whose back catalogue is collected per backfill pass. */
const BACKFILL_BATCH = 3;

/**
 * Backfill stops here and leaves the rest of the budget to ordinary ingest.
 *
 * It is a one-off job worth thousands of units, and finishing a day earlier is
 * worth far less than the guide going stale because the daily quota was spent
 * collecting history nobody had asked to see yet.
 */
const BACKFILL_QUOTA_FLOOR = 4_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function enabledChannels(platform: Platform): ChannelRef[] {
  const rows = db
    .select({
      id: channels.id,
      platformChannelId: channels.platformChannelId,
      login: channels.login,
    })
    .from(channels)
    // Only channels that feed a subject are worth spending quota on: a channel
    // on no row cannot be seen, so polling it buys nothing.
    .innerJoin(subjectChannels, eq(subjectChannels.channelId, channels.id))
    .where(and(eq(channels.platform, platform), eq(channels.enabled, true)))
    .groupBy(channels.id)
    .all()
    // Rows planted by scripts/seed-demo.ts are not real channels; polling them
    // would report every demo stream as offline and wreck the fixture.
    .filter((c) => !c.platformChannelId.startsWith('demo-'));

  const watchRefs = loadWatchRefs(rows.map((r) => r.id));
  return rows.map((r) => ({ ...r, watchRefs: watchRefs.get(r.id) ?? [] }));
}

/** Orders by when each channel was last refreshed, oldest first. */
function leastRecentlySynced(
  channels: ChannelRef[],
  field: 'schedule' | 'vod',
  limit: number,
): ChannelRef[] {
  const column = field === 'schedule' ? 'lastScheduleSyncAt' : 'lastVodSyncAt';
  const seen = new Map(
    db
      .select()
      .from(channelSyncState)
      .all()
      .map((r) => [r.channelId, r[column]?.getTime() ?? 0]),
  );

  return [...channels]
    .sort((a, b) => (seen.get(a.id) ?? 0) - (seen.get(b.id) ?? 0))
    .slice(0, limit);
}

function commit(observations: Observation[], channelIds: number[], now: Date) {
  if (observations.length === 0) return { inserted: 0, updated: 0 };
  const existing = loadWorkingSet(channelIds, now);
  return applyWrites(reconcile(existing, observations, now), now);
}

function touchSyncState(channelId: number, field: 'schedule' | 'vod' | 'live', now: Date) {
  const column =
    field === 'schedule'
      ? { lastScheduleSyncAt: now }
      : field === 'vod'
        ? { lastVodSyncAt: now }
        : { lastLiveCheckAt: now };

  db.insert(channelSyncState)
    .values({ channelId, ...column })
    .onConflictDoUpdate({ target: channelSyncState.channelId, set: column })
    .run();
}

export async function runLiveTick(connector: Connector): Promise<void> {
  const targets = enabledChannels(connector.platform);
  if (targets.length === 0) return;

  const now = new Date();
  const observations = await connector.fetchLive(targets);
  const result = commit(
    observations,
    targets.map((c) => c.id),
    now,
  );

  for (const c of targets) touchSyncState(c.id, 'live', now);

  const liveCount = observations.filter((o) => o.kind === 'live').length;
  console.log(
    `[${connector.platform}] live: ${liveCount}/${targets.length} broadcasting ` +
      `(+${result.inserted} ~${result.updated})`,
  );
}

/**
 * Schedule and VOD passes are per-channel, so they are run one channel at a time
 * with a failure of one never aborting the rest — a single broadcaster with a
 * broken schedule must not stall ingest for everyone else.
 */
async function runPerChannel(
  connector: Connector,
  field: 'schedule' | 'vod',
  fetch: (c: ChannelRef) => Promise<Observation[]>,
  batchSize?: number,
): Promise<void> {
  const all = enabledChannels(connector.platform);
  if (all.length === 0) return;

  // Least recently refreshed first, so every channel comes round in turn
  // rather than the same few being swept repeatedly.
  const targets = batchSize ? leastRecentlySynced(all, field, batchSize) : all;

  let inserted = 0;
  let updated = 0;
  let failed = 0;

  for (const channel of targets) {
    const now = new Date();
    try {
      const result = commit(await fetch(channel), [channel.id], now);
      inserted += result.inserted;
      updated += result.updated;
      touchSyncState(channel.id, field, now);
    } catch (error) {
      // Quota is exhausted for every remaining channel too, so stop rather than
      // grinding through the rest to fail identically.
      if (error instanceof QuotaExhaustedError) {
        console.warn(`[${connector.platform}] ${field}: stopping, daily quota exhausted`);
        break;
      }
      failed += 1;
      console.warn(`[${connector.platform}] ${field} failed for ${channel.login}:`, error);
    }
    await sleep(REQUEST_SPACING_MS);
  }

  console.log(
    `[${connector.platform}] ${field}: ${targets.length} channels ` +
      `(+${inserted} ~${updated}${failed ? ` ${failed} failed` : ''})`,
  );
}

export const runScheduleTick = (c: Connector) =>
  runPerChannel(c, 'schedule', (ch) => c.fetchSchedule(ch), DISCOVERY_BATCH);

export const runVodTick = (c: Connector) => runPerChannel(c, 'vod', (ch) => c.fetchRecentVods(ch));

/**
 * Collects the back catalogue of channels that have never had one, a few at a
 * time. A catalogue does not change, so each channel is done once and then
 * left to the ordinary pass, which only ever looks at the newest page.
 */
export async function runBackfillTick(
  connector: Connector,
  quota: QuotaLedger,
): Promise<void> {
  if (!connector.fetchBackfill) return;
  if (quota.remaining() < BACKFILL_QUOTA_FLOOR) return;

  const done = new Set(
    db
      .select()
      .from(channelSyncState)
      .all()
      .filter((r) => r.backfilledAt !== null)
      .map((r) => r.channelId),
  );

  const pending = enabledChannels(connector.platform).filter((c) => !done.has(c.id));
  if (pending.length === 0) return;

  let collected = 0;
  for (const channel of pending.slice(0, BACKFILL_BATCH)) {
    if (quota.remaining() < BACKFILL_QUOTA_FLOOR) break;
    const now = new Date();
    try {
      const result = commit(await connector.fetchBackfill(channel), [channel.id], now);
      collected += result.inserted;

      db.insert(channelSyncState)
        .values({ channelId: channel.id, backfilledAt: now })
        .onConflictDoUpdate({
          target: channelSyncState.channelId,
          set: { backfilledAt: now },
        })
        .run();
    } catch (error) {
      if (error instanceof QuotaExhaustedError) break;
      console.warn(`[${connector.platform}] backfill failed for ${channel.login}:`, error);
    }
    await sleep(REQUEST_SPACING_MS);
  }

  console.log(
    `[${connector.platform}] backfill: +${collected} programmes, ` +
      `${pending.length - Math.min(BACKFILL_BATCH, pending.length)} channels still to do, ` +
      `${quota.remaining()} units left`,
  );
}

/**
 * A tick that never overlaps itself and never lets a rejection kill the loop.
 * setInterval alone would stack passes if one runs long.
 */
function everyMs(label: string, intervalMs: number, task: () => Promise<void>): () => void {
  let running = false;
  let stopped = false;

  const run = async () => {
    if (running || stopped) return;
    running = true;
    try {
      await task();
    } catch (error) {
      // Expected once a day at worst, and self-healing at the quota reset —
      // not worth a stack trace.
      if (error instanceof QuotaExhaustedError) console.warn(`[poller] ${label}: ${error.message}`);
      else console.error(`[poller] ${label} tick failed:`, error);
    } finally {
      running = false;
    }
  };

  void run();
  const handle = setInterval(run, intervalMs);

  return () => {
    stopped = true;
    clearInterval(handle);
  };
}

export function startPoller(connectors: Connector[], quota?: QuotaLedger): () => void {
  const stops: Array<() => void> = [];

  for (const connector of connectors) {
    stops.push(
      everyMs(`${connector.platform}:live`, LIVE_INTERVAL_MS, () => runLiveTick(connector)),
      // YouTube overrides this: for it the schedule pass is also the only way a
      // new broadcast is discovered, so six hours would be far too slow.
      everyMs(
        `${connector.platform}:schedule`,
        connector.scheduleIntervalMs ?? SCHEDULE_INTERVAL_MS,
        () => runScheduleTick(connector),
      ),
      everyMs(`${connector.platform}:vod`, VOD_INTERVAL_MS, () => runVodTick(connector)),
    );

    if (connector.fetchBackfill && quota) {
      stops.push(
        everyMs(`${connector.platform}:backfill`, BACKFILL_INTERVAL_MS, () =>
          runBackfillTick(connector, quota),
        ),
      );
    }
  }

  return () => stops.forEach((stop) => stop());
}
