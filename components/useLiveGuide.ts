'use client';

import { useEffect, useRef, useState } from 'react';
import type { Guide } from '@/lib/guide';

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
        const res = await fetch(`/api/guide?from=${from}&to=${to}`, {
          cache: 'no-store',
          signal: controller.signal,
        });
        if (res.ok) setGuide((await res.json()) as Guide);
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
