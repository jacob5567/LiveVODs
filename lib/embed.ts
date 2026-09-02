/**
 * Embed URL construction for the player pane.
 *
 * The awkward part is Twitch's `parent` parameter: the embed refuses to play
 * unless it names the domain hosting the iframe. Rather than making that a
 * config value that silently breaks whenever the site is reached by a different
 * hostname, the caller passes the browser's own location — which is by
 * definition the right answer — and config only ever adds to it.
 */
import type { Platform, ProgramState } from '@/drizzle/schema';

export interface EmbedInput {
  platform: Platform;
  /** Channel login (Twitch) or handle (YouTube). */
  login: string;
  /** Broadcast identity: Twitch stream id, or YouTube video id. */
  platformRef: string;
  /** Playable video id once known. */
  vodRef: string | null;
  state: ProgramState;
}

export type EmbedTarget =
  | { kind: 'twitch-channel'; channel: string }
  | { kind: 'twitch-video'; videoId: string }
  | { kind: 'youtube-video'; videoId: string }
  | { kind: 'unavailable'; reason: string };

export function embedTargetFor(program: EmbedInput): EmbedTarget {
  if (program.platform === 'youtube') {
    // YouTube programs are identified by their video id all the way through, so
    // the same id plays whether the stream is upcoming, live, or finished.
    const videoId = program.vodRef ?? program.platformRef;
    return videoId
      ? { kind: 'youtube-video', videoId }
      : { kind: 'unavailable', reason: 'No video id for this program' };
  }

  if (program.state === 'live') {
    // A Twitch stream id cannot be played back; live playback is by channel.
    return { kind: 'twitch-channel', channel: program.login };
  }

  if (program.vodRef) return { kind: 'twitch-video', videoId: program.vodRef };

  if (program.state === 'scheduled') {
    return { kind: 'twitch-channel', channel: program.login };
  }

  // Aired, but the broadcaster publishes no VOD (or it has expired).
  return { kind: 'unavailable', reason: 'No recording available for this broadcast' };
}

/**
 * Domains permitted to host the Twitch iframe. The browser's own hostname is
 * always first; extras cover reverse proxies and alternate hostnames.
 */
export function embedParents(hostname: string, extra: string[] = []): string[] {
  return [...new Set([hostname, ...extra].filter(Boolean))];
}

/** Twitch wants an offset as 1h2m3s. */
export function twitchTimeOffset(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  return `${h}h${m}m${s}s`;
}

/**
 * `startSeconds` is how far into the programme the viewer is tuning in — the
 * guide places library content on a timeline, so joining a row at 8:20 when the
 * programme began at 8:00 has to start twenty minutes in, the way turning on a
 * television does. A live broadcast ignores it: live is wherever it is.
 */
export function embedUrl(
  target: EmbedTarget,
  parents: string[],
  startSeconds = 0,
): string | null {
  const offset = Math.max(0, Math.floor(startSeconds));

  switch (target.kind) {
    case 'twitch-channel': {
      const params = new URLSearchParams({ channel: target.channel, autoplay: 'true' });
      for (const parent of parents) params.append('parent', parent);
      return `https://player.twitch.tv/?${params}`;
    }
    case 'twitch-video': {
      const params = new URLSearchParams({ video: target.videoId, autoplay: 'true' });
      if (offset > 0) params.set('time', twitchTimeOffset(offset));
      for (const parent of parents) params.append('parent', parent);
      return `https://player.twitch.tv/?${params}`;
    }
    case 'youtube-video': {
      const params = new URLSearchParams({ autoplay: '1' });
      if (offset > 0) params.set('start', String(offset));
      return `https://www.youtube.com/embed/${encodeURIComponent(target.videoId)}?${params}`;
    }
    case 'unavailable':
      return null;
  }
}

/**
 * Twitch requires SSL on any embedding domain other than localhost. Getting this
 * wrong produces a player that simply refuses to start with no useful message,
 * so it is worth detecting and saying out loud.
 */
export function embedBlockedByProtocol(protocol: string, hostname: string): boolean {
  const isLocal = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
  return protocol !== 'https:' && !isLocal;
}
