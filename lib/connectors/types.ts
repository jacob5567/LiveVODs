import type { Platform } from '@/drizzle/schema';
import type { Observation } from '@/lib/ingest/reconcile';

/** The subset of a channel row a connector needs to do its work. */
export interface ChannelRef {
  /** Local database id — what observations are keyed by. */
  id: number;
  platformChannelId: string;
  login: string;
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
}

/** Split a list into chunks, for endpoints that accept N ids per request. */
export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
