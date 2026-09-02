/**
 * YouTube connector.
 *
 * Shaped almost entirely by quota. The Data API v3 gives 10,000 units a day and
 * `search.list` costs 100 of them — about 100 calls before the app is dead until
 * midnight Pacific. So search is never used. Instead:
 *
 *   - the lineup is curated, so there is nothing to search for;
 *   - a channel's uploads playlist id is derived from its id (UC… → UU…) rather
 *     than fetched, which is free;
 *   - discovery reads that playlist (1 unit per channel);
 *   - liveness re-checks known video ids through videos.list, which takes 50 ids
 *     for 1 unit.
 *
 * Every call is metered through a QuotaLedger before it is made.
 */
import type { Observation } from '@/lib/ingest/reconcile';
import { chunk, type ChannelRef, type Connector, type QuotaLedger, type ResolvedChannel } from './types';

const API = 'https://www.googleapis.com/youtube/v3';

/** videos.list accepts 50 ids per request, for a single unit. */
const VIDEO_BATCH = 50;

/** Cost in quota units, per the published table. */
const COST = { channels: 1, playlistItems: 1, videos: 1 } as const;

/** How many recent uploads to inspect per channel when discovering. */
const DISCOVERY_DEPTH = 15;

/**
 * YouTube discovery has to run far more often than Twitch's, because it is the
 * only way a new broadcast is noticed at all — there is no cheap "is this
 * channel live" endpoint.
 */
const DISCOVERY_INTERVAL_MS = 15 * 60 * 1000;

interface YouTubeChannel {
  id: string;
  snippet: {
    title: string;
    customUrl?: string;
    thumbnails?: { default?: { url: string }; medium?: { url: string } };
  };
}

interface PlaylistItem {
  contentDetails: { videoId: string };
}

interface YouTubeVideo {
  id: string;
  snippet: {
    title: string;
    channelId: string;
    publishedAt: string;
    liveBroadcastContent: 'live' | 'upcoming' | 'none';
    thumbnails?: { medium?: { url: string }; high?: { url: string } };
  };
  liveStreamingDetails?: {
    scheduledStartTime?: string;
    actualStartTime?: string;
    actualEndTime?: string;
  };
}

interface ListResponse<T> {
  items?: T[];
}

export class YouTubeApiError extends Error {
  constructor(
    readonly status: number,
    readonly endpoint: string,
    body: string,
  ) {
    super(`YouTube ${endpoint} → ${status}: ${body.slice(0, 200)}`);
    this.name = 'YouTubeApiError';
  }
}

export class QuotaExhaustedError extends Error {
  constructor(readonly endpoint: string) {
    super(`YouTube daily quota exhausted; skipping ${endpoint}`);
    this.name = 'QuotaExhaustedError';
  }
}

/**
 * A channel's uploads playlist id is its channel id with the second character
 * changed from C to U. Deriving it avoids a channels.list call per channel per
 * run, and it cannot go stale.
 */
export function uploadsPlaylistId(channelId: string): string | null {
  return channelId.startsWith('UC') ? `UU${channelId.slice(2)}` : null;
}

const thumb = (v: YouTubeVideo): string | null =>
  v.snippet.thumbnails?.high?.url ?? v.snippet.thumbnails?.medium?.url ?? null;

const watchUrl = (videoId: string) => `https://www.youtube.com/watch?v=${videoId}`;

export class YouTubeConnector implements Connector {
  readonly platform = 'youtube' as const;
  readonly scheduleIntervalMs = DISCOVERY_INTERVAL_MS;

  constructor(
    private readonly apiKey: string,
    private readonly quota: QuotaLedger,
  ) {}

  static fromEnv(quota: QuotaLedger): YouTubeConnector | null {
    const key = process.env.YOUTUBE_API_KEY;
    return key ? new YouTubeConnector(key, quota) : null;
  }

  private async get<T>(endpoint: string, params: URLSearchParams, cost: number): Promise<T | null> {
    // Metered before the call: overshooting the daily cap takes the platform
    // offline until midnight Pacific.
    if (!this.quota.trySpend(cost)) throw new QuotaExhaustedError(endpoint);

    params.set('key', this.apiKey);
    const res = await fetch(`${API}/${endpoint}?${params}`);

    if (res.status === 403 || res.status === 429) {
      // Google's own quota rejection. Believe it over the local ledger, which
      // may be behind if the key is shared with anything else.
      throw new QuotaExhaustedError(endpoint);
    }
    if (res.status === 404) return null;
    if (!res.ok) throw new YouTubeApiError(res.status, endpoint, await res.text());

    return (await res.json()) as T;
  }

