import { describe, expect, it } from 'vitest';
import {
  embedBlockedByProtocol,
  embedParents,
  embedTargetFor,
  embedUrl,
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

  it('builds a Twitch VOD embed without autoplay', () => {
    const url = new URL(embedUrl({ kind: 'twitch-video', videoId: 'v9' }, ['localhost'])!);
    expect(url.searchParams.get('video')).toBe('v9');
    expect(url.searchParams.get('autoplay')).toBe('false');
  });

  it('builds a YouTube embed, which needs no parent', () => {
    expect(embedUrl({ kind: 'youtube-video', videoId: 'yt-abc' }, [])).toBe(
      'https://www.youtube.com/embed/yt-abc',
    );
  });

  it('returns nothing to embed when unavailable', () => {
    expect(embedUrl({ kind: 'unavailable', reason: 'nope' }, ['localhost'])).toBeNull();
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
