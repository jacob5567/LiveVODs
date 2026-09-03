/**
 * Twitch connector.
 *
 * Uses the client-credentials grant only — an app access token, no user ever
 * logs in. That constraint is why this polls rather than using EventSub over
 * WebSocket, which requires a user token and fails outright with an app token.
 *
 * Budget: Helix allows 800 points/minute per client id, and /helix/streams takes
 * 100 channels per request, so a 200-channel lineup costs 2 points/minute.
 */
import type { Observation } from '@/lib/ingest/reconcile';
import { chunk, type ChannelRef, type Connector, type ResolvedChannel } from './types';

const HELIX = 'https://api.twitch.tv/helix';
const OAUTH = 'https://id.twitch.tv/oauth2/token';

/** /helix/streams and /helix/users both accept 100 ids per request. */
const BATCH = 100;

/** Refresh a little early rather than discovering expiry mid-poll. */
const TOKEN_SKEW_MS = 60_000;

interface HelixEnvelope<T> {
  data: T[];
  pagination?: { cursor?: string };
}

interface HelixUser {
  id: string;
  login: string;
  display_name: string;
  profile_image_url: string;
}

interface HelixStream {
  id: string;
  user_id: string;
  user_login: string;
  game_name: string;
  title: string;
  started_at: string;
  thumbnail_url: string;
}

interface HelixSegment {
  id: string;
  start_time: string;
  end_time: string | null;
  title: string;
  canceled_until: string | null;
  category: { id: string; name: string } | null;
}

interface HelixScheduleBody {
  data: {
    segments: HelixSegment[] | null;
    broadcaster_login: string;
    vacation: { start_time: string; end_time: string } | null;
  };
}

interface HelixVideo {
  id: string;
  stream_id: string | null;
  title: string;
  created_at: string;
  duration: string;
  thumbnail_url: string;
  url: string;
}

export class TwitchApiError extends Error {
  constructor(
    readonly status: number,
    readonly endpoint: string,
    body: string,
  ) {
    super(`Twitch ${endpoint} → ${status}: ${body.slice(0, 200)}`);
    this.name = 'TwitchApiError';
  }
}

/**
 * Twitch templates the size into its thumbnail URLs, but not consistently:
 * live streams use {width}x{height} and VODs use %{width}x%{height}.
 *
 * Substituting the bare form first is a trap — it matches inside the percent
 * form and leaves a stray %, giving thumb0-%440x%248.jpg, which 404s. One
 * pattern covering both avoids that.
 */
export function sizeThumbnail(url: string | null | undefined, w = 440, h = 248): string | null {
  if (!url) return null;
  // A VOD still being transcoded has a placeholder instead of a real frame.
  if (url.includes('404_processing')) return null;
  return url.replace(/%?\{width\}/g, String(w)).replace(/%?\{height\}/g, String(h));
}

/** Twitch reports VOD length as "3h20m15s" / "20m15s" / "15s". */
export function parseTwitchDuration(duration: string): number {
  const match = duration.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (!match) return 0;
  const [, h, m, s] = match;
  return ((Number(h ?? 0) * 60 + Number(m ?? 0)) * 60 + Number(s ?? 0)) * 1000;
}

export class TwitchConnector implements Connector {
  readonly platform = 'twitch' as const;

