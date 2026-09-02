import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

// Must be set before lib/db is imported: it resolves the path at module load.
process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'livevods-quota-')), 'test.db');

type Mod = {
  db: typeof import('@/lib/db')['db'];
  apiBudget: typeof import('@/drizzle/schema')['apiBudget'];
  DbQuotaLedger: typeof import('./quota')['DbQuotaLedger'];
};

const m = {} as Mod;

beforeAll(async () => {
  const dbMod = await import('@/lib/db');
  const schema = await import('@/drizzle/schema');
  const quota = await import('./quota');
  const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');

  Object.assign(m, {
    db: dbMod.db,
    apiBudget: schema.apiBudget,
    DbQuotaLedger: quota.DbQuotaLedger,
  });

  migrate(m.db, { migrationsFolder: './drizzle/migrations' });
});

beforeEach(() => m.db.delete(m.apiBudget).run());

/** cap 100, reserve 10 → 90 spendable. */
const ledger = (day: () => string) => new m.DbQuotaLedger('youtube', 100, 10, day);

describe('DbQuotaLedger', () => {
  const today = () => '2026-09-01';

  it('accumulates spend across calls', () => {
    const l = ledger(today);

    expect(l.trySpend(30)).toBe(true);
    expect(l.trySpend(30)).toBe(true);
    expect(l.remaining()).toBe(30);
  });

  it('refuses a spend that would cross the cap, and records nothing', () => {
    const l = ledger(today);
    l.trySpend(85);

    expect(l.trySpend(10)).toBe(false);
    // The rejected units must not be charged, or the budget drifts down every
    // time a call is declined.
    expect(l.remaining()).toBe(5);
  });

  it('keeps a reserve below the platform ceiling', () => {
    const l = ledger(today);
    // Cap is 100 but only 90 is spendable, so a manual sync still works after
    // ingest has stopped for the day.
    expect(l.trySpend(90)).toBe(true);
    expect(l.remaining()).toBe(0);
    expect(l.trySpend(1)).toBe(false);
  });

  it('survives a restart rather than handing out a fresh budget', () => {
    ledger(today).trySpend(80);

    // A brand new ledger instance, as after a worker restart. The platform is
    // counting the real total; disagreeing gets the key cut off.
    expect(ledger(today).remaining()).toBe(10);
    expect(ledger(today).trySpend(50)).toBe(false);
  });

  it('starts fresh once the quota day rolls over', () => {
    let day = '2026-09-01';
    const l = ledger(() => day);

    l.trySpend(90);
    expect(l.remaining()).toBe(0);

    // YouTube resets at midnight Pacific, not UTC.
    day = '2026-09-02';
    expect(l.remaining()).toBe(90);
  });

  it('tracks platforms separately', () => {
    new m.DbQuotaLedger('youtube', 100, 10, today).trySpend(50);

    expect(new m.DbQuotaLedger('twitch', 100, 10, today).remaining()).toBe(90);
  });
});
