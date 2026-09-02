/**
 * What is actually in the database right now.
 *
 *   npm run status
 *
 * Answers the questions you have after a first sync: did the channels resolve,
 * is the worker ingesting, is anything live, and how much YouTube quota has
 * been spent today.
 */
import { loadEnv } from '@/lib/env';

async function main(): Promise<void> {
  loadEnv();

  const { db, DATABASE_PATH } = await import('@/lib/db');
  const { channels, programs, channelSyncState, apiBudget } = await import('@/drizzle/schema');
  const { and, eq, sql } = await import('drizzle-orm');
  const { pacificDay } = await import('@/lib/time');

  console.log(`database: ${DATABASE_PATH}\n`);

  const rows = db.select().from(channels).orderBy(channels.platform, channels.displayName).all();
  const fixtures = rows.filter((c) => c.platformChannelId.startsWith('demo-'));

  if (rows.length === 0) {
    console.log('No channels. Run: npm run channels:sync');
    return;
  }

  console.log(
    `channels: ${rows.length}` +
      (fixtures.length ? `  (${fixtures.length} are demo fixtures, not polled)` : ''),
  );

  const counts = (channelId: number) =>
    Object.fromEntries(
      db
        .select({ state: programs.state, n: sql<number>`count(*)` })
        .from(programs)
        .where(eq(programs.channelId, channelId))
        .groupBy(programs.state)
        .all()
        .map((r) => [r.state, r.n]),
    ) as Partial<Record<string, number>>;

  for (const channel of rows) {
    const c = counts(channel.id);
    const sync = db
      .select()
      .from(channelSyncState)
      .where(eq(channelSyncState.channelId, channel.id))
      .get();

    const parts = [
      c.live ? `LIVE ${c.live}` : null,
      c.scheduled ? `scheduled ${c.scheduled}` : null,
      c.aired ? `aired ${c.aired}` : null,
      c.missed ? `missed ${c.missed}` : null,
    ].filter(Boolean);

    console.log(
      `  ${channel.platform.padEnd(8)} ${channel.displayName.slice(0, 24).padEnd(24)} ` +
        `${(parts.join(', ') || 'no programs yet').padEnd(38)}` +
        `${sync?.lastLiveCheckAt ? `checked ${sync.lastLiveCheckAt.toLocaleTimeString()}` : 'never checked'}`,
    );
  }

  const total = db
    .select({ state: programs.state, n: sql<number>`count(*)` })
    .from(programs)
    .groupBy(programs.state)
    .all();

  console.log(
    `\nprograms: ${total.map((r) => `${r.state} ${r.n}`).join(', ') || 'none'}`,
  );

  const budget = db
    .select()
    .from(apiBudget)
    .where(and(eq(apiBudget.platform, 'youtube'), eq(apiBudget.day, pacificDay())))
    .get();

  console.log(
    `youtube quota today: ${budget?.unitsUsed ?? 0} / 10000 units used (Pacific day ${pacificDay()})`,
  );

  const neverChecked = rows.filter(
    (c) =>
      !c.platformChannelId.startsWith('demo-') &&
      !db
        .select()
        .from(channelSyncState)
        .where(eq(channelSyncState.channelId, c.id))
        .get()?.lastLiveCheckAt,
  );

  if (neverChecked.length > 0) {
    console.log(
      `\n${neverChecked.length} real channel(s) never polled — is the worker running? (npm run worker)`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