  private token: string | null = null;
  private tokenExpiresAt = 0;

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
  ) {}

  static fromEnv(): TwitchConnector | null {
    const id = process.env.TWITCH_CLIENT_ID;
    const secret = process.env.TWITCH_CLIENT_SECRET;
    if (!id || !secret) return null;
    return new TwitchConnector(id, secret);
  }

  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpiresAt - TOKEN_SKEW_MS) return this.token;

    const params = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      grant_type: 'client_credentials',
    });
    const res = await fetch(`${OAUTH}?${params}`, { method: 'POST' });
    if (!res.ok) throw new TwitchApiError(res.status, 'oauth2/token', await res.text());

    const body = (await res.json()) as { access_token: string; expires_in: number };
    this.token = body.access_token;
    this.tokenExpiresAt = Date.now() + body.expires_in * 1000;
    return this.token;
  }

  private async helix<T>(
    path: string,
    params: URLSearchParams,
    opts: { allow404?: boolean } = {},
  ): Promise<T | null> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const token = await this.accessToken();
      const res = await fetch(`${HELIX}/${path}?${params}`, {
        headers: { 'Client-Id': this.clientId, Authorization: `Bearer ${token}` },
      });

      if (res.ok) return (await res.json()) as T;

      // Not every broadcaster has a schedule; that is a 404, not a failure.
      if (res.status === 404 && opts.allow404) return null;

      // Token revoked or expired early — drop it and let the retry re-mint.
      if (res.status === 401) {
        this.token = null;
        continue;
      }

      if (res.status === 429) {
        const reset = Number(res.headers.get('Ratelimit-Reset') ?? 0) * 1000;
        const waitMs = Math.max(1_000, reset - Date.now());
        await new Promise((r) => setTimeout(r, Math.min(waitMs, 30_000)));
        continue;
      }

      throw new TwitchApiError(res.status, path, await res.text());
    }

    throw new TwitchApiError(0, path, 'retries exhausted');
  }

  async resolveChannels(logins: string[]): Promise<Map<string, ResolvedChannel>> {
    const out = new Map<string, ResolvedChannel>();

    for (const batch of chunk(logins, BATCH)) {
      const params = new URLSearchParams();
      for (const login of batch) params.append('login', login.toLowerCase());

      const body = await this.helix<HelixEnvelope<HelixUser>>('users', params);
      for (const user of body?.data ?? []) {
        out.set(user.login.toLowerCase(), {
          platformChannelId: user.id,
          login: user.login,
          displayName: user.display_name,
          avatarUrl: user.profile_image_url ?? null,
        });
      }
    }

    return out;
  }

  async fetchLive(channels: ChannelRef[]): Promise<Observation[]> {
    if (channels.length === 0) return [];

    const byPlatformId = new Map(channels.map((c) => [c.platformChannelId, c]));
    const liveIds = new Set<string>();
    const observations: Observation[] = [];

    for (const batch of chunk(channels, BATCH)) {
      const params = new URLSearchParams({ first: String(BATCH) });
      for (const c of batch) params.append('user_id', c.platformChannelId);

      const body = await this.helix<HelixEnvelope<HelixStream>>('streams', params);

      for (const stream of body?.data ?? []) {
        const channel = byPlatformId.get(stream.user_id);
        if (!channel) continue;

        liveIds.add(stream.user_id);
        observations.push({
          kind: 'live',
          channelId: channel.id,
          platformRef: stream.id,
          title: stream.title || channel.login,
          category: stream.game_name || null,
          startedAt: new Date(stream.started_at),
          canonicalUrl: `https://twitch.tv/${stream.user_login}`,
          thumbnailUrl: sizeThumbnail(stream.thumbnail_url),
        });
      }
    }

    // Absence from the response is the only offline signal Twitch gives us, so
    // it has to be turned into an explicit observation here rather than inferred
    // downstream.
    for (const channel of channels) {
      if (!liveIds.has(channel.platformChannelId)) {
        observations.push({ kind: 'offline', channelId: channel.id });
      }
    }

    return observations;
  }

  async fetchSchedule(channel: ChannelRef): Promise<Observation[]> {
    const params = new URLSearchParams({
      broadcaster_id: channel.platformChannelId,
      first: '25',
    });

    const body = await this.helix<HelixScheduleBody>('schedule', params, { allow404: true });
    const segments = body?.data?.segments ?? [];
    const vacation = body?.data?.vacation;
    const vacationStart = vacation ? new Date(vacation.start_time).getTime() : null;
    const vacationEnd = vacation ? new Date(vacation.end_time).getTime() : null;

    const observations: Observation[] = [];

    for (const segment of segments) {
      // A cancelled occurrence of a recurring slot.
      if (segment.canceled_until) continue;

      const startsAt = new Date(segment.start_time);

      // Twitch keeps returning recurring segments straight through an announced
      // vacation; showing them would fill the guide with slots that cannot air.
      if (
        vacationStart !== null &&
        vacationEnd !== null &&
        startsAt.getTime() >= vacationStart &&
        startsAt.getTime() < vacationEnd
      ) {
        continue;
      }

      observations.push({
        kind: 'scheduled',
        channelId: channel.id,
        platformRef: segment.id,
        title: segment.title || `${channel.login} stream`,
        category: segment.category?.name ?? null,
        startsAt,
        endsAt: segment.end_time ? new Date(segment.end_time) : null,
        canonicalUrl: `https://twitch.tv/${channel.login}`,
        thumbnailUrl: null,
      });
    }

    return observations;
  }

  async fetchRecentVods(channel: ChannelRef): Promise<Observation[]> {
    const params = new URLSearchParams({
      user_id: channel.platformChannelId,
      type: 'archive',
      first: '10',
    });

    const body = await this.helix<HelixEnvelope<HelixVideo>>('videos', params, { allow404: true });
    const observations: Observation[] = [];

    for (const video of body?.data ?? []) {
      // Without stream_id there is no way to tie this back to the live row the
      // poller created, and inserting it blind would duplicate that program.
      if (!video.stream_id) continue;

      const startsAt = new Date(video.created_at);
      const durationMs = parseTwitchDuration(video.duration);
      if (durationMs <= 0) continue;

      observations.push({
        kind: 'vod',
        channelId: channel.id,
        platformRef: video.stream_id,
        vodRef: video.id,
        title: video.title,
        startsAt,
        endsAt: new Date(startsAt.getTime() + durationMs),
        canonicalUrl: video.url,
        thumbnailUrl: sizeThumbnail(video.thumbnail_url),
      });
    }

    return observations;
  }
}
