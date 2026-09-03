'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Guide, GuideSubject } from '@/lib/guide';
import { MINUTE_MS, PX_PER_MINUTE } from '@/lib/time';
import { ProgramCell } from './ProgramCell';
import { PlayerPane, type Selection } from './PlayerPane';
import { useLiveGuide } from './useLiveGuide';
import styles from './GuideGrid.module.css';

const CHANNEL_COL_W = 210;
const ROW_H = 62;
const TICK_MS = 30 * MINUTE_MS;

/** Context kept to the left of the now-line when jumping to it. */
const LEAD_IN_PX = 60 * PX_PER_MINUTE;

/** Keep the now-line honest without re-rendering constantly. */
const CLOCK_INTERVAL_MS = 30_000;

/**
 * Exposed to CSS so a program bar's sticky label knows to stop clear of the
 * channel column rather than sliding underneath it.
 */
const CSS_VARS = { '--channel-col': `${CHANNEL_COL_W}px` } as React.CSSProperties;

const xFor = (ms: number, from: number) => ((ms - from) / MINUTE_MS) * PX_PER_MINUTE;

function formatHour(ms: number): string {
  const d = new Date(ms);
  return d.getMinutes() === 0
    ? d.toLocaleTimeString([], { hour: 'numeric' })
    : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function GuideGrid({
  guide: initialGuide,
  extraParents = [],
}: {
  guide: Guide;
  extraParents?: string[];
}) {
  const guide = useLiveGuide(initialGuide);
  const scroller = useRef<HTMLDivElement>(null);
  const rows = useRef<HTMLDivElement>(null);
  const scrollFrame = useRef(0);
  const [now, setNow] = useState(() => Date.now());
  const [selection, setSelection] = useState<Selection | null>(null);

  /**
   * The selection holds a slot captured at click time. Re-resolving it against
   * the current guide keeps the open player honest — a broadcast that ends
   * while being watched stops claiming to be live.
   */
  const currentSelection = useMemo(() => {
    if (!selection) return null;
    for (const subject of guide.subjects) {
      const slot = subject.slots.find((s) => s.key === selection.slot.key);
      // startSeconds is deliberately carried over untouched: it records where
      // the viewer tuned in, not where the programme is now.
      if (slot) return { slot, startSeconds: selection.startSeconds };
    }
    return selection;
  }, [selection, guide]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), CLOCK_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  const totalWidth = useMemo(
    () => ((guide.to - guide.from) / MINUTE_MS) * PX_PER_MINUTE,
    [guide.from, guide.to],
  );

  const ticks = useMemo(() => {
    const out: Array<{ ms: number; major: boolean }> = [];
    // Start on a clean half hour so labels land on sensible times.
    const first = Math.ceil(guide.from / TICK_MS) * TICK_MS;
    for (let ms = first; ms < guide.to; ms += TICK_MS) {
      out.push({ ms, major: new Date(ms).getMinutes() === 0 });
    }
    return out;
  }, [guide.from, guide.to]);

  const offsetForNow = useCallback(
    // Leave an hour of context to the left rather than pinning now to the edge.
    () => Math.max(0, xFor(Date.now(), guide.from) - LEAD_IN_PX),
    [guide.from],
  );

  const scrollToNow = useCallback(() => {
    scroller.current?.scrollTo({ left: offsetForNow(), behavior: 'smooth' });
  }, [offsetForNow]);

  /**
   * The guide loads hours of past programming, so left-aligned it would open on
   * a view of what already happened.
   *
   * Positioned in a callback ref so it lands during commit rather than after
   * paint, which avoids a visible jump from the left edge. The rAF pass repeats
   * it once layout is settled: assigning scrollLeft before the container is
   * actually scrollable clamps silently to 0, and re-applying costs nothing when
   * the first attempt already worked.
   */
  const attachScroller = useCallback(
    (node: HTMLDivElement | null) => {
      scroller.current = node;
      if (node) node.scrollLeft = offsetForNow();
    },
    [offsetForNow],
  );

  /**
   * The callback ref above lands the scroll during commit, but an element is
   * only scrollable once its content has actually been laid out wider than the
   * viewport — before that, assigning scrollLeft clamps silently to 0. Watching
   * the content settle makes this deterministic instead of a race against the
   * first frame, which the guide lost often enough to open on the wrong hours.
   *
   * Applies once, so it never yanks the view back after the viewer scrolls.
   */
  useEffect(() => {
    const node = scroller.current;
    const content = rows.current;
    if (!node || !content) return;

    let applied = false;
    const apply = () => {
      if (applied || node.scrollWidth <= node.clientWidth) return;
      node.scrollLeft = offsetForNow();
      // Seed the label offset: setting scrollLeft programmatically does fire a
      // scroll event, but publishing here means the first paint is already right.
      content.style.setProperty('--scroll-x', `${node.scrollLeft}px`);
      applied = true;
      observer.disconnect();
    };

    const observer = new ResizeObserver(apply);
    observer.observe(content);
    apply();

    return () => observer.disconnect();
  }, [offsetForNow]);

  /**
   * Publishes the horizontal offset to CSS so program labels can slide with it.
   *
   * A custom property on one element rather than React state: this fires on
   * every scroll frame, and re-rendering every bar that often would be wasteful
   * when nothing about them actually changes.
   */
  const publishScroll = useCallback(() => {
    const node = scroller.current;
    const content = rows.current;
    if (!node || !content || scrollFrame.current) return;

    scrollFrame.current = requestAnimationFrame(() => {
      scrollFrame.current = 0;
      content.style.setProperty('--scroll-x', `${node.scrollLeft}px`);
    });
  }, []);

  useEffect(() => () => cancelAnimationFrame(scrollFrame.current), []);

  const nudge = (hours: number) =>
    scroller.current?.scrollBy({ left: hours * 60 * PX_PER_MINUTE, behavior: 'smooth' });

  /**
   * Tuning in to a row, the way changing channel on a television does: whatever
   * that row is showing at this moment, resumed at the point it has reached
   * rather than restarted from the beginning.
   *
   * The row is the target rather than each bar — you tune to a channel, not to
   * a listing in the grid.
   */
  const tuneIn = useCallback((subject: GuideSubject) => {
    const at = Date.now();

    const showing =
      // A live broadcast is what is on, full stop. Its end time is only ever a
      // floor while it runs, so it must not have to win a containment test.
      subject.slots.find((slot) => slot.isAppointment && slot.state === 'live') ??
      subject.slots.find((slot) => slot.startsAt <= at && slot.endsAt > at) ??
      // In a gap — the midnight seam, or a row with little library. Offer
      // whatever is nearest rather than nothing at all.
      [...subject.slots].sort(
        (a, b) => Math.abs(a.startsAt - at) - Math.abs(b.startsAt - at),
      )[0];

    if (!showing) return;

    // A live broadcast has no meaningful offset; you join it where it is.
    const startSeconds =
      showing.isAppointment || at < showing.startsAt
        ? 0
        : Math.floor((at - showing.startsAt) / 1000);

    setSelection({ slot: showing, startSeconds });
  }, []);

  /**
   * Keyboard navigation. Rows are the interactive element, so up and down move
   * between channels and Enter tunes in; left and right pan the timeline,
   * which is the only other thing there is to do here.
   */
  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    const current = document.activeElement;
    if (!(current instanceof HTMLElement) || !current.dataset.row) return;

    const rowEls = [...event.currentTarget.querySelectorAll<HTMLElement>('[data-row]')];
    const index = rowEls.indexOf(current);

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const next = rowEls[index + (event.key === 'ArrowDown' ? 1 : -1)];
      if (!next) return;
      event.preventDefault();
      next.focus();
      next.scrollIntoView({ block: 'nearest' });
      return;
    }

    if (event.key === 'Home' || event.key === 'End') {
      const next = event.key === 'Home' ? rowEls[0] : rowEls[rowEls.length - 1];
      event.preventDefault();
      next?.focus();
      return;
    }

    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      nudge(event.key === 'ArrowRight' ? 1 : -1);
    }
  }, []);

  const liveCount = guide.subjects.reduce(
    (n, s) => n + s.slots.filter((slot) => slot.state === 'live' && slot.isAppointment).length,
    0,
  );

  if (guide.subjects.length === 0) {
    return (
      <div className={styles.wrap} style={CSS_VARS}>
        <Toolbar liveCount={0} onNow={scrollToNow} onNudge={nudge} />
        <div className={styles.empty}>
          <p>No subjects in the lineup yet.</p>
          <p>
            Each row of the guide is a subject pooling several channels. Define some in{' '}
            <code>config/channels.yml</code>, then run <code>npm run channels:sync</code>. To try
            the guide without API credentials, run <code>npx tsx scripts/seed-demo.ts</code>.
          </p>
        </div>
      </div>
    );
  }

  const nowX = xFor(now, guide.from);
  const nowVisible = now >= guide.from && now <= guide.to;

  return (
    <div className={styles.wrap} style={CSS_VARS}>
      <Toolbar liveCount={liveCount} onNow={scrollToNow} onNudge={nudge} />

      {currentSelection && (
        <PlayerPane
          selection={currentSelection}
          extraParents={extraParents}
          onClose={() => setSelection(null)}
        />
      )}

      <div className={styles.scroller} ref={attachScroller} onScroll={publishScroll}>
        <div className={styles.ruler}>
          <div className={styles.corner} style={{ width: CHANNEL_COL_W }} />
          <div className={styles.ticks} style={{ width: totalWidth }}>
            {ticks.map((tick) => (
              <div
                key={tick.ms}
                className={`${styles.tick} ${tick.major ? '' : styles.tickMinor}`}
                style={{ left: xFor(tick.ms, guide.from) }}
              >
                {tick.major ? formatHour(tick.ms) : ''}
              </div>
            ))}
          </div>
        </div>

        {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
        <div
          className={styles.rows}
          ref={rows}
          onKeyDown={handleKeyDown}
          role="grid"
          tabIndex={-1}
        >
          {guide.subjects.map((subject) => (
            <div
              key={subject.id}
              className={styles.row}
              style={{ height: ROW_H }}
              // The whole row is the target: you tune to a channel, not to a
              // listing. Bars below are presentation only.
              role="button"
              tabIndex={0}
              data-row={subject.id}
              aria-label={`Tune in to ${subject.name}`}
              onClick={() => tuneIn(subject)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                tuneIn(subject);
              }}
            >
              <div className={styles.channel} style={{ width: CHANNEL_COL_W }}>
                <div className={styles.channelText}>
                  <div className={styles.channelName}>{subject.name}</div>
                  <div className={styles.platform}>
                    {subject.channelNames.length === 0
                      ? 'no channels'
                      : `${subject.channelNames.length} channel${
                          subject.channelNames.length === 1 ? '' : 's'
                        }`}
                  </div>
                </div>
              </div>

              <div className={styles.lane} style={{ width: totalWidth }}>
                {subject.slots.map((slot) => (
                  <ProgramCell
                    key={slot.key}
                    slot={slot}
                    viewportStart={guide.from}
                    viewportEnd={guide.to}
                    selected={selection?.slot.key === slot.key}
                  />
                ))}
              </div>
            </div>
          ))}

          {nowVisible && (
            <div className={styles.nowLine} style={{ left: CHANNEL_COL_W + nowX }}>
              <div className={styles.nowLabel}>
                {new Date(now).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Toolbar({
  liveCount,
  onNow,
  onNudge,
}: {
  liveCount: number;
  onNow: () => void;
  onNudge: (hours: number) => void;
}) {
  return (
    <div className={styles.toolbar}>
      <div className={styles.brand}>
        Live<span>VODs</span>
      </div>
      <span style={{ color: 'var(--text-dim)', fontSize: 13 }}>
        {liveCount} live now
      </span>
      <button type="button" className={styles.button} onClick={() => onNudge(-2)}>
        ← 2h
      </button>
      <button type="button" className={styles.button} onClick={() => onNow()}>
        Now
      </button>
      <button type="button" className={styles.button} onClick={() => onNudge(2)}>
        2h →
      </button>
    </div>
  );
}
