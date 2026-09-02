// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { GuideSlot } from '@/lib/guide';
import { PlayerPane } from './PlayerPane';

afterEach(cleanup);

const slot = (overrides: Partial<GuideSlot> = {}): GuideSlot => ({
  key: 'k1',
  programId: 10,
  platformRef: 'stream-1',
  title: 'Building a thing',
  category: 'Software and Game Development',
  startsAt: Date.parse('2026-09-01T19:00:00Z'),
  endsAt: Date.parse('2026-09-01T21:00:00Z'),
  endsAtProvisional: true,
  state: 'live',
  isAppointment: true,
  isUpload: false,
  originalStartsAt: Date.parse('2026-09-01T19:00:00Z'),
  canonicalUrl: 'https://twitch.tv/alice',
  vodRef: null,
  channelId: 1,
  channelName: 'Alice',
  channelLogin: 'alice',
  platform: 'twitch',
  ...overrides,
});

/** happy-dom serves pages from http://localhost/ by default. */
const iframe = () => document.querySelector('iframe');

describe('PlayerPane', () => {
  it('embeds a live Twitch stream with the browsing host as parent', () => {
    render(
      <PlayerPane
        selection={{ slot: slot() }}
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
        selection={{ slot: slot() }}
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
          slot: slot({ platformRef: 'yt-abc', state: 'live', platform: 'youtube', channelLogin: '@alice' }),
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
        selection={{ slot: slot({ state: 'aired', vodRef: null, endsAtProvisional: false }) }}
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
        selection={{ slot: slot() }}
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
        selection={{ slot: slot() }}
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
        selection={{ slot: slot({ state: 'live' }) }}
        extraParents={[]}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText('LIVE')).toBeTruthy();

    rerender(
      <PlayerPane
        selection={{ slot: slot({ state: 'aired', vodRef: 'v1', endsAtProvisional: false }) }}
        extraParents={[]}
        onClose={() => {}}
      />,
    );
    expect(screen.queryByText('LIVE')).toBeNull();
    expect(screen.getByText('AIRED')).toBeTruthy();
  });

  it('calls a repeat a repeat, not live, however the source is stored', () => {
    // Library fill reuses a past broadcast's row, so its state may still read
    // 'live' from when it was ingested. Playing at a time it never aired, it is
    // a repeat.
    render(
      <PlayerPane
        selection={{ slot: slot({ state: 'live', isAppointment: false }) }}
        extraParents={[]}
        onClose={() => {}}
      />,
    );

    expect(screen.queryByText('LIVE')).toBeNull();
    expect(screen.getByText('REPEAT')).toBeTruthy();
  });

  it('says when a repeat was originally published', () => {
    render(
      <PlayerPane
        selection={{
          slot: slot({
            state: 'aired',
            isAppointment: false,
            isUpload: true,
            vodRef: 'v9',
            endsAtProvisional: false,
            originalStartsAt: Date.parse('2026-08-20T10:00:00Z'),
          }),
        }}
        extraParents={[]}
        onClose={() => {}}
      />,
    );

    expect(screen.getByText(/Published Aug 20, 2026/)).toBeTruthy();
  });
});
