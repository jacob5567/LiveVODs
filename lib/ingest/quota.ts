import { and, eq, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { apiBudget, type Platform } from '@/drizzle/schema';
import type { QuotaLedger } from '@/lib/connectors/types';
import { pacificDay } from '@/lib/time';

/** YouTube Data API v3 default allocation. */
export const YOUTUBE_DAILY_UNITS = 10_000;

/**
 * Stop short of the real ceiling. Hitting it mid-pass leaves the guide
 * half-updated until midnight Pacific, and the headroom keeps a manual
 * channels:sync working even after ingest has stopped for the day.
 */
export const RESERVE_UNITS = 500;

/**
 * Durable daily spend counter.
 *
 * Persisted rather than in-memory because a worker restart must not hand itself
 * a fresh 10,000 units — the platform is counting the real total, and
 * disagreeing with it is how an instance gets cut off for the rest of the day.
 */
export class DbQuotaLedger implements QuotaLedger {
  constructor(
    private readonly platform: Platform,
    private readonly dailyCap: number,
    private readonly reserve: number,
    /** Injectable so tests can cross a day boundary without waiting for one. */
    private readonly today: () => string = pacificDay,
  ) {}

  private used(day: string): number {
    const row = db
      .select({ unitsUsed: apiBudget.unitsUsed })
      .from(apiBudget)
      .where(and(eq(apiBudget.platform, this.platform), eq(apiBudget.day, day)))
      .get();
    return row?.unitsUsed ?? 0;
  }

  private budget(): number {
    return this.dailyCap - this.reserve;
  }

  remaining(): number {
    return Math.max(0, this.budget() - this.used(this.today()));
  }

  trySpend(units: number): boolean {
    const day = this.today();
    if (this.used(day) + units > this.budget()) return false;

    db.insert(apiBudget)
      .values({ platform: this.platform, day, unitsUsed: units })
      .onConflictDoUpdate({
        target: [apiBudget.platform, apiBudget.day],
        // Incremented in SQL rather than read-modify-write, so a concurrent
        // pass cannot lose a spend.
        set: { unitsUsed: sql`${apiBudget.unitsUsed} + ${units}` },
      })
      .run();

    return true;
  }
}

export function youtubeLedger(): QuotaLedger {
  return new DbQuotaLedger('youtube', YOUTUBE_DAILY_UNITS, RESERVE_UNITS);
}

/** Non-persistent ledger for tests and dry runs. */
export class MemoryQuotaLedger implements QuotaLedger {
  private used = 0;

  constructor(private readonly cap: number = YOUTUBE_DAILY_UNITS) {}

  remaining(): number {
    return Math.max(0, this.cap - this.used);
  }

  /** Units consumed so far — useful for reporting what a one-off run cost. */
  spent(): number {
    return this.used;
  }

  trySpend(units: number): boolean {
    if (this.used + units > this.cap) return false;
    this.used += units;
    return true;
  }
}
