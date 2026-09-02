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
import { channels, channelSyncState, type Platform } from '@/drizzle/schema';
import type { ChannelRef, Connector } from '@/lib/connectors/types';
import { QuotaExhaustedError } from '@/lib/connectors/youtube';
import type { Observation } from './reconcile';
import { reconcile } from './reconcile';
import { applyWrites, loadWatchRefs, loadWorkingSet } from './persist';

export const LIVE_INTERVAL_MS = 60_000;
export const SCHEDULE_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const VOD_INTERVAL_MS = 60 * 60 * 1000;

/** Spacing between per-channel requests, so a big lineup does not burst. */
const REQUEST_SPACING_MS = 120;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function enabledChannels(platform: Platform): ChannelRef[] {
  const rows = db
    .select({
      id: channels.id,
      platformChannelId: channels.platformChannelId,
      login: channels.login,
    })
    .from(channels)
    .where(and(eq(channels.platform, platform), eq(channels.enabled, true)))
    .all()
    // Rows planted by scripts/seed-demo.ts are not real channels; polling them
    // would report every demo stream as offline and wreck the fixture.
    .filter((c) => !c.platformChannelId.startsWith('demo-'));

  const watchRefs = loadWatchRefs(rows.map((r) => r.id));
  return rows.map((r) => ({ ...r, watchRefs: watchRefs.get(r.id) ?? [] }));
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
): Promise<void> {
  const targets = enabledChannels(connector.platform);
  if (targets.length === 0) return;

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
  runPerChannel(c, 'schedule', (ch) => c.fetchSchedule(ch));

export const runVodTick = (c: Connector) => runPerChannel(c, 'vod', (ch) => c.fetchRecentVods(ch));

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

export function startPoller(connectors: Connector[]): () => void {
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
  }

  return () => stops.forEach((stop) => stop());
}
