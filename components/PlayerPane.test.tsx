// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { GuideChannel, GuideProgram } from '@/lib/guide';
import { PlayerPane } from './PlayerPane';

afterEach(cleanup);

const channel = (overrides: Partial<GuideChannel> = {}): GuideChannel => ({
  id: 1,
  platform: 'twitch',
  login: 'alice',
  displayName: 'Alice',
  avatarUrl: null,
  programs: [],
  ...overrides,
});

const program = (overrides: Partial<GuideProgram> = {}): GuideProgram => ({
  id: 10,
  platformRef: 'stream-1',
  title: 'Building a thing',
  category: 'Software and Game Development',
  startsAt: Date.parse('2026-09-01T19:00:00Z'),
  endsAt: Date.parse('2026-09-01T21:00:00Z'),
  endsAtProvisional: true,
  state: 'live',
  canonicalUrl: 'https://twitch.tv/alice',
  vodRef: null,
  ...overrides,
});

/** happy-dom serves pages from http://localhost/ by default. */
const iframe = () => document.querySelector('iframe');

describe('PlayerPane', () => {
  it('embeds a live Twitch stream with the browsing host as parent', () => {
    render(
      <PlayerPane
        selection={{ program: program(), channel: channel() }}
        extraParents={[]}
        onClose={() => {}}
      />,
    );

    const url = new URL(iframe()!.getAttribute('src')!);
    expect(url.origin + url.pathname).toBe('https://player.twitch.tv/');
    expect(url.searchParams.get('channel')).toBe('alice');
    // Auto-detected from window.location rather than configured.
    expect(url.searchParams.getAll('parent')).toEqual(['localhost']);
  });

  it('includes configured extra parents alongside the detected one', () => {
    render(
      <PlayerPane
        selection={{ program: program(), channel: channel() }}
        extraParents={['guide.example.com']}
        onClose={() => {}}
      />,
    );

    expect(new URL(iframe()!.getAttribute('src')!).searchParams.getAll('parent')).toEqual([
      'localhost',
      'guide.example.com',
    ]);
  });

  it('embeds a YouTube program by video id', () => {
    render(
      <PlayerPane
        selection={{
          program: program({ platformRef: 'yt-abc', state: 'live' }),
          channel: channel({ platform: 'youtube', login: '@alice' }),
        }}
        extraParents={[]}
        onClose={() => {}}
      />,
    );

    expect(iframe()!.getAttribute('src')).toBe('https://www.youtube.com/embed/yt-abc');
  });

  it('explains itself instead of embedding when there is no recording', () => {
    render(
      <PlayerPane
        selection={{
          program: program({ state: 'aired', vodRef: null, endsAtProvisional: false }),
          channel: channel(),
        }}
        extraParents={[]}
        onClose={() => {}}
      />,
    );

    expect(iframe()).toBeNull();
    expect(screen.getByText(/No recording available/i)).toBeTruthy();
  });

  it('always offers a way out to the platform', () => {
    render(
      <PlayerPane
        selection={{ program: program(), channel: channel() }}
        extraParents={[]}
        onClose={() => {}}
      />,
    );

    const link = screen.getByRole('link', { name: /Open on twitch/i });
    expect(link.getAttribute('href')).toBe('https://twitch.tv/alice');
    expect(link.getAttribute('rel')).toContain('noopener');
  });

  it('closes on Escape', () => {
    const onClose = vi.fn();
    render(
      <PlayerPane
        selection={{ program: program(), channel: channel() }}
        extraParents={[]}
        onClose={onClose}
      />,
    );

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('shows a live badge only while the broadcast is running', () => {
    const { rerender } = render(
      <PlayerPane
        selection={{ program: program({ state: 'live' }), channel: channel() }}
        extraParents={[]}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText('LIVE')).toBeTruthy();

    rerender(
      <PlayerPane
        selection={{
          program: program({ state: 'aired', vodRef: 'v1', endsAtProvisional: false }),
          channel: channel(),
        }}
        extraParents={[]}
        onClose={() => {}}
      />,
    );
    expect(screen.queryByText('LIVE')).toBeNull();
    expect(screen.getByText('AIRED')).toBeTruthy();
  });
});
