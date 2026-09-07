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
import { MIN_SLOT_MS } from '@/lib/schedule';
import {
  chunk,
  type ChannelRef,
  type Connector,
  type QuotaLedger,
  type ResolvedChannel,
  type SeriesAssignment,
} from './types';

const API = 'https://www.googleapis.com/youtube/v3';

/** videos.list accepts 50 ids per request, for a single unit. */
const VIDEO_BATCH = 50;

/** Cost in quota units, per the published table. */
const COST = { channels: 1, playlistItems: 1, playlists: 1, videos: 1 } as const;

/**
 * Playlists read per channel, largest first.
 *
 * Enumerating them is one unit; reading their contents is one per fifty
 * entries, which is where the cost is. A creator's big playlists are their
 * actual series — the long tail is one-off collections — so taking the largest
 * few buys nearly all of the signal for a fraction of the spend.
 */
const SERIES_MAX_PLAYLISTS = 12;

/** Entries read from any one playlist. Four units at the very most. */
const SERIES_MAX_ITEMS = 200;

/**
 * Below this a playlist is not a series.
 *
 * Matches the threshold lib/series.ts uses for inferred series: two entries
 * together is a pair, not a run worth giving the row over to.
 */
const SERIES_MIN_ITEMS = 3;

/**
 * How many recent uploads to inspect per channel when discovering.
 *
 * The full 50 the endpoint allows, because it costs exactly the same single
 * unit as asking for one. It matters more than it looks: the uploads playlist
 * interleaves Shorts, and a channel posting mostly Shorts buries its real
 * videos. Bart Ehrman's 25 most recent uploads are 21 Shorts and 4 long
 * videos — at a depth of 15 the guide would have found barely two.
 */
const DISCOVERY_DEPTH = 50;

/**
 * How far back a one-time backfill reaches.
 *
 * A back catalogue does not change, so paginating it deeply is a cost paid
 * once — two units per fifty videos — while the recurring pass keeps looking
 * only at the newest page. Without this the library was capped at whatever one
 * page returned, and half the lineup sat truncated at fifty videos with
 * hundreds more never seen.
 */
export const BACKFILL_DEPTH = 1000;

/**
 * YouTube discovery still runs far more often than Twitch's, because it is the
 * only way a new broadcast is noticed at all — there is no cheap "is this
 * channel live" endpoint. Hourly rather than every quarter hour, since a
 * channel's back catalogue is collected once by the backfill pass and only the
 * newest page can have changed since.
 */
const DISCOVERY_INTERVAL_MS = 60 * 60 * 1000;

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

interface YouTubePlaylist {
  id: string;
  snippet: { title: string };
  contentDetails?: { itemCount?: number };
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
  contentDetails?: { duration?: string };
  liveStreamingDetails?: {
    scheduledStartTime?: string;
    actualStartTime?: string;
    actualEndTime?: string;
  };
}

interface ListResponse<T> {
  items?: T[];
  nextPageToken?: string;
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

/**
 * YouTube reports length as an ISO 8601 duration: PT1H2M3S, PT45S, P1DT2H.
 * Live broadcasts report P0D, which is correctly read as zero and rejected by
 * the caller.
 */
export function parseIsoDuration(duration: string | undefined): number {
  if (!duration) return 0;
  const match = duration.match(
    /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/,
  );
  if (!match) return 0;

  const [, d, h, m, s] = match;
  return (
    ((Number(d ?? 0) * 24 + Number(h ?? 0)) * 60 + Number(m ?? 0)) * 60_000 +
    Math.round(Number(s ?? 0) * 1000)
  );
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

    // No YouTube channel is ever broadcasting as far as the guide is
    // concerned, so every channel polled is offline. The pass still earns its
    // keep: it is what notices a premiere finishing and turns it into a
    // recording, and what closes any live row left over from before.
    for (const channel of channels) {
      observations.push({ kind: 'offline', channelId: channel.id });
    }

    return observations;
  }

  /**
   * For YouTube this is discovery as much as scheduling: reading the uploads
   * playlist is the only affordable way to notice a broadcast that is not
   * already tracked.
   */
  async fetchSchedule(channel: ChannelRef): Promise<Observation[]> {
    // One page, always. Only the newest page can have changed since the
    // backfill, and pagination here is what made the daily cost grow.
    return this.readUploads(channel, DISCOVERY_DEPTH, 1);
  }

  /**
   * The whole back catalogue, or as much of it as BACKFILL_DEPTH allows. Run
   * once per channel: what it returns cannot change afterwards.
   */
  async fetchBackfill(channel: ChannelRef): Promise<Observation[]> {
    return this.readUploads(channel, BACKFILL_DEPTH, Math.ceil(BACKFILL_DEPTH / 50));
  }

  private async readUploads(
    channel: ChannelRef,
    want: number,
    maxPages: number,
  ): Promise<Observation[]> {
    const playlistId = uploadsPlaylistId(channel.platformChannelId);
    if (!playlistId) return [];

    const videoIds: string[] = [];
    let pageToken: string | undefined;
    let pages = 0;

    while (videoIds.length < want && pages < maxPages) {
      pages += 1;
      const params = new URLSearchParams({
        part: 'contentDetails',
        playlistId,
        maxResults: String(Math.min(50, want - videoIds.length)),
      });
      if (pageToken) params.set('pageToken', pageToken);

      const body = await this.get<ListResponse<PlaylistItem>>(
        'playlistItems',
        params,
        COST.playlistItems,
      );
      if (!body) break;

      for (const item of body.items ?? []) {
        if (item.contentDetails?.videoId) videoIds.push(item.contentDetails.videoId);
      }

      pageToken = body.nextPageToken;
      // The catalogue ran out before the depth did.
      if (!pageToken || (body.items ?? []).length === 0) break;
    }

    if (videoIds.length === 0) return [];

    const videos = await this.fetchVideos(videoIds);
    return this.toObservations(videos, new Map([[channel.platformChannelId, channel]]));
  }

