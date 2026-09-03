// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { Guide, GuideSlot } from '@/lib/guide';
import { GuideGrid } from './GuideGrid';

/**
 * happy-dom performs no layout, so anything geometric (bar widths, the
 * up/down navigation that matches programs by horizontal position) is left to
 * the browser. What is worth pinning down here is the wiring: that scrolling
 * publishes the offset the label transform reads, and that ordered navigation
 * moves focus.
 */

// Fixed so "what is on now" is deterministic.
const NOW = Date.parse('2026-09-01T20:00:00.000Z');
const MIN = 60_000;

function guide(): Guide {
  return {
    from: NOW - 4 * 60 * MIN,
    to: NOW + 12 * 60 * MIN,
    subjects: [
      {
        id: 1,
        name: 'Speedrunning',
        channelNames: ['Alice', 'Bob'],
        slots: [
          slot(10, 'Alpha', NOW - 120 * MIN, NOW - 60 * MIN),
          slot(11, 'Beta', NOW - 30 * MIN, NOW + 30 * MIN),
          slot(12, 'Gamma', NOW + 60 * MIN, NOW + 120 * MIN),
        ],
      },
      {
        id: 2,
        name: 'Coffee',
        channelNames: ['Carol'],
        slots: [slot(20, 'Delta', NOW - 30 * MIN, NOW + 30 * MIN)],
      },
    ],
  };
}

