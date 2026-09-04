import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MINUTE_MS } from '@/lib/time';
import { dayBounds } from '@/lib/schedule';

// Must be set before lib/db is imported: it resolves the path at module load.
process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'livevods-guide-')), 'test.db');

type Mod = {
  db: typeof import('@/lib/db')['db'];
  channels: typeof import('@/drizzle/schema')['channels'];
  subjects: typeof import('@/drizzle/schema')['subjects'];
  subjectChannels: typeof import('@/drizzle/schema')['subjectChannels'];
  programs: typeof import('@/drizzle/schema')['programs'];
  loadGuideWindow: typeof import('./guide')['loadGuideWindow'];
  guideRevision: typeof import('./guide')['guideRevision'];
  parseGuideWindow: typeof import('./guide')['parseGuideWindow'];
  MAX_GUIDE_SPAN_MS: typeof import('./guide')['MAX_GUIDE_SPAN_MS'];
};

const m = {} as Mod;

/** Midday local, so a ±few-hour window stays inside one programming day. */
const NOW = new Date(dayBounds(Date.parse('2026-09-02T12:00:00')).start + 12 * 60 * MINUTE_MS);
const at = (minutes: number) => new Date(NOW.getTime() + minutes * MINUTE_MS);

let channelId: number;
let subjectId: number;

beforeAll(async () => {
  const dbMod = await import('@/lib/db');
  const schema = await import('@/drizzle/schema');
  const guide = await import('./guide');
  const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');

  Object.assign(m, {
    db: dbMod.db,
    channels: schema.channels,
    subjects: schema.subjects,
    subjectChannels: schema.subjectChannels,
    programs: schema.programs,
    loadGuideWindow: guide.loadGuideWindow,
    guideRevision: guide.guideRevision,
    parseGuideWindow: guide.parseGuideWindow,
    MAX_GUIDE_SPAN_MS: guide.MAX_GUIDE_SPAN_MS,
  });

  migrate(m.db, { migrationsFolder: './drizzle/migrations' });
});

beforeEach(() => {
  m.db.delete(m.programs).run();
  m.db.delete(m.subjectChannels).run();
  m.db.delete(m.subjects).run();
  m.db.delete(m.channels).run();

  const [channel] = m.db
    .insert(m.channels)
    .values({
      platform: 'twitch',
      platformChannelId: '111',
      login: 'alice',
      displayName: 'Alice',
      enabled: true,
    })
    .returning({ id: m.channels.id })
    .all();
  channelId = channel.id;

  const [subject] = m.db
    .insert(m.subjects)
    .values({ name: 'Speedrunning', position: 0 })
    .returning({ id: m.subjects.id })
    .all();
  subjectId = subject.id;

  m.db.insert(m.subjectChannels).values({ subjectId, channelId }).run();
});

function insertLive(startMin: number, provisionalEndMin: number, ref = 'live-1') {
  m.db
    .insert(m.programs)
    .values({
      channelId,
      platformRef: ref,
      title: 'Still Running',
      category: null,
      startsAt: at(startMin),
      endsAt: at(provisionalEndMin),
      // The worker pegs a running broadcast's end to the last poll, so it
      // trails real time.
      endsAtProvisional: true,
      state: 'live',
      canonicalUrl: 'https://twitch.tv/alice',
      thumbnailUrl: null,
      vodRef: null,
      isUpload: false,
      updatedAt: NOW,
    })
    .run();
}

function insertProgram(
  startMin: number,
  endMin: number,
  overrides: Partial<{ state: 'scheduled' | 'live' | 'aired' | 'missed'; ref: string; isUpload: boolean; title: string }> = {},
) {
  m.db
    .insert(m.programs)
    .values({
      channelId,
      platformRef: overrides.ref ?? `ref-${startMin}-${endMin}`,
      title: overrides.title ?? `Program ${startMin}`,
      category: null,
      startsAt: at(startMin),
      endsAt: at(endMin),
      endsAtProvisional: false,
      state: overrides.state ?? 'aired',
      canonicalUrl: 'https://twitch.tv/alice',
      thumbnailUrl: null,
      vodRef: null,
      isUpload: overrides.isUpload ?? false,
      updatedAt: NOW,
    })
    .run();
}

const guideNow = () => m.loadGuideWindow(at(-60), at(180));
const slots = () => guideNow().subjects[0].slots;