  /**
   * The channel's playlists, as series membership for the videos inside them.
   *
   * A creator putting videos in a playlist is them saying those videos belong
   * together, which no amount of title-guessing matches. Read once per channel
   * behind the same quota gate as the backfill.
   */
  async fetchSeries(channel: ChannelRef): Promise<SeriesAssignment[]> {
    const params = new URLSearchParams({
      part: 'snippet,contentDetails',
      channelId: channel.platformChannelId,
      maxResults: '50',
    });

    const body = await this.get<ListResponse<YouTubePlaylist>>(
      'playlists',
      params,
      COST.playlists,
    );

    const playlists = (body?.items ?? [])
      .filter((p) => (p.contentDetails?.itemCount ?? 0) >= SERIES_MIN_ITEMS)
      // Largest first: those are the series, and the budget stops partway down.
      .sort((a, b) => (b.contentDetails?.itemCount ?? 0) - (a.contentDetails?.itemCount ?? 0))
      .slice(0, SERIES_MAX_PLAYLISTS);

    const out: SeriesAssignment[] = [];
    const claimed = new Set<string>();

    for (const playlist of playlists) {
      for (const videoId of await this.readPlaylist(playlist.id)) {
        // A video can sit in several playlists. The largest wins, which is why
        // these are walked in size order — and it keeps one video in one series.
        if (claimed.has(videoId)) continue;
        claimed.add(videoId);
        out.push({ platformRef: videoId, seriesId: playlist.id, seriesTitle: playlist.snippet.title });
      }
    }

    return out;
  }

  /** Video ids in one playlist, up to SERIES_MAX_ITEMS. */
  private async readPlaylist(playlistId: string): Promise<string[]> {
    const ids: string[] = [];
    let pageToken: string | undefined;

    while (ids.length < SERIES_MAX_ITEMS) {
      const params = new URLSearchParams({
        part: 'contentDetails',
        playlistId,
        maxResults: String(Math.min(50, SERIES_MAX_ITEMS - ids.length)),
      });
      if (pageToken) params.set('pageToken', pageToken);

      const body = await this.get<ListResponse<PlaylistItem>>(
        'playlistItems',
        params,
        COST.playlistItems,
      );
      if (!body) break;

      for (const item of body.items ?? []) {
        if (item.contentDetails?.videoId) ids.push(item.contentDetails.videoId);
      }

      pageToken = body.nextPageToken;
      if (!pageToken || (body.items ?? []).length === 0) break;
    }

    return ids;
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
        part: 'snippet,contentDetails,liveStreamingDetails',
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

      const common = {
        channelId: channel.id,
        platformRef: video.id,
        title: video.snippet.title,
        canonicalUrl: watchUrl(video.id),
        thumbnailUrl: thumb(video),
      };

      // No liveStreamingDetails means an ordinary upload. It never aired, but
      // it is library content: the guide programmes it into the gaps between
      // real broadcasts, which is what keeps an upload-only channel's row from
      // sitting permanently empty.
      if (!details) {
        const durationMs = parseIsoDuration(video.contentDetails?.duration);
        if (durationMs <= 0) continue;

        /**
         * Shorts. There is no isShort flag on the API, but there does not need
         * to be: anything below the minimum slot can never be programmed, so
         * ingesting it only crowds the library — and a Shorts-heavy channel
         * pushes its own real videos out of the window the guide draws from.
         */
        if (durationMs < MIN_SLOT_MS) continue;

        const publishedAt = new Date(video.snippet.publishedAt);
        observations.push({
          kind: 'vod',
          ...common,
          vodRef: video.id,
          startsAt: publishedAt,
          endsAt: new Date(publishedAt.getTime() + durationMs),
          isUpload: true,
        });
        continue;
      }

      if (details.actualEndTime && details.actualStartTime) {
        /**
         * The recording of a finished broadcast. Kept only where the programme
         * is already known, which on YouTube means a premiere: those are
         * announced with a real duration and so were programmed, while
         * livestreams never were. A stream archive brings nothing to a row —
         * they run for days, and one of them was a fortnight long — so no row
         * is created for one here.
         */
        observations.push({
          kind: 'vod',
          ...common,
          vodRef: video.id,
          startsAt: new Date(details.actualStartTime),
          endsAt: new Date(details.actualEndTime),
          updateOnly: true,
        });
        continue;
      }

      // A YouTube broadcast in progress is deliberately not programmed. Many
      // are perpetual — a 24/7 loop reports a start date years back and no
      // end, so it lands on the grid as a single bar days or months wide and
      // holds the row against everything else. Twitch streams keep their live
      // treatment; there a broadcast is a session with an end.
      if (video.snippet.liveBroadcastContent === 'live') continue;

      if (details.scheduledStartTime) {
        /**
         * The one thing that separates the two kinds of announced broadcast.
         *
         * A premiere is a finished video with an air date: the file exists, so
         * it reports a real duration and is programmed at exactly that length.
         * A livestream has nothing recorded yet and reports P0D — and since
         * YouTube livestreams are not programmed, that is where it ends.
         */
        const durationMs = parseIsoDuration(video.contentDetails?.duration);
        if (durationMs <= 0) continue;

        const startsAt = new Date(details.scheduledStartTime);
        observations.push({
          kind: 'scheduled',
          ...common,
          category: null,
          startsAt,
          endsAt: new Date(startsAt.getTime() + durationMs),
        });
      }
    }

    return observations;
  }
}
