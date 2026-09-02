/**
 * End-to-end ingest: mocked Twitch HTTP → connector → reconciler → SQLite.
 *
 * The unit suites cover the mapping and the state machine in isolation; this one
 * exists to prove the pieces are actually wired together and that a broadcast
 * survives a full live → offline → VOD lifecycle as a single row in the database.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// Must be set before lib/db is imported: it resolves the path at module load.
process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'livevods-')), 'test.db');

type Mod = {
  db: typeof import('@/lib/db')['db'];
  channels: typeof import('@/drizzle/schema')['channels'];
  programs: typeof import('@/drizzle/schema')['programs'];
  runLiveTick: typeof import('./poller')['runLiveTick'];
  runVodTick: typeof import('./poller')['runVodTick'];
  TwitchConnector: typeof import('@/lib/connectors/twitch')['TwitchConnector'];
};

const m = {} as Mod;
let channelId: number;

beforeAll(async () => {
  const dbMod = await import('@/lib/db');
  const schema = await import('@/drizzle/schema');
  const poller = await import('./poller');
  const twitch = await import('@/lib/connectors/twitch');
  const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');

  Object.assign(m, {
    db: dbMod.db,
    channels: schema.channels,
    programs: schema.programs,
    runLiveTick: poller.runLiveTick,
    runVodTick: poller.runVodTick,
    TwitchConnector: twitch.TwitchConnector,
  });

  migrate(m.db, { migrationsFolder: './drizzle/migrations' });

  const [row] = m.db
    .insert(m.channels)
    .values({
      platform: 'twitch',
      platformChannelId: '111',
      login: 'alice',
      displayName: 'Alice',
      enabled: true,
    })
    .returning({ id: m.channels.id })
    .all();
  channelId = row.id;
});

afterEach(() => vi.unstubAllGlobals());

function stubFetch(routes: Record<string, unknown>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.startsWith('https://id.twitch.tv/oauth2/token')) {
        return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), {
          status: 200,
        });
      }
      for (const [fragment, body] of Object.entries(routes)) {
        if (url.includes(fragment)) return new Response(JSON.stringify(body), { status: 200 });
      }
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }),
  );
}

const liveResponse = {
  '/streams': {
    data: [
      {
        id: 'stream-1',
        user_id: '111',
        user_login: 'alice',
        game_name: 'Just Chatting',
        title: 'Live right now',
        started_at: new Date(Date.now() - 45 * 60_000).toISOString(),
        thumbnail_url: 'https://cdn/a-{width}x{height}.jpg',
      },
    ],
  },
};

const allPrograms = () => m.db.select().from(m.programs).all();

describe('poller integration', () => {
  const connector = () => new m.TwitchConnector('id', 'secret');

  it('writes a live broadcast into the database', async () => {
    stubFetch(liveResponse);
    await m.runLiveTick(connector());

    const rows = allPrograms();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      channelId,
      platformRef: 'stream-1',
      title: 'Live right now',
      category: 'Just Chatting',
      state: 'live',
      endsAtProvisional: true,
    });
  });

  it('is idempotent across repeated polls of an unchanged stream', async () => {
    stubFetch(liveResponse);
    await m.runLiveTick(connector());
    await m.runLiveTick(connector());

    // Still one row — the same broadcast polled three times total.
    expect(allPrograms()).toHaveLength(1);
  });

  it('finalises the program when the channel drops off the live response', async () => {
    stubFetch({ '/streams': { data: [] } });
    await m.runLiveTick(connector());

    const rows = allPrograms();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: 'aired', endsAtProvisional: false });
  });

  it('backfills the exact duration when the VOD appears', async () => {
    const startedAt = allPrograms()[0].startsAt;

    stubFetch({
      '/videos': {
        data: [
          {
            id: 'video-9',
            // Ties the VOD to the very row the live poll created.
            stream_id: 'stream-1',
            title: 'Live right now',
            created_at: startedAt.toISOString(),
            duration: '1h3m0s',
            thumbnail_url: 'https://cdn/v-{width}x{height}.jpg',
            url: 'https://twitch.tv/videos/9',
          },
        ],
      },
    });
    await m.runVodTick(connector());

    const rows = allPrograms();
    // The whole point: still one program, now with a real end time.
    expect(rows).toHaveLength(1);
    expect(rows[0].vodRef).toBe('video-9');
    expect(rows[0].endsAt.getTime() - rows[0].startsAt.getTime()).toBe(63 * 60_000);
    expect(rows[0].endsAtProvisional).toBe(false);
  });

  it('leaves demo fixture channels out of polling entirely', async () => {
    m.db
      .insert(m.channels)
      .values({
        platform: 'twitch',
        platformChannelId: 'demo-twitch-0',
        login: 'demo',
        displayName: 'Demo',
        enabled: true,
      })
      .run();

    const { calls } = { calls: [] as string[] };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        calls.push(String(input));
        if (String(input).includes('oauth2/token')) {
          return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), {
            status: 200,
          });
        }
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }),
    );

    await m.runLiveTick(connector());

    const requested = calls
      .filter((c) => c.includes('/streams'))
      .flatMap((c) => new URL(c).searchParams.getAll('user_id'));
    expect(requested).toEqual(['111']);
  });
});
