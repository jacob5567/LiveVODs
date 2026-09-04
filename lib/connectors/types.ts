import type { Platform } from '@/drizzle/schema';
import type { Observation } from '@/lib/ingest/reconcile';

/** The subset of a channel row a connector needs to do its work. */
export interface ChannelRef {
  /** Local database id — what observations are keyed by. */
  id: number;
  platformChannelId: string;
  login: string;
  /**
   * Platform refs already being tracked for this channel (scheduled or live).
   *
   * Twitch ignores this: /helix/streams answers "who is live" for a channel
   * directly. YouTube has no such endpoint that is affordable — search.list
   * costs 100 of a 10,000 daily budget — so it re-checks known video ids at 1
   * unit per 50 instead. The poller supplies these so connectors stay free of
   * database access.
   */
  watchRefs?: string[];
}

/**
 * Daily API spend tracking. YouTube allows 10,000 units per day and exhausting
 * it takes the whole platform offline until the reset, so spend is checked
 * before every call rather than counted afterwards.
 */
export interface QuotaLedger {
  /** Records the spend and returns false if it would exceed the cap. */
  trySpend(units: number): boolean;
  remaining(): number;
}

/** Result of turning a config identifier into something stable. */
export interface ResolvedChannel {
  platformChannelId: string;
  login: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface Connector {
  readonly platform: Platform;

  /**
   * Override for how often the schedule pass runs. YouTube needs a shorter
   * interval than Twitch because for YouTube that pass is also how new
   * broadcasts are discovered at all.
   */
  readonly scheduleIntervalMs?: number;

  /**
   * Turn the identifiers in config/channels.yml (Twitch logins, YouTube handles)
   * into stable platform ids, so a channel that later renames keeps its history.
   */
  resolveChannels(identifiers: string[]): Promise<Map<string, ResolvedChannel>>;

  /**
   * Current live state for every channel given. Must emit an observation for
   * *each* input channel — `live` for those broadcasting and `offline` for the
   * rest — so the reconciler never has to infer which channels a poll covered.
   */
  fetchLive(channels: ChannelRef[]): Promise<Observation[]>;

  /** Announced upcoming slots for one channel. Empty if the platform has none. */
  fetchSchedule(channel: ChannelRef): Promise<Observation[]>;

  /** Recently finished broadcasts, used to backfill exact durations. */
  fetchRecentVods(channel: ChannelRef): Promise<Observation[]>;

  /**
   * The channel's whole back catalogue, fetched once. Optional: Twitch expires
   * its VODs after weeks, so there is no deep history there to collect.
   */
  fetchBackfill?(channel: ChannelRef): Promise<Observation[]>;
}

/** Split a list into chunks, for endpoints that accept N ids per request. */
export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
