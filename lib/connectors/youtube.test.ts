import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryQuotaLedger } from '@/lib/ingest/quota';
import {
  QuotaExhaustedError,
  YouTubeConnector,
  parseIsoDuration,
  uploadsPlaylistId,
} from './youtube';
import type { ChannelRef } from './types';
import type {
  LiveObservation,
  ScheduledObservation,
  VodObservation,
} from '@/lib/ingest/reconcile';

function mockYouTube(routes: Record<string, unknown>) {
  const calls: string[] = [];

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL) => {
      const url = String(input);
      calls.push(url);
      for (const [fragment, body] of Object.entries(routes)) {
        if (url.includes(`/${fragment}?`)) {
          if (typeof body === 'number') return new Response('err', { status: body });
          return new Response(JSON.stringify(body), { status: 200 });
        }
      }
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    }),
  );

  return { calls };
}

const channel = (overrides: Partial<ChannelRef> = {}): ChannelRef => ({
  id: 1,
  platformChannelId: 'UCabc123',
  login: '@alice',
  watchRefs: [],
  ...overrides,
});

const connector = (quota = new MemoryQuotaLedger()) => new YouTubeConnector('key', quota);

const video = (overrides: Record<string, unknown> = {}) => ({
  id: 'vid-1',
  snippet: {
    title: 'Stream',
    channelId: 'UCabc123',
    publishedAt: '2026-09-01T18:00:00Z',
    liveBroadcastContent: 'none',
    thumbnails: { high: { url: 'https://i.ytimg.com/hq.jpg' } },
  },
  ...overrides,
});

afterEach(() => vi.unstubAllGlobals());

describe('uploadsPlaylistId', () => {
  it('derives the uploads playlist from the channel id', () => {
    // Saves a channels.list call per channel per run, and cannot go stale.
    expect(uploadsPlaylistId('UCabc123')).toBe('UUabc123');
  });

  it('returns nothing for an id that is not a channel id', () => {
    expect(uploadsPlaylistId('PLplaylist')).toBeNull();
  });
});

describe('parseIsoDuration', () => {
  it.each([
    ['PT12M34S', (12 * 60 + 34) * 1000],
    ['PT1H2M3S', ((60 + 2) * 60 + 3) * 1000],
    ['PT45S', 45_000],
    ['P1DT2H', 26 * 60 * 60 * 1000],
    // Live broadcasts report P0D; zero is rejected by the caller.
    ['P0D', 0],
    [undefined, 0],
    ['nonsense', 0],
  ])('parses %s', (input, expected) => {
    expect(parseIsoDuration(input as string | undefined)).toBe(expected);
  });
});

describe('quota discipline', () => {
  it('never calls search.list', async () => {
    // search.list costs 100 of 10,000 units. One accidental use in a poll loop
    // would exhaust the day's budget in under two hours.
    const { calls } = mockYouTube({
      playlistItems: { items: [{ contentDetails: { videoId: 'vid-1' } }] },
      videos: { items: [] },
    });

    await connector().fetchSchedule(channel());
    await connector().fetchLive([channel({ watchRefs: ['vid-1'] })]);

    expect(calls.some((c) => c.includes('/search'))).toBe(false);
  });

  it('checks 50 video ids for a single unit', async () => {
    mockYouTube({ videos: { items: [] } });
    const quota = new MemoryQuotaLedger();

    const refs = Array.from({ length: 50 }, (_, i) => `vid-${i}`);
    await connector(quota).fetchLive([channel({ watchRefs: refs })]);

    expect(quota.spent()).toBe(1);
  });

  it('splits past 50 ids into further batches', async () => {
    const { calls } = mockYouTube({ videos: { items: [] } });
    const quota = new MemoryQuotaLedger();

    const refs = Array.from({ length: 120 }, (_, i) => `vid-${i}`);
    await connector(quota).fetchLive([channel({ watchRefs: refs })]);

    expect(calls.filter((c) => c.includes('/videos?'))).toHaveLength(3);
    expect(quota.spent()).toBe(3);
  });

  it('refuses the call rather than overshooting the daily cap', async () => {
    mockYouTube({ videos: { items: [] } });
    const quota = new MemoryQuotaLedger(0);

    await expect(
      connector(quota).fetchLive([channel({ watchRefs: ['vid-1'] })]),
    ).rejects.toBeInstanceOf(QuotaExhaustedError);
  });

  it('believes Google over the local ledger when it returns 403', async () => {
    // The key may be shared with something else, so the local count can be behind.
    mockYouTube({ videos: 403 });

    await expect(
      connector().fetchLive([channel({ watchRefs: ['vid-1'] })]),
    ).rejects.toBeInstanceOf(QuotaExhaustedError);
  });

  it('spends nothing when a channel has nothing worth re-checking', async () => {
    const { calls } = mockYouTube({});
    const quota = new MemoryQuotaLedger();

    const observations = await connector(quota).fetchLive([channel({ watchRefs: [] })]);

    expect(quota.spent()).toBe(0);
    expect(calls).toHaveLength(0);
    expect(observations).toEqual([{ kind: 'offline', channelId: 1 }]);
  });

  it('costs nothing to fetch VODs, which the other passes already produce', async () => {
    const quota = new MemoryQuotaLedger();
    expect(await connector(quota).fetchRecentVods()).toEqual([]);
    expect(quota.spent()).toBe(0);
  });
});