  async resolveChannels(handles: string[]): Promise<Map<string, ResolvedChannel>> {
    const out = new Map<string, ResolvedChannel>();

    // channels.list takes one handle at a time, unlike its id-based form.
    for (const handle of handles) {
      const params = new URLSearchParams({
        part: 'snippet',
        forHandle: handle.startsWith('@') ? handle : `@${handle}`,
      });

      const body = await this.get<ListResponse<YouTubeChannel>>(
        'channels',
        params,
        COST.channels,
      );
      const channel = body?.items?.[0];
      if (!channel) continue;

      out.set(handle.toLowerCase(), {
        platformChannelId: channel.id,
        login: channel.snippet.customUrl ?? handle,
        displayName: channel.snippet.title,
        avatarUrl:
          channel.snippet.thumbnails?.medium?.url ??
          channel.snippet.thumbnails?.default?.url ??
          null,
      });
    }

    return out;
  }

  /**
   * Re-checks the broadcasts already being tracked. Costs one unit per 50 ids
   * regardless of how many channels they span, which is what makes a per-minute
   * poll affordable.
   */
  async fetchLive(channels: ChannelRef[]): Promise<Observation[]> {
    const byPlatformId = new Map(channels.map((c) => [c.platformChannelId, c]));
    const refs = channels.flatMap((c) => c.watchRefs ?? []);
    if (refs.length === 0) return channels.map((c) => ({ kind: 'offline', channelId: c.id }));

    const videos = await this.fetchVideos(refs);
    const observations = this.toObservations(videos, byPlatformId);

    const liveChannelIds = new Set(
      observations.filter((o) => o.kind === 'live').map((o) => o.channelId),
    );
    for (const channel of channels) {
      if (!liveChannelIds.has(channel.id)) {
        observations.push({ kind: 'offline', channelId: channel.id });
      }
    }

    return observations;
  }

  /**
   * For YouTube this is discovery as much as scheduling: reading the uploads
   * playlist is the only affordable way to notice a broadcast that is not
   * already tracked.
   */
  async fetchSchedule(channel: ChannelRef): Promise<Observation[]> {
    const playlistId = uploadsPlaylistId(channel.platformChannelId);
    if (!playlistId) return [];

    const params = new URLSearchParams({
      part: 'contentDetails',
      playlistId,
      maxResults: String(DISCOVERY_DEPTH),
    });

    const body = await this.get<ListResponse<PlaylistItem>>(
      'playlistItems',
      params,
      COST.playlistItems,
    );

    const videoIds = (body?.items ?? []).map((i) => i.contentDetails.videoId).filter(Boolean);
    if (videoIds.length === 0) return [];

    const videos = await this.fetchVideos(videoIds);
    return this.toObservations(videos, new Map([[channel.platformChannelId, channel]]));
  }

  /**
   * Finished broadcasts are already produced by the passes above — a completed
   * stream carries actualEndTime and becomes a VOD observation there — so this
   * costs nothing rather than duplicating the work.
   */
  async fetchRecentVods(): Promise<Observation[]> {
    return [];
  }

  private async fetchVideos(ids: string[]): Promise<YouTubeVideo[]> {
    const unique = [...new Set(ids)];
    const videos: YouTubeVideo[] = [];

    for (const batch of chunk(unique, VIDEO_BATCH)) {
      const params = new URLSearchParams({
        part: 'snippet,liveStreamingDetails',
        id: batch.join(','),
        maxResults: String(VIDEO_BATCH),
      });

      const body = await this.get<ListResponse<YouTubeVideo>>('videos', params, COST.videos);
      videos.push(...(body?.items ?? []));
    }

    return videos;
  }

  private toObservations(
    videos: YouTubeVideo[],
    byPlatformId: Map<string, ChannelRef>,
  ): Observation[] {
    const observations: Observation[] = [];

    for (const video of videos) {
      const channel = byPlatformId.get(video.snippet.channelId);
      if (!channel) continue;

      const details = video.liveStreamingDetails;
      // No liveStreamingDetails at all means an ordinary upload, not a
      // broadcast. This is a guide to live programming, so it has no slot.
      if (!details) continue;

      const common = {
        channelId: channel.id,
        platformRef: video.id,
        title: video.snippet.title,
        canonicalUrl: watchUrl(video.id),
        thumbnailUrl: thumb(video),
      };

      if (details.actualEndTime && details.actualStartTime) {
        observations.push({
          kind: 'vod',
          ...common,
          vodRef: video.id,
          startsAt: new Date(details.actualStartTime),
          endsAt: new Date(details.actualEndTime),
        });
        continue;
      }

      if (video.snippet.liveBroadcastContent === 'live' && details.actualStartTime) {
        observations.push({
          kind: 'live',
          ...common,
          category: null,
          startedAt: new Date(details.actualStartTime),
        });
        continue;
      }

      if (details.scheduledStartTime) {
        observations.push({
          kind: 'scheduled',
          ...common,
          category: null,
          startsAt: new Date(details.scheduledStartTime),
          // YouTube announces a start but never a duration, so the reconciler
          // applies its default slot length.
          endsAt: null,
        });
      }
    }

    return observations;
  }
}
