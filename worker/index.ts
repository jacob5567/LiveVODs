/**
 * Ingest worker — the sole writer to the database.
 *
 * Runs as its own process rather than inside Next.js: server routes are
 * request-scoped, and an in-process interval would double-run under dev HMR and
 * fan out incorrectly the moment the web tier runs more than one instance.
 */
import { loadEnv } from '@/lib/env';

async function main(): Promise<void> {
  // Must happen before lib/db is imported: it resolves DATABASE_PATH at module
  // load time, so a static import would read the env before .env is applied.
  loadEnv();

  const { db, DATABASE_PATH } = await import('@/lib/db');
  const { TwitchConnector } = await import('@/lib/connectors/twitch');
  const { YouTubeConnector } = await import('@/lib/connectors/youtube');
  const { youtubeLedger } = await import('@/lib/ingest/quota');
  const { startPoller } = await import('@/lib/ingest/poller');
  const { closeUntrackedPrograms } = await import('@/lib/ingest/persist');
  const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');

  migrate(db, { migrationsFolder: './drizzle/migrations' });

  // A channel dropped from the lineup while this was not running left its
  // broadcasts open, and nothing polls it now to close them.
  const closed = closeUntrackedPrograms();
  if (closed > 0) console.log(`closed ${closed} broadcast(s) on channels no longer polled`);

  const quota = youtubeLedger();
  const connectors = [TwitchConnector.fromEnv(), YouTubeConnector.fromEnv(quota)].filter(
    (c) => c !== null,
  );

  if (connectors.length === 0) {
    console.error(
      'No connectors configured. Copy .env.example to .env and set\n' +
        'TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET, or YOUTUBE_API_KEY, or run\n' +
        '`npx tsx scripts/seed-demo.ts` to work against fixtures instead.',
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `worker starting → ${DATABASE_PATH}\n` +
      `connectors: ${connectors.map((c) => c.platform).join(', ')}` +
      (connectors.some((c) => c.platform === 'youtube')
        ? `\nyoutube quota remaining today: ${quota.remaining()} units`
        : ''),
  );

  const stop = startPoller(connectors, quota);

  let shuttingDown = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`\n${signal} — stopping poller`);
      stop();
      process.exit(0);
    });
  }
}

main().catch((error) => {
  console.error('worker failed to start:', error);
  process.exit(1);
});
