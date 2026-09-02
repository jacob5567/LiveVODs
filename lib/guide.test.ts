import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { HOUR_MS, MINUTE_MS } from '@/lib/time';

// Must be set before lib/db is imported: it resolves the path at module load.
process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'livevods-guide-')), 'test.db');

type Mod = {
  db: typeof import('@/lib/db')['db'];
  channels: typeof import('@/drizzle/schema')['channels'];
  programs: typeof import('@/drizzle/schema')['programs'];
  loadGuideWindow: typeof import('./guide')['loadGuideWindow'];
  guideRevision: typeof import('./guide')['guideRevision'];
};

const m = {} as Mod;
const NOW = new Date('2026-09-01T20:00:00.000Z');
const at = (minutes: number) => new Date(NOW.getTime() + minutes * MINUTE_MS);

let channelId: number;

beforeAll(async () => {
  const dbMod = await import('@/lib/db');
  const schema = await import('@/drizzle/schema');
  const guide = await import('./guide');
  const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');

  Object.assign(m, {
    db: dbMod.db,
    channels: schema.channels,
    programs: schema.programs,
    loadGuideWindow: guide.loadGuideWindow,
    guideRevision: guide.guideRevision,
  });

  migrate(m.db, { migrationsFolder: './drizzle/migrations' });
});

beforeEach(() => {
  m.db.delete(m.programs).run();
  m.db.delete(m.channels).run();

  const [row] = m.db
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
  channelId = row.id;
});

function insertProgram(startMin: number, endMin: number, ref = `ref-${startMin}`) {
  m.db
    .insert(m.programs)
    .values({
      channelId,
      platformRef: ref,
      title: `Program ${ref}`,
      category: null,
      startsAt: at(startMin),
      endsAt: at(endMin),
      endsAtProvisional: false,
      state: 'aired',
      canonicalUrl: 'https://twitch.tv/alice',
      thumbnailUrl: null,
      vodRef: null,
      updatedAt: NOW,
    })
    .run();
}

const programsIn = (fromMin: number, toMin: number) =>
  m.loadGuideWindow(at(fromMin), at(toMin)).channels.flatMap((c) => c.programs);

describe('loadGuideWindow', () => {
  it('includes a program that started before the window and is still running', () => {
    // The case that matters most: a long stream begun hours ago. Selecting only
    // programs that *start* inside the window would drop it entirely.
    insertProgram(-300, 60);
    expect(programsIn(-60, 180)).toHaveLength(1);
  });

  it('includes a program that runs past the end of the window', () => {
    insertProgram(120, 600);
    expect(programsIn(-60, 180)).toHaveLength(1);
  });

  it('excludes programs wholly outside the window', () => {
    insertProgram(-600, -400, 'long-past');
    insertProgram(600, 800, 'far-future');
    expect(programsIn(-60, 180)).toHaveLength(0);
  });

  it('treats the window as half-open so touching programs do not both appear', () => {
    // Ends exactly at the window start.
    insertProgram(-120, -60, 'ends-at-start');
    expect(programsIn(-60, 180)).toHaveLength(0);
  });

  it('returns channels with no programs, so the lineup stays stable', () => {
    // A channel that has not streamed still needs its row on the grid.
    const guide = m.loadGuideWindow(at(-60), at(180));
    expect(guide.channels).toHaveLength(1);
    expect(guide.channels[0].programs).toEqual([]);
  });

  it('reports the window it was asked for', () => {
    const guide = m.loadGuideWindow(at(-60), at(180));
    expect(guide.from).toBe(at(-60).getTime());
    expect(guide.to).toBe(at(180).getTime());
  });

  it('carries platformRef through, which the player embeds', () => {
    insertProgram(0, 60, 'yt-abc');
    expect(programsIn(-60, 180)[0].platformRef).toBe('yt-abc');
  });
});

describe('guideRevision', () => {
  it('is stable when nothing changes', () => {
    insertProgram(0, 60);
    expect(m.guideRevision()).toBe(m.guideRevision());
  });

  it('changes when a program is added', () => {
    insertProgram(0, 60, 'a');
    const before = m.guideRevision();

    insertProgram(120, 180, 'b');
    expect(m.guideRevision()).not.toBe(before);
  });

  it('changes when a program is removed', () => {
    insertProgram(0, 60, 'a');
    insertProgram(120, 180, 'b');
    const before = m.guideRevision();

    // Count is part of the token precisely so deletions register — a delete
    // lowers the row count without moving max(updated_at).
    m.db.delete(m.programs).run();
    expect(m.guideRevision()).not.toBe(before);
  });

  it('survives an empty table', () => {
    expect(() => m.guideRevision()).not.toThrow();
    expect(m.guideRevision()).toBe('0:0');
  });
});
