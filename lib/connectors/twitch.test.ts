import { afterEach, describe, expect, it, vi } from 'vitest';
import { TwitchConnector, parseTwitchDuration } from './twitch';
import type { ChannelRef } from './types';
import type { LiveObservation, ScheduledObservation, VodObservation } from '@/lib/ingest/reconcile';

/** Routes a mocked fetch by URL substring, recording every call. */
function mockTwitch(routes: Record<string, unknown>) {
  const calls: string[] = [];

  const fetchMock = vi.fn(async (input: string | URL) => {
    const url = String(input);
    calls.push(url);

    if (url.startsWith('https://id.twitch.tv/oauth2/token')) {
      return new Response(JSON.stringify({ access_token: 'tok-1', expires_in: 3600 }), {
        status: 200,
      });
    }

    for (const [fragment, body] of Object.entries(routes)) {
      if (url.includes(fragment)) {
        if (body === 404) return new Response('not found', { status: 404 });
        return new Response(JSON.stringify(body), { status: 200 });
      }
    }

    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  });

  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}

const channel = (id: number, platformChannelId: string, login: string): ChannelRef => ({
  id,
  platformChannelId,
  login,
});

const connector = () => new TwitchConnector('client-id', 'client-secret');

afterEach(() => vi.unstubAllGlobals());

describe('parseTwitchDuration', () => {
  it.each([
    ['3h20m15s', ((3 * 60 + 20) * 60 + 15) * 1000],
    ['20m15s', (20 * 60 + 15) * 1000],
    ['15s', 15_000],
    ['2h', 2 * 60 * 60 * 1000],
    ['', 0],
    ['garbage', 0],
  ])('parses %s', (input, expected) => {
    expect(parseTwitchDuration(input)).toBe(expected);
  });
});