function slot(programId: number, title: string, startsAt: number, endsAt: number): GuideSlot {
  return {
    key: `k${programId}`,
    programId,
    platformRef: `ref-${programId}`,
    title,
    category: null,
    startsAt,
    endsAt,
    endsAtProvisional: false,
    state: 'aired',
    // Aired content is library fill, not an appointment — appointments are only
    // ever live or scheduled.
    isAppointment: false,
    isUpload: false,
    originalStartsAt: startsAt,
    canonicalUrl: 'https://twitch.tv/alice',
    vodRef: null,
    channelId: 1,
    channelName: 'Alice',
    channelLogin: 'alice',
    platform: 'twitch',
  };
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  // The grid subscribes to live updates on mount; neither exists in happy-dom.
  vi.stubGlobal(
    'EventSource',
    class {
      addEventListener() {}
      close() {}
    },
  );
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const row = (name: string) => screen.getByRole('button', { name: new RegExp(`Tune in to ${name}`) });

/** The open player. A title also appears in the grid, so assertions scope here. */
const pane = () => within(screen.getByRole('button', { name: 'Close' }).closest('div')!.parentElement!);

describe('GuideGrid', () => {
  beforeEach(() => vi.setSystemTime(NOW));

  it('publishes the scroll offset that program labels slide with', async () => {
    const { container } = render(<GuideGrid guide={guide()} />);

    const scroller = container.querySelector<HTMLElement>('[class*="scroller"]')!;
    const rows = container.querySelector<HTMLElement>('[role="grid"]')!;

    Object.defineProperty(scroller, 'scrollLeft', { value: 640, configurable: true });
    fireEvent.scroll(scroller);

    // Published as a custom property rather than React state: this fires every
    // scroll frame and must not re-render every bar. The write is deferred to
    // the next animation frame, so waiting for it is part of the contract.
    await vi.waitFor(() => expect(rows.style.getPropertyValue('--scroll-x')).toBe('640px'));
  });

  it('coalesces a burst of scroll events into one write', async () => {
    const { container } = render(<GuideGrid guide={guide()} />);
    const scroller = container.querySelector<HTMLElement>('[class*="scroller"]')!;
    const rows = container.querySelector<HTMLElement>('[role="grid"]')!;

    const setProperty = vi.spyOn(rows.style, 'setProperty');

    for (const left of [100, 200, 300, 640]) {
      Object.defineProperty(scroller, 'scrollLeft', { value: left, configurable: true });
      fireEvent.scroll(scroller);
    }

    await vi.waitFor(() => expect(rows.style.getPropertyValue('--scroll-x')).toBe('640px'));

    // Four scroll events, one style write — and it carries the position read at
    // the frame boundary rather than the stale one from the first event.
    expect(setProperty.mock.calls.filter(([name]) => name === '--scroll-x')).toHaveLength(1);
  });

  it('hands each bar its own geometry for the label transform', () => {
    const { container } = render(<GuideGrid guide={guide()} />);
    const label = container.querySelector<HTMLElement>('[class*="label"]')!;

    expect(label.style.getPropertyValue('--bar-left')).toMatch(/^\d+(\.\d+)?px$/);
    expect(label.style.getPropertyValue('--bar-width')).toMatch(/^\d+(\.\d+)?px$/);
  });

  it('makes the row the control, not the individual listings', () => {
    const { container } = render(<GuideGrid guide={guide()} />);

    // Tuning is per channel, so a listing must not be focusable in its own right.
    expect(container.querySelectorAll('button[data-program]')).toHaveLength(0);
    expect(screen.getAllByRole('button', { name: /Tune in to/ })).toHaveLength(2);
  });

  it('tunes in to whatever the row is showing now', () => {
    render(<GuideGrid guide={guide()} />);
    fireEvent.click(row('Speedrunning'));

    // Beta is the slot spanning NOW; Alpha and Gamma are not.
    expect(pane().getByText('Beta')).toBeTruthy();
  });

  it('resumes at the point the programme has reached', () => {
    render(<GuideGrid guide={guide()} />);
    fireEvent.click(row('Speedrunning'));

    // Beta started 30 minutes before NOW, so tuning in joins 30 minutes in
    // rather than restarting it.
    expect(pane().getByText(/Joined 30 min in/)).toBeTruthy();
  });

  it('joins a live broadcast where it is, with no offset', () => {
    const g = guide();
    g.subjects[0].slots[1] = { ...g.subjects[0].slots[1], state: 'live', isAppointment: true };

    render(<GuideGrid guide={g} />);
    fireEvent.click(row('Speedrunning'));

    expect(screen.queryByText(/Joined/)).toBeNull();
  });

  it('tunes to the live broadcast even when its end has fallen behind now', () => {
    // The worker pegs a running broadcast's end to the last poll, so it trails
    // real time. Left to a containment test the row hands out the next repeat
    // while the stream is still on.
    const g = guide();
    g.subjects[0].slots = [
      { ...slot(40, 'Still Running', NOW - 90 * MIN, NOW - MIN),
        state: 'live', isAppointment: true, endsAtProvisional: true },
      slot(41, 'A Repeat', NOW - MIN, NOW + 60 * MIN),
    ];

    render(<GuideGrid guide={g} />);
    fireEvent.click(row('Speedrunning'));

    expect(pane().getByText('Still Running')).toBeTruthy();
    expect(pane().queryByText('A Repeat')).toBeNull();
  });

  it('falls back to the nearest programme when the row has a gap now', () => {
    const g = guide();
    // Nothing spans NOW on this row.
    g.subjects[1].slots = [slot(30, 'Echo', NOW + 5 * 60 * MIN, NOW + 6 * 60 * MIN)];

    render(<GuideGrid guide={g} />);
    fireEvent.click(row('Coffee'));

    expect(pane().getByText('Echo')).toBeTruthy();
  });

  it('moves between rows with the arrow keys', () => {
    render(<GuideGrid guide={guide()} />);

    row('Speedrunning').focus();
    fireEvent.keyDown(screen.getByRole('grid'), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(row('Coffee'));

    fireEvent.keyDown(screen.getByRole('grid'), { key: 'ArrowUp' });
    expect(document.activeElement).toBe(row('Speedrunning'));
  });

  it('stays put at the edges rather than wrapping around', () => {
    render(<GuideGrid guide={guide()} />);

    row('Speedrunning').focus();
    fireEvent.keyDown(screen.getByRole('grid'), { key: 'ArrowUp' });
    expect(document.activeElement).toBe(row('Speedrunning'));
  });

  it('tunes in from the keyboard', () => {
    render(<GuideGrid guide={guide()} />);

    fireEvent.keyDown(row('Speedrunning'), { key: 'Enter' });
    expect(screen.getByRole('link', { name: /Open on twitch/i })).toBeTruthy();
  });

  it('opens the player and closes it again', () => {
    render(<GuideGrid guide={guide()} />);
    expect(screen.queryByRole('link', { name: /Open on/i })).toBeNull();

    fireEvent.click(row('Speedrunning'));
    expect(screen.getByRole('link', { name: /Open on twitch/i })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('link', { name: /Open on/i })).toBeNull();
  });

  it('explains how to populate an empty lineup', () => {
    render(<GuideGrid guide={{ from: NOW, to: NOW + 1000, subjects: [] }} />);
    expect(screen.getByText(/No subjects in the lineup yet/i)).toBeTruthy();
    expect(screen.getByText('config/channels.yml')).toBeTruthy();
  });
});