describe('subject rows', () => {
  it('returns one row per subject, not per channel', () => {
    const [second] = m.db
      .insert(m.channels)
      .values({
        platform: 'youtube',
        platformChannelId: 'UCx',
        login: '@bob',
        displayName: 'Bob',
        enabled: true,
      })
      .returning({ id: m.channels.id })
      .all();
    m.db.insert(m.subjectChannels).values({ subjectId, channelId: second.id }).run();

    const guide = guideNow();
    expect(guide.subjects).toHaveLength(1);
    expect(guide.subjects[0].channelNames.sort()).toEqual(['Alice', 'Bob']);
  });

  it('keeps a subject with no channels as an empty row', () => {
    m.db.insert(m.subjects).values({ name: 'Empty', position: 1 }).run();

    const guide = guideNow();
    expect(guide.subjects.map((s) => s.name)).toEqual(['Speedrunning', 'Empty']);
    expect(guide.subjects[1].slots).toEqual([]);
  });

  it('orders rows by configured position', () => {
    m.db.insert(m.subjects).values({ name: 'Later', position: 5 }).run();
    m.db.insert(m.subjects).values({ name: 'Earlier', position: -1 }).run();

    expect(guideNow().subjects.map((s) => s.name)).toEqual([
      'Earlier',
      'Speedrunning',
      'Later',
    ]);
  });

  it('names the channel on every slot, since a row pools several', () => {
    insertProgram(-30, 30, { state: 'live' });
    expect(slots().every((s) => s.channelName === 'Alice')).toBe(true);
  });
});

