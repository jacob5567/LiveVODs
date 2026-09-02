import { describe, expect, it } from 'vitest';
import {
  embedBlockedByProtocol,
  embedParents,
  embedTargetFor,
  embedUrl,
  twitchTimeOffset,
  type EmbedInput,
} from './embed';

const input = (overrides: Partial<EmbedInput> = {}): EmbedInput => ({
  platform: 'twitch',
  login: 'alice',
  platformRef: 'stream-1',
  vodRef: null,
  state: 'live',
  ...overrides,
});

describe('embedTargetFor', () => {
  it('plays a live Twitch broadcast by channel, not by stream id', () => {
    // A Twitch stream id is not playable; only the channel is.
    expect(embedTargetFor(input({ state: 'live' }))).toEqual({
      kind: 'twitch-channel',
      channel: 'alice',
    });
  });

  it('plays a finished Twitch broadcast from its VOD', () => {
    expect(embedTargetFor(input({ state: 'aired', vodRef: 'video-9' }))).toEqual({
      kind: 'twitch-video',
      videoId: 'video-9',
    });
  });

  it('reports unavailable for an aired broadcast with no VOD', () => {
    // Plenty of broadcasters disable VODs, or they expire.
    expect(embedTargetFor(input({ state: 'aired', vodRef: null })).kind).toBe('unavailable');
  });

  it('shows the channel for an upcoming Twitch slot', () => {
    expect(embedTargetFor(input({ state: 'scheduled' }))).toEqual({
      kind: 'twitch-channel',
      channel: 'alice',
    });
  });

  it.each(['scheduled', 'live', 'aired'] as const)(
    'embeds a YouTube program by video id when %s',
    (state) => {
      expect(
        embedTargetFor(input({ platform: 'youtube', platformRef: 'yt-abc', state })),
      ).toEqual({ kind: 'youtube-video', videoId: 'yt-abc' });
    },
  );

  it('prefers an explicit YouTube vodRef over the broadcast id', () => {
    expect(
      embedTargetFor(
        input({ platform: 'youtube', platformRef: 'yt-abc', vodRef: 'yt-xyz', state: 'aired' }),
      ),
    ).toEqual({ kind: 'youtube-video', videoId: 'yt-xyz' });
  });
});

describe('embedParents', () => {
  it('always includes the browsing hostname first', () => {
    expect(embedParents('guide.example.com')).toEqual(['guide.example.com']);
  });

  it('appends configured extras without duplicating', () => {
    expect(embedParents('localhost', ['localhost', 'guide.example.com'])).toEqual([
      'localhost',
      'guide.example.com',
    ]);
  });

  it('ignores empty entries', () => {
    expect(embedParents('localhost', ['', '  '.trim()])).toEqual(['localhost']);
  });
});

describe('embedUrl', () => {
  it('names every parent domain on a Twitch channel embed', () => {
    const url = new URL(
      embedUrl({ kind: 'twitch-channel', channel: 'alice' }, ['localhost', 'example.com'])!,
    );

    expect(url.origin + url.pathname).toBe('https://player.twitch.tv/');
    expect(url.searchParams.get('channel')).toBe('alice');
    // Twitch refuses to play unless the hosting domain is named here.
    expect(url.searchParams.getAll('parent')).toEqual(['localhost', 'example.com']);
  });

  it('builds a Twitch VOD embed', () => {
    const url = new URL(embedUrl({ kind: 'twitch-video', videoId: 'v9' }, ['localhost'])!);
    expect(url.searchParams.get('video')).toBe('v9');
    expect(url.searchParams.getAll('parent')).toEqual(['localhost']);
  });

  it('builds a YouTube embed, which needs no parent', () => {
    const url = new URL(embedUrl({ kind: 'youtube-video', videoId: 'yt-abc' }, [])!);
    expect(url.origin + url.pathname).toBe('https://www.youtube.com/embed/yt-abc');
    expect(url.searchParams.get('parent')).toBeNull();
  });

  it('returns nothing to embed when unavailable', () => {
    expect(embedUrl({ kind: 'unavailable', reason: 'nope' }, ['localhost'])).toBeNull();
  });
});

describe('tuning in part-way through', () => {
  it.each([
    [0, '0h0m0s'],
    [59, '0h0m59s'],
    [20 * 60, '0h20m0s'],
    [3661, '1h1m1s'],
    [-5, '0h0m0s'],
  ])('formats %s seconds for Twitch as %s', (seconds, expected) => {
    expect(twitchTimeOffset(seconds)).toBe(expected);
  });

  it('resumes a Twitch VOD at the offset', () => {
    const url = new URL(embedUrl({ kind: 'twitch-video', videoId: 'v9' }, ['localhost'], 1234)!);
    expect(url.searchParams.get('time')).toBe('0h20m34s');
  });

  it('resumes a YouTube video at the offset, in whole seconds', () => {
    const url = new URL(embedUrl({ kind: 'youtube-video', videoId: 'yt' }, [], 1234.7)!);
    expect(url.searchParams.get('start')).toBe('1234');
  });

  it('omits the offset entirely when starting from the beginning', () => {
    const twitch = new URL(embedUrl({ kind: 'twitch-video', videoId: 'v9' }, ['localhost'], 0)!);
    const youtube = new URL(embedUrl({ kind: 'youtube-video', videoId: 'yt' }, [], 0)!);

    expect(twitch.searchParams.get('time')).toBeNull();
    expect(youtube.searchParams.get('start')).toBeNull();
  });

  it('ignores an offset on a live channel, which has no seekable position', () => {
    const url = new URL(
      embedUrl({ kind: 'twitch-channel', channel: 'alice' }, ['localhost'], 900)!,
    );
    expect(url.searchParams.get('time')).toBeNull();
  });
});

describe('embedBlockedByProtocol', () => {
  it.each([
    ['localhost', 'http:', false],
    ['127.0.0.1', 'http:', false],
    ['guide.example.com', 'https:', false],
    // The deployment trap: served over plain HTTP from a real host, Twitch
    // silently refuses to start.
    ['guide.example.com', 'http:', true],
    ['192.168.1.50', 'http:', true],
  ])('%s over %s → blocked=%s', (hostname, protocol, expected) => {
    expect(embedBlockedByProtocol(protocol, hostname)).toBe(expected);
  });
});