describe('fetchLive', () => {
  it('maps a live stream and sizes the thumbnail template', async () => {
    mockTwitch({
      '/streams': {
        data: [
          {
            id: 'stream-1',
            user_id: '111',
            user_login: 'alice',
            game_name: 'Software and Game Development',
            title: 'Building a thing',
            started_at: '2026-09-01T18:30:00Z',
            thumbnail_url: 'https://cdn/alice-{width}x{height}.jpg',
          },
        ],
      },
    });

    const observations = await connector().fetchLive([channel(1, '111', 'alice')]);
    const live = observations.find((o) => o.kind === 'live') as LiveObservation;

    expect(live).toMatchObject({
      channelId: 1,
      platformRef: 'stream-1',
      title: 'Building a thing',
      category: 'Software and Game Development',
      canonicalUrl: 'https://twitch.tv/alice',
    });
    expect(live.startedAt).toEqual(new Date('2026-09-01T18:30:00Z'));
    // Left unsubstituted these URLs 404.
    expect(live.thumbnailUrl).toBe('https://cdn/alice-440x248.jpg');
  });

  it('emits an explicit offline observation for every channel absent from the response', async () => {
    mockTwitch({
      '/streams': {
        data: [
          {
            id: 'stream-1',
            user_id: '111',
            user_login: 'alice',
            game_name: '',
            title: 'Live',
            started_at: '2026-09-01T18:30:00Z',
            thumbnail_url: '',
          },
        ],
      },
    });

    const observations = await connector().fetchLive([
      channel(1, '111', 'alice'),
      channel(2, '222', 'bob'),
      channel(3, '333', 'carol'),
    ]);

    // Absence is the only offline signal Twitch gives, so it must become explicit
    // here rather than being inferred downstream.
    expect(observations.filter((o) => o.kind === 'offline').map((o) => o.channelId)).toEqual([
      2, 3,
    ]);
  });

  it('splits a lineup larger than 100 into separate requests', async () => {
    const { calls } = mockTwitch({ '/streams': { data: [] } });

    const many = Array.from({ length: 250 }, (_, i) => channel(i + 1, String(i + 1), `c${i}`));
    const observations = await connector().fetchLive(many);

    const streamCalls = calls.filter((c) => c.includes('/streams'));
    expect(streamCalls).toHaveLength(3);
    expect(new URL(streamCalls[0]).searchParams.getAll('user_id')).toHaveLength(100);
    expect(new URL(streamCalls[2]).searchParams.getAll('user_id')).toHaveLength(50);
    expect(observations).toHaveLength(250);
  });

  it('reuses one app token across requests', async () => {
    const { calls } = mockTwitch({ '/streams': { data: [] } });
    const c = connector();

    await c.fetchLive([channel(1, '111', 'alice')]);
    await c.fetchLive([channel(1, '111', 'alice')]);

    expect(calls.filter((u) => u.includes('oauth2/token'))).toHaveLength(1);
  });

  it('does no work for an empty lineup', async () => {
    const { calls } = mockTwitch({});
    expect(await connector().fetchLive([])).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe('fetchSchedule', () => {
  const scheduleBody = (segments: unknown[], vacation: unknown = null) => ({
    '/schedule': { data: { segments, broadcaster_login: 'alice', vacation } },
  });

  it('maps an announced slot', async () => {
    mockTwitch(
      scheduleBody([
        {
          id: 'seg-1',
          start_time: '2026-09-02T19:00:00Z',
          end_time: '2026-09-02T22:00:00Z',
          title: 'Weekly Show',
          canceled_until: null,
          category: { id: '1', name: 'Just Chatting' },
        },
      ]),
    );

    const [obs] = (await connector().fetchSchedule(
      channel(1, '111', 'alice'),
    )) as ScheduledObservation[];

    expect(obs).toMatchObject({
      kind: 'scheduled',
      platformRef: 'seg-1',
      title: 'Weekly Show',
      category: 'Just Chatting',
    });
    expect(obs.endsAt).toEqual(new Date('2026-09-02T22:00:00Z'));
  });

  it('skips cancelled occurrences', async () => {
    mockTwitch(
      scheduleBody([
        {
          id: 'seg-1',
          start_time: '2026-09-02T19:00:00Z',
          end_time: '2026-09-02T22:00:00Z',
          title: 'Cancelled',
          canceled_until: '2026-09-03T00:00:00Z',
          category: null,
        },
      ]),
    );

    expect(await connector().fetchSchedule(channel(1, '111', 'alice'))).toEqual([]);
  });

  it('skips recurring slots that fall inside an announced vacation', async () => {
    // Twitch keeps returning recurring segments straight through a vacation.
    mockTwitch(
      scheduleBody(
        [
          {
            id: 'seg-during',
            start_time: '2026-09-10T19:00:00Z',
            end_time: '2026-09-10T22:00:00Z',
            title: 'Would not air',
            canceled_until: null,
            category: null,
          },
          {
            id: 'seg-after',
            start_time: '2026-09-20T19:00:00Z',
            end_time: '2026-09-20T22:00:00Z',
            title: 'Back from holiday',
            canceled_until: null,
            category: null,
          },
        ],
        { start_time: '2026-09-05T00:00:00Z', end_time: '2026-09-15T00:00:00Z' },
      ),
    );

    const observations = await connector().fetchSchedule(channel(1, '111', 'alice'));
    expect(observations.map((o) => (o as ScheduledObservation).platformRef)).toEqual(['seg-after']);
  });

  it('treats a broadcaster with no schedule as empty, not an error', async () => {
    // /helix/schedule 404s when the broadcaster has never set one up, which is
    // the majority of Twitch.
    mockTwitch({ '/schedule': 404 });
    expect(await connector().fetchSchedule(channel(1, '111', 'alice'))).toEqual([]);
  });
});

describe('fetchRecentVods', () => {
  it('derives the end time from the duration string', async () => {
    mockTwitch({
      '/videos': {
        data: [
          {
            id: 'video-1',
            stream_id: 'stream-1',
            title: 'Yesterday',
            created_at: '2026-09-01T18:00:00Z',
            duration: '2h30m0s',
            thumbnail_url: 'https://cdn/v-{width}x{height}.jpg',
            url: 'https://twitch.tv/videos/1',
          },
        ],
      },
    });

    const [obs] = (await connector().fetchRecentVods(
      channel(1, '111', 'alice'),
    )) as VodObservation[];

    expect(obs.startsAt).toEqual(new Date('2026-09-01T18:00:00Z'));
    expect(obs.endsAt).toEqual(new Date('2026-09-01T20:30:00Z'));
    expect(obs).toMatchObject({ platformRef: 'stream-1', vodRef: 'video-1' });
  });

  it('drops videos with no stream_id, which cannot be tied to a broadcast', async () => {
    // Uploads and highlights have no originating stream; inserting them blind
    // would duplicate the program the live poll already created.
    mockTwitch({
      '/videos': {
        data: [
          {
            id: 'video-2',
            stream_id: null,
            title: 'A highlight',
            created_at: '2026-09-01T18:00:00Z',
            duration: '10m0s',
            thumbnail_url: '',
            url: 'https://twitch.tv/videos/2',
          },
        ],
      },
    });

    expect(await connector().fetchRecentVods(channel(1, '111', 'alice'))).toEqual([]);
  });

  it('drops videos with an unparseable duration', async () => {
    mockTwitch({
      '/videos': {
        data: [
          {
            id: 'video-3',
            stream_id: 'stream-3',
            title: 'Broken',
            created_at: '2026-09-01T18:00:00Z',
            duration: '',
            thumbnail_url: '',
            url: 'https://twitch.tv/videos/3',
          },
        ],
      },
    });

    expect(await connector().fetchRecentVods(channel(1, '111', 'alice'))).toEqual([]);
  });
});

describe('resolveChannels', () => {
  it('maps logins to stable platform ids, case-insensitively', async () => {
    mockTwitch({
      '/users': {
        data: [
          {
            id: '111',
            login: 'alice',
            display_name: 'Alice',
            profile_image_url: 'https://cdn/a.png',
          },
        ],
      },
    });

    const found = await connector().resolveChannels(['ALICE', 'ghost']);

    expect(found.get('alice')).toMatchObject({ platformChannelId: '111', displayName: 'Alice' });
    // A login the API did not return is simply absent, so the caller can report it.
    expect(found.has('ghost')).toBe(false);
  });
});

describe('auth failures', () => {
  it('re-mints the token once on a 401 and retries', async () => {
    let streamCalls = 0;
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.startsWith('https://id.twitch.tv/oauth2/token')) {
        return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), {
          status: 200,
        });
      }
      streamCalls += 1;
      if (streamCalls === 1) return new Response('unauthorized', { status: 401 });
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const observations = await connector().fetchLive([channel(1, '111', 'alice')]);

    expect(streamCalls).toBe(2);
    expect(observations).toEqual([{ kind: 'offline', channelId: 1 }]);
  });

  it('surfaces a bad client secret rather than silently returning nothing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('invalid client', { status: 403 })),
    );

    await expect(connector().fetchLive([channel(1, '111', 'alice')])).rejects.toThrow(/403/);
  });
});