describe('appointments versus library', () => {
  it('places a live broadcast at its real time', () => {
    insertProgram(-30, 30, { state: 'live', ref: 'live-1' });

    const appointment = slots().find((s) => s.isAppointment)!;
    expect(appointment.startsAt).toBe(at(-30).getTime());
    expect(appointment.endsAt).toBe(at(30).getTime());
  });

  it('schedules aired content as library fill, away from its real time', () => {
    // A single 40-minute VOD from a week ago. It has to appear somewhere in
    // today's window even though it aired nowhere near it.
    insertProgram(-60 * 24 * 7, -60 * 24 * 7 + 40, { ref: 'old-vod' });

    const fill = slots().filter((s) => !s.isAppointment);
    expect(fill.length).toBeGreaterThan(0);
    expect(fill[0].originalStartsAt).toBe(at(-60 * 24 * 7).getTime());
    expect(fill[0].startsAt).not.toBe(fill[0].originalStartsAt);
  });

  it('carries upload provenance through to the slot', () => {
    insertProgram(-60 * 24 * 3, -60 * 24 * 3 + 30, { ref: 'upload-1', isUpload: true });
    expect(slots().some((s) => s.isUpload && !s.isAppointment)).toBe(true);
  });

  it('gives each placement a distinct key even when a programme repeats', () => {
    insertProgram(-60 * 24 * 5, -60 * 24 * 5 + 45, { ref: 'only-one' });

    const keys = slots().map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('does not treat library fill as still-running', () => {
    insertProgram(-60 * 24 * 2, -60 * 24 * 2 + 30, { ref: 'past' });
    expect(slots().every((s) => s.isAppointment || !s.endsAtProvisional)).toBe(true);
  });
});

describe('a broadcast that is still running', () => {
  it('covers the present even though its recorded end trails real time', () => {
    // Pegged to a poll a minute ago. Taken literally the row would already have
    // moved on to library content while the stream is still going.
    insertLive(-120, -1);
    insertProgram(-60 * 24 * 3, -60 * 24 * 3 + 30, { ref: 'library' });

    const covering = m
      .loadGuideWindow(at(-60), at(180), NOW)
      .subjects[0].slots.filter((s) => s.startsAt <= NOW.getTime() && s.endsAt > NOW.getTime());

    expect(covering).toHaveLength(1);
    expect(covering[0].title).toBe('Still Running');
    expect(covering[0].isAppointment).toBe(true);
  });

  it('does not schedule library content into the lag', () => {
    insertLive(-120, -1);
    insertProgram(-60 * 24 * 3, -60 * 24 * 3 + 30, { ref: 'library' });

    const fill = m
      .loadGuideWindow(at(-60), at(180), NOW)
      .subjects[0].slots.filter((s) => !s.isAppointment);

    for (const slot of fill) {
      expect(slot.startsAt).toBeGreaterThanOrEqual(NOW.getTime());
    }
  });

  it('leaves a finished broadcast end exactly where it is', () => {
    insertProgram(-120, -60, { state: 'scheduled', ref: 'done' });

    const slot = m
      .loadGuideWindow(at(-180), at(180), NOW)
      .subjects[0].slots.find((s) => s.isAppointment)!;

    expect(slot.endsAt).toBe(at(-60).getTime());
  });
});

describe('window handling', () => {
  it('reports the window it was asked for', () => {
    const guide = m.loadGuideWindow(at(-60), at(180));
    expect(guide.from).toBe(at(-60).getTime());
    expect(guide.to).toBe(at(180).getTime());
  });

  it('returns nothing outside the window', () => {
    insertProgram(-30, 30, { state: 'live' });
    insertProgram(-60 * 24 * 4, -60 * 24 * 4 + 30, { ref: 'lib' });

    for (const slot of slots()) {
      expect(slot.endsAt).toBeGreaterThan(at(-60).getTime());
      expect(slot.startsAt).toBeLessThan(at(180).getTime());
    }
  });

  it('is stable across repeated loads, so live updates do not reshuffle it', () => {
    insertProgram(-60 * 24, -60 * 24 + 30, { ref: 'a' });
    insertProgram(-60 * 25, -60 * 25 + 45, { ref: 'b' });

    expect(slots().map((s) => s.key)).toEqual(slots().map((s) => s.key));
  });
});

describe('guideRevision', () => {
  it('is stable when nothing changes', () => {
    insertProgram(0, 60);
    expect(m.guideRevision()).toBe(m.guideRevision());
  });

  it('changes when a program is added', () => {
    insertProgram(0, 60, { ref: 'a' });
    const before = m.guideRevision();

    insertProgram(120, 180, { ref: 'b' });
    expect(m.guideRevision()).not.toBe(before);
  });

  it('changes when a program is removed', () => {
    insertProgram(0, 60, { ref: 'a' });
    const before = m.guideRevision();

    // Count is part of the token precisely so deletions register — a delete
    // lowers the row count without moving max(updated_at).
    m.db.delete(m.programs).run();
    expect(m.guideRevision()).not.toBe(before);
  });

  it('survives an empty table', () => {
    expect(m.guideRevision()).toBe('0:0');
  });
});

describe('parseGuideWindow', () => {
  const NOW_FIXED = new Date('2026-09-04T12:00:00.000Z');

  it('falls back to the window around now when no bounds are given', () => {
    const result = m.parseGuideWindow(null, null, NOW_FIXED);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.from).toBeLessThan(NOW_FIXED.getTime());
    expect(result.to).toBeGreaterThan(NOW_FIXED.getTime());
  });

  it('accepts the window the guide itself handed out', () => {
    const from = NOW_FIXED.getTime() - 4 * 60 * 60_000;
    const to = NOW_FIXED.getTime() + 12 * 60 * 60_000;

    expect(m.parseGuideWindow(String(from), String(to), NOW_FIXED)).toEqual({
      ok: true,
      from,
      to,
    });
  });

  /**
   * Programming is linear in the days a window spans and runs synchronously on
   * the request thread, so an unbounded `to` was an unauthenticated way to
   * allocate millions of placements and block the process until it ran out of
   * memory. A hundred-year window has to be refused outright.
   */
  it('refuses a window wider than the maximum span', () => {
    const from = NOW_FIXED.getTime();
    const century = from + 100 * 365 * 24 * 60 * 60_000;

    expect(m.parseGuideWindow(String(from), String(century), NOW_FIXED).ok).toBe(false);
    // The largest representable date must not slip through either.
    expect(m.parseGuideWindow('1', '8640000000000000', NOW_FIXED).ok).toBe(false);
  });

  it('allows a window exactly at the limit but not one past it', () => {
    const from = NOW_FIXED.getTime();

    expect(m.parseGuideWindow(String(from), String(from + m.MAX_GUIDE_SPAN_MS), NOW_FIXED).ok).toBe(
      true,
    );
    expect(
      m.parseGuideWindow(String(from), String(from + m.MAX_GUIDE_SPAN_MS + 1), NOW_FIXED).ok,
    ).toBe(false);
  });

  it('treats unparseable bounds as absent rather than failing the request', () => {
    // A bare or broken request still renders a guide; only a well-formed but
    // oversized window is an error worth reporting.
    for (const [from, to] of [
      ['nonsense', 'also-nonsense'],
      ['0', '0'],
      ['500', '400'],
      ['-1', '1000'],
      ['1e400', '1e400'],
    ]) {
      expect(m.parseGuideWindow(from, to, NOW_FIXED).ok).toBe(true);
    }
  });
});
