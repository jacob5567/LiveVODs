import { describe, expect, it } from 'vitest';
import {
  MAX_SLOT_MS,
  MIN_SLOT_MS,
  dayBounds,
  programmeDay,
  programmeWindow,
  type Appointment,
  type LibraryItem,
} from './schedule';

const MIN = 60_000;
const HOUR = 60 * MIN;

/** Local midnight, since the scheduler programmes local days. */
const DAY = dayBounds(Date.parse('2026-09-02T12:00:00')).start;
const at = (hours: number) => DAY + hours * HOUR;

const item = (programId: number, minutes: number): LibraryItem => ({
  programId,
  durationMs: minutes * MIN,
});

const appointment = (programId: number, fromHour: number, toHour: number): Appointment => ({
  programId,
  startsAt: at(fromHour),
  endsAt: at(toHour),
});

const library = (count: number, minutes = 30) =>
  Array.from({ length: count }, (_, i) => item(i + 1, minutes));

/** Just the placements; the chain handed on is asserted separately. */
const day = (
  subjectId: number,
  dayStartMs: number,
  appointments: Appointment[],
  library: LibraryItem[],
) => programmeDay(subjectId, dayStartMs, appointments, library).placements;

const fills = (placements: ReturnType<typeof day>) =>
  placements.filter((p) => !p.isAppointment);

describe('appointments', () => {
  it('keeps a real broadcast exactly where it belongs', () => {
    const placed = day(1, DAY, [appointment(99, 20, 22)], library(10));
    const anchor = placed.find((p) => p.programId === 99)!;

    expect(anchor.isAppointment).toBe(true);
    expect(anchor.startsAt).toBe(at(20));
    expect(anchor.endsAt).toBe(at(22));
  });

  it('never lets library content overlap an appointment', () => {
    const placed = day(1, DAY, [appointment(99, 20, 22)], library(40));

    for (const fill of fills(placed)) {
      expect(fill.startsAt >= at(22) || fill.endsAt <= at(20)).toBe(true);
    }
  });

  it('drops a clashing appointment rather than drawing two at once', () => {
    // Two channels in one subject can broadcast simultaneously, but only one
    // can hold the row.
    const placed = day(
       1,
      DAY,
      [appointment(1, 20, 23), appointment(2, 21, 22)],
      [],
    );

    expect(placed.map((p) => p.programId)).toEqual([1]);
  });

  it('prefers the longer programme when two start together', () => {
    const placed = day(1, DAY, [appointment(1, 20, 21), appointment(2, 20, 23)], []);
    expect(placed.map((p) => p.programId)).toEqual([2]);
  });
});

describe('filling gaps', () => {
  it('fills a day that has no appointments at all', () => {
    // The case that motivated subjects: an upload-only row must still have
    // something on it.
    const placed = day(1, DAY, [], library(40));
    expect(fills(placed).length).toBeGreaterThan(20);
  });

  it('lays library content out back to back with no overlaps', () => {
    const placed = day(1, DAY, [appointment(99, 12, 14)], library(40));

    for (let i = 1; i < placed.length; i++) {
      expect(placed[i].startsAt).toBeGreaterThanOrEqual(placed[i - 1].endsAt);
    }
  });

  it('stays inside the day', () => {
    const { start, end } = dayBounds(DAY);
    for (const placement of day(1, DAY, [], library(40))) {
      expect(placement.startsAt).toBeGreaterThanOrEqual(start);
      expect(placement.endsAt).toBeLessThanOrEqual(end);
    }
  });

  it('never stretches or trims an item to fit', () => {
    const placed = day(1, DAY, [], [item(1, 50), item(2, 20)]);
    for (const fill of fills(placed)) {
      expect([50 * MIN, 20 * MIN]).toContain(fill.endsAt - fill.startsAt);
    }
  });

  it('skips an item too long for a gap between two appointments', () => {
    // Boxed in on both sides, so there is no overrun to fall back on: a
    // four-hour VOD cannot go in the hour between them, the half-hour can.
    const placed = day(
      1,
      DAY,
      [appointment(98, 0, 12), appointment(99, 13, 24)],
      [item(1, 240), item(2, 30)],
    );

    expect(fills(placed).length).toBeGreaterThan(0);
    expect(fills(placed).every((f) => f.programId === 2)).toBe(true);
  });

  it('never lets an overrun run into the next appointment', () => {
    // The last programme of a day may cross midnight, but not into something
    // that is actually scheduled to be on.
    const placed = day(
      1,
      DAY,
      [appointment(99, 25, 30)], // 1am–6am tomorrow
      [item(1, 240), item(2, 30)],
    );

    for (const fill of fills(placed)) {
      expect(fill.endsAt).toBeLessThanOrEqual(DAY + 25 * HOUR);
    }
  });

  it('exhausts the library before repeating anything', () => {
    const placed = day(1, DAY, [], library(6, 60));
    const firstSix = fills(placed).slice(0, 6).map((f) => f.programId);

    expect(new Set(firstSix).size).toBe(6);
  });

  it('leaves slivers empty rather than filling them', () => {
    for (const fill of fills(day(1, DAY, [], library(40)))) {
      expect(fill.endsAt - fill.startsAt).toBeGreaterThanOrEqual(MIN_SLOT_MS);
    }
  });

  it('ignores items too short or too long to be programming', () => {
    const placed = day(1, DAY, [], [item(1, 1), item(2, MAX_SLOT_MS / MIN + 60)]);
    expect(fills(placed)).toEqual([]);
  });

  it('produces only appointments when there is no library', () => {
    const placed = day(1, DAY, [appointment(99, 20, 22)], []);
    expect(placed).toHaveLength(1);
    expect(placed[0].isAppointment).toBe(true);
  });

  it('produces nothing at all for an empty subject', () => {
    expect(day(1, DAY, [], [])).toEqual([]);
  });
});

