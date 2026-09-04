'use client';

import { useEffect, useRef, useState } from 'react';
import type { Guide } from '@/lib/guide';

/**
 * How close to the end of its window the clock may get before the guide asks
 * for a new one. The window reaches twelve hours ahead, so in practice this
 * only ever fires on a tab that has been open most of a day.
 */
const RECENTRE_MARGIN_MS = 60 * 60_000;

/**
 * Keeps the guide current as the worker writes.
 *
 * Subscribes to /api/events, which sends a revision token whenever any program
 * changes, and refetches on it. The refetch reuses the window from the initial
 * server render rather than asking for one derived from the current time — so
 * a stream going live swaps a bar in place instead of sliding the whole time
 * axis under the viewer.
 *
 * EventSource reconnects on its own if the stream drops, so there is no retry
 * logic here.
 */
export function useLiveGuide(initial: Guide): Guide {
  const [guide, setGuide] = useState(initial);

  // Fixed for the life of the page; re-deriving it would move the grid.
  const windowRef = useRef({ from: initial.from, to: initial.to });

  useEffect(() => {
    const source = new EventSource('/api/events');
    const controller = new AbortController();
    let inFlight = false;

    const refresh = async () => {
      // Bursts of writes land as several events; one refetch covers them all.
      if (inFlight) return;
      inFlight = true;
      try {
        const { from, to } = windowRef.current;
        /**
         * Normally the window is held fixed, so an update swaps bars in place
         * instead of sliding the axis under the viewer. But a tab left open
         * outlives its window: once now reaches the end of it there is nothing
         * ahead to show and the now-line has left the grid entirely. At that
         * point holding the axis still is the worse trade, so ask for a fresh
         * one and adopt whatever the server centres on.
         */
        const stale = Date.now() >= to - RECENTRE_MARGIN_MS || Date.now() < from;
        const res = await fetch(stale ? '/api/guide' : `/api/guide?from=${from}&to=${to}`, {
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!res.ok) return;

        const next = (await res.json()) as Guide;
        windowRef.current = { from: next.from, to: next.to };
        setGuide(next);
      } catch {
        // Transient: the next revision change triggers another attempt.
      } finally {
        inFlight = false;
      }
    };

    source.addEventListener('guide', refresh);

    return () => {
      controller.abort();
      source.close();
    };
  }, []);

  return guide;
}
