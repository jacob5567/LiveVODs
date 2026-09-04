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
    mediaOffsetMs: 0,
    part: 1,
    partCount: 1,
    canonicalUrl: 'https://twitch.tv/alice',
    vodRef: null,
    thumbnailUrl: null,
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
    const rows = container.querySelector<HTMLElement>('[role="group"]')!;

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
    const rows = container.querySelector<HTMLElement>('[role="group"]')!;

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

  it('names the row by what it is playing, since the bars are hidden', () => {
    // Bars are aria-hidden — dozens of absolutely positioned slivers per row is
    // noise, not information. So the row, which is the actual control, has to
    // carry what a sighted viewer reads off the grid, or assistive tech is
    // offered a button with nothing to say about what it plays.
    render(<GuideGrid guide={guide()} />);

    const name = row('Speedrunning').getAttribute('aria-label') ?? '';

    expect(name).toContain('Tune in to Speedrunning');
    // Beta is the programme containing now; Alpha and Gamma are not.
    expect(name).toContain('Beta');
    expect(name).toContain('Alice');
    expect(name).not.toContain('Alpha');
  });

  it('announces a live broadcast as live rather than giving it an end time', () => {
    const g = guide();
    g.subjects[0].slots = [
      { ...slot(30, 'Marathon', NOW - 20 * MIN, NOW + 5 * MIN), state: 'live', isAppointment: true },
    ];
    render(<GuideGrid guide={g} />);

    const name = row('Speedrunning').getAttribute('aria-label') ?? '';

    expect(name).toContain('Live now: Marathon');
    // A running broadcast has no honest end time to announce.
    expect(name).not.toContain('until');
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

  it('seeks past the parts already broadcast when tuning into a later one', () => {
    // Part 3 of a marathon began four hours into the recording. Tuning in
    // twenty minutes after that block started must land at 4h20m, not 20m.
    const g = guide();
    g.subjects[0].slots = [
      {
        ...slot(80, 'ESA Summer', NOW - 20 * MIN, NOW + 100 * MIN),
        mediaOffsetMs: 4 * 60 * MIN,
        part: 3,
        partCount: 7,
      },
    ];

    render(<GuideGrid guide={g} />);
    fireEvent.click(row('Speedrunning'));

    expect(pane().getByText(/Joined 260 min in/)).toBeTruthy();
  });

  it('names the part on a bar so a marathon is legible', () => {
    const g = guide();
    g.subjects[0].slots = [
      { ...slot(81, 'ESA Summer', NOW, NOW + 120 * MIN), part: 3, partCount: 7 },
    ];

    const { container } = render(<GuideGrid guide={g} />);
    expect(container.querySelector('[data-slot="k81"]')!.textContent).toContain('Part 3 of 7');
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
    fireEvent.keyDown(screen.getByRole('group', { name: 'Channel guide' }), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(row('Coffee'));

    fireEvent.keyDown(screen.getByRole('group', { name: 'Channel guide' }), { key: 'ArrowUp' });
    expect(document.activeElement).toBe(row('Speedrunning'));
  });

  it('stays put at the edges rather than wrapping around', () => {
    render(<GuideGrid guide={guide()} />);

    row('Speedrunning').focus();
    fireEvent.keyDown(screen.getByRole('group', { name: 'Channel guide' }), { key: 'ArrowUp' });
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

  it('previews the programme under the pointer', () => {
    const { container } = render(<GuideGrid guide={guide()} />);
    const bar = container.querySelector('[data-slot="k11"]')!;

    fireEvent.mouseOver(bar);

    const preview = container.querySelector('[class*="card"]')!;
    expect(preview).toBeTruthy();
    expect(within(preview as HTMLElement).getByText('Beta')).toBeTruthy();
  });

  it('previews a bar too narrow to carry any label of its own', () => {
    // The case the preview exists for: under about a quarter-hour a bar renders
    // no text at all, so the row is otherwise a strip of anonymous colour.
    const g = guide();
    g.subjects[0].slots = [slot(50, 'Two Minute Short', NOW, NOW + 2 * MIN)];

    const { container } = render(<GuideGrid guide={g} />);
    const bar = container.querySelector('[data-slot="k50"]')!;

    // Nothing legible on the bar itself.
    expect(bar.textContent).toBe('');

    fireEvent.mouseOver(bar);
    const preview = container.querySelector('[class*="card"]') as HTMLElement;
    expect(within(preview).getByText('Two Minute Short')).toBeTruthy();
  });

  it('drops the preview when the pointer moves off a bar', () => {
    const { container } = render(<GuideGrid guide={guide()} />);
    const grid = screen.getByRole('group', { name: 'Channel guide' });

    fireEvent.mouseOver(container.querySelector('[data-slot="k11"]')!);
    expect(container.querySelector('[class*="card"]')).toBeTruthy();

    // A gap between listings is not a bar, so nothing should still be shown.
    fireEvent.mouseOver(grid);
    expect(container.querySelector('[class*="card"]')).toBeNull();
  });

  it('drops the preview on scroll, since its anchor is a viewport rectangle', () => {
    const { container } = render(<GuideGrid guide={guide()} />);
    const scroller = container.querySelector<HTMLElement>('[class*="scroller"]')!;

    fireEvent.mouseOver(container.querySelector('[data-slot="k11"]')!);
    expect(container.querySelector('[class*="card"]')).toBeTruthy();

    fireEvent.scroll(scroller);
    expect(container.querySelector('[class*="card"]')).toBeNull();
  });

  it('shows a repeat as a repeat, with when it first went out', () => {
    const g = guide();
    g.subjects[0].slots = [
      { ...slot(60, 'An Old Upload', NOW, NOW + 30 * MIN),
        isUpload: true, originalStartsAt: Date.parse('2026-08-20T10:00:00Z') },
    ];

    const { container } = render(<GuideGrid guide={g} />);
    fireEvent.mouseOver(container.querySelector('[data-slot="k60"]')!);

    const preview = container.querySelector('[class*="card"]') as HTMLElement;
    expect(within(preview).getByText('REPLAY')).toBeTruthy();
    // Read off the card as a whole: the line sits among sibling text nodes, and
    // the date's ordering belongs to the host locale.
    expect(preview.textContent).toMatch(/Published .*2026/);
  });

  it('collapses the image area when a thumbnail fails to load', () => {
    const g = guide();
    g.subjects[0].slots = [
      { ...slot(70, 'Gone', NOW, NOW + 30 * MIN), thumbnailUrl: 'https://cdn/missing.jpg' },
    ];

    const { container } = render(<GuideGrid guide={g} />);
    fireEvent.mouseOver(container.querySelector('[data-slot="k70"]')!);

    const img = container.querySelector('[class*="thumb"]') as HTMLImageElement;
    expect(img).toBeTruthy();

    // A blank 16:9 block is worse than none, so the space goes.
    fireEvent.error(img);
    expect(container.querySelector('[class*="thumb"]')).toBeNull();
    // The rest of the card is unaffected.
    expect(container.querySelector('[class*="card"]')!.textContent).toContain('Gone');
  });

  it('explains how to populate an empty lineup', () => {
    render(<GuideGrid guide={{ from: NOW, to: NOW + 1000, subjects: [] }} />);
    expect(screen.getByText(/No subjects in the lineup yet/i)).toBeTruthy();
    expect(screen.getByText('config/channels.yml')).toBeTruthy();
  });
});