describe('determinism', () => {
  it('programmes the same day identically every time', () => {
    // The guide refetches whenever the worker writes. A random fill would
    // reshuffle the whole row under the viewer every few seconds.
    const a = day(1, DAY, [appointment(99, 20, 22)], library(30));
    const b = day(1, DAY, [appointment(99, 20, 22)], library(30));

    expect(a).toEqual(b);
  });

  it('gives two subjects different running orders', () => {
    const a = fills(day(1, DAY, [], library(30))).map((f) => f.programId);
    const b = fills(day(2, DAY, [], library(30))).map((f) => f.programId);

    // Otherwise every row sharing a channel would play the same thing at once.
    expect(a).not.toEqual(b);
  });

  it('plays different content tomorrow because the order has moved on', () => {
    // Not because the date reseeds — days continue one running order now, so
    // tomorrow carries on instead of starting the same list again.
    const two = programmeWindow(1, DAY, DAY + 48 * HOUR, [], library(30));
    const today = two.filter((p) => p.startsAt < DAY + 24 * HOUR).map((p) => p.programId);
    const tomorrow = two.filter((p) => p.startsAt >= DAY + 24 * HOUR).map((p) => p.programId);

    expect(today.length).toBeGreaterThan(0);
    expect(tomorrow.length).toBeGreaterThan(0);
    expect(today).not.toEqual(tomorrow);
  });
});

describe('crossing midnight', () => {
  it('leaves no dead air at the boundary', () => {
    // The bug this fixes: every day used to end on a remainder too small for
    // anything in the library, so every row lost a stretch of air at midnight.
    const placed = programmeWindow(1, DAY, DAY + 48 * HOUR, [], library(40, 37));
    const midnight = DAY + 24 * HOUR;

    const before = placed.filter((p) => p.startsAt < midnight).sort((a, b) => a.endsAt - b.endsAt);
    const after = placed.filter((p) => p.endsAt > midnight).sort((a, b) => a.startsAt - b.startsAt);

    const last = before[before.length - 1];
    const next = after.find((p) => p.startsAt >= last.endsAt);

    // Either a programme runs straight through the boundary, or the next one
    // begins exactly where the previous ended.
    expect(next ? next.startsAt : last.endsAt).toBe(last.endsAt);
  });

  it('lets a programme run through the boundary rather than stopping short', () => {
    const midnight = DAY + 24 * HOUR;
    const placed = programmeWindow(1, DAY, DAY + 48 * HOUR, [], library(40, 37));

    expect(placed.some((p) => p.startsAt < midnight && p.endsAt > midnight)).toBe(true);
  });

  it('continues the running order instead of restarting it', () => {
    // Each day used to reshuffle independently, so a programme could close one
    // day and open the next.
    const midnight = DAY + 24 * HOUR;
    const placed = programmeWindow(1, DAY, DAY + 48 * HOUR, [], library(40, 37));
    const ordered = placed.sort((a, b) => a.startsAt - b.startsAt);

    const across = ordered.findIndex((p) => p.endsAt > midnight);
    expect(ordered[across - 1].programId).not.toBe(ordered[across].programId);
  });
});

describe('programmeWindow', () => {
  it('returns only what overlaps the window', () => {
    const from = at(10);
    const to = at(14);

    for (const placement of programmeWindow(1, from, to, [], library(40))) {
      expect(placement.endsAt).toBeGreaterThan(from);
      expect(placement.startsAt).toBeLessThan(to);
    }
  });

  it('programmes across a day boundary', () => {
    const from = at(22);
    const to = at(26); // 2am tomorrow

    const placed = programmeWindow(1, from, to, [], library(40));

    expect(placed.some((p) => p.startsAt < at(24))).toBe(true);
    expect(placed.some((p) => p.startsAt >= at(24))).toBe(true);
  });

  it('agrees with a longer window over the hours they share', () => {
    // A day is no longer programmed independently, so the property that matters
    // is that widening the window does not rewrite what was already on screen.
    const short = programmeWindow(1, at(9), at(15), [], library(40));
    const long = programmeWindow(1, at(9), at(30), [], library(40));

    expect(short.length).toBeGreaterThan(0);
    for (const placement of short) {
      expect(long).toContainEqual(placement);
    }
  });

  it('comes back sorted', () => {
    const placed = programmeWindow(1, at(0), at(30), [], library(40));
    for (let i = 1; i < placed.length; i++) {
      expect(placed[i].startsAt).toBeGreaterThanOrEqual(placed[i - 1].startsAt);
    }
  });
});