describe('mapping videos to observations', () => {
  it('maps a running broadcast to live', async () => {
    mockYouTube({
      videos: {
        items: [
          video({
            snippet: { ...video().snippet, liveBroadcastContent: 'live' },
            liveStreamingDetails: { actualStartTime: '2026-09-01T19:00:00Z' },
          }),
        ],
      },
    });

    const observations = await connector().fetchLive([channel({ watchRefs: ['vid-1'] })]);
    const live = observations.find((o) => o.kind === 'live') as LiveObservation;

    expect(live).toMatchObject({ channelId: 1, platformRef: 'vid-1' });
    expect(live.startedAt).toEqual(new Date('2026-09-01T19:00:00Z'));
    expect(observations.some((o) => o.kind === 'offline')).toBe(false);
  });

  it('maps an announced premiere to a scheduled slot with no end time', async () => {
    mockYouTube({
      playlistItems: { items: [{ contentDetails: { videoId: 'vid-1' } }] },
      videos: {
        items: [
          video({
            snippet: { ...video().snippet, liveBroadcastContent: 'upcoming' },
            liveStreamingDetails: { scheduledStartTime: '2026-09-02T19:00:00Z' },
          }),
        ],
      },
    });

    const [obs] = (await connector().fetchSchedule(channel())) as ScheduledObservation[];

    expect(obs.startsAt).toEqual(new Date('2026-09-02T19:00:00Z'));
    // YouTube announces a start but never a duration; the reconciler supplies
    // its default slot length.
    expect(obs.endsAt).toBeNull();
  });

  it('maps a finished broadcast to a VOD with its real duration', async () => {
    mockYouTube({
      videos: {
        items: [
          video({
            liveStreamingDetails: {
              actualStartTime: '2026-09-01T19:00:00Z',
              actualEndTime: '2026-09-01T21:30:00Z',
            },
          }),
        ],
      },
    });

    const [obs] = (await connector().fetchLive([
      channel({ watchRefs: ['vid-1'] }),
    ])) as VodObservation[];

    expect(obs.kind).toBe('vod');
    expect(obs.endsAt.getTime() - obs.startsAt.getTime()).toBe(150 * 60_000);
    expect(obs.vodRef).toBe('vid-1');
  });

  it('takes an ordinary upload as library content, with its real length', async () => {
    // No liveStreamingDetails — a normal video. It never aired, but the guide
    // programmes it into gaps, which is what stops an upload-only channel's
    // subject row sitting permanently empty.
    mockYouTube({
      playlistItems: { items: [{ contentDetails: { videoId: 'vid-1' } }] },
      videos: { items: [video({ contentDetails: { duration: 'PT12M34S' } })] },
    });

    const [obs] = (await connector().fetchSchedule(channel())) as VodObservation[];

    expect(obs.kind).toBe('vod');
    expect(obs.isUpload).toBe(true);
    expect(obs.endsAt.getTime() - obs.startsAt.getTime()).toBe((12 * 60 + 34) * 1000);
  });

  it('drops an upload with no usable duration', async () => {
    mockYouTube({
      playlistItems: { items: [{ contentDetails: { videoId: 'vid-1' } }] },
      videos: { items: [video()] },
    });

    expect(await connector().fetchSchedule(channel())).toEqual([]);
  });

  it('drops videos belonging to a channel that was not asked about', async () => {
    mockYouTube({
      videos: {
        items: [
          video({
            snippet: { ...video().snippet, channelId: 'UCsomeoneelse' },
            liveStreamingDetails: { actualStartTime: '2026-09-01T19:00:00Z' },
          }),
        ],
      },
    });

    const observations = await connector().fetchLive([channel({ watchRefs: ['vid-1'] })]);
    expect(observations).toEqual([{ kind: 'offline', channelId: 1 }]);
  });
});

describe('discovery', () => {
  it('reads the derived uploads playlist, not a search', async () => {
    const { calls } = mockYouTube({
      playlistItems: { items: [{ contentDetails: { videoId: 'vid-1' } }] },
      videos: { items: [] },
    });

    await connector().fetchSchedule(channel({ platformChannelId: 'UCabc123' }));

    const playlistCall = calls.find((c) => c.includes('/playlistItems?'))!;
    expect(new URL(playlistCall).searchParams.get('playlistId')).toBe('UUabc123');
  });

  it('spends nothing further when a channel has no uploads', async () => {
    const quota = new MemoryQuotaLedger();
    mockYouTube({ playlistItems: { items: [] } });

    expect(await connector(quota).fetchSchedule(channel())).toEqual([]);
    // The playlist read itself, and no videos.list follow-up.
    expect(quota.spent()).toBe(1);
  });
});

describe('resolveChannels', () => {
  it('resolves a handle to a stable channel id', async () => {
    mockYouTube({
      channels: {
        items: [
          {
            id: 'UCabc123',
            snippet: {
              title: 'Alice',
              customUrl: '@alice',
              thumbnails: { medium: { url: 'https://i.ytimg.com/a.jpg' } },
            },
          },
        ],
      },
    });

    const found = await connector().resolveChannels(['@Alice']);
    expect(found.get('@alice')).toMatchObject({
      platformChannelId: 'UCabc123',
      displayName: 'Alice',
    });
  });

  it('adds the missing @ to a bare handle', async () => {
    const { calls } = mockYouTube({ channels: { items: [] } });

    await connector().resolveChannels(['alice']);

    expect(new URL(calls[0]).searchParams.get('forHandle')).toBe('@alice');
  });
});
