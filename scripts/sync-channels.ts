/**
 * Reconciles config/channels.yml into the channels table.
 *
 *   npm run channels:sync -- --dry-run   # hit the APIs, write nothing
 *   npm run channels:sync                # apply
 *
 * Identifiers in the config are resolved to stable platform ids, so a channel
 * that later renames itself keeps its programs.
 */
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { loadEnv } from '@/lib/env';

loadEnv();

const DRY_RUN = process.argv.includes('--dry-run');
const CONFIG_PATH = 'config/channels.yml';
const EXAMPLE_PATH = 'config/channels.example.yml';

/** channels.yml is gitignored, so a fresh clone will not have one yet. */
function readConfig(): string {
  try {
    return readFileSync(CONFIG_PATH, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    console.error(
      `No ${CONFIG_PATH}. It holds your own lineup and is gitignored, so start from the example:\n\n` +
        `  cp ${EXAMPLE_PATH} ${CONFIG_PATH}\n`,
    );
    process.exit(1);
  }
}

interface ChannelsConfig {
  twitch?: string[];
  youtube?: string[];
}

async function main(): Promise<void> {
  // Imported lazily so loadEnv() runs before lib/db resolves DATABASE_PATH.
  const { db } = await import('@/lib/db');
  const { channels } = await import('@/drizzle/schema');
  const { TwitchConnector } = await import('@/lib/connectors/twitch');
  const { YouTubeConnector } = await import('@/lib/connectors/youtube');
  const { MemoryQuotaLedger } = await import('@/lib/ingest/quota');
  const { and, eq } = await import('drizzle-orm');
  const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');

  migrate(db, { migrationsFolder: './drizzle/migrations' });

  const config = parse(readConfig()) as ChannelsConfig | null;

  // A memory ledger: a sync is a one-off and should not eat into the worker's
  // persisted daily budget.
  const quota = new MemoryQuotaLedger();

  const platforms = [
    {
      platform: 'twitch' as const,
      identifiers: config?.twitch ?? [],
      connector: TwitchConnector.fromEnv(),
      missingHint: 'TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET not set',
    },
    {
      platform: 'youtube' as const,
      identifiers: config?.youtube ?? [],
      connector: YouTubeConnector.fromEnv(quota),
      missingHint: 'YOUTUBE_API_KEY not set',
    },
  ];

  console.log(
    `${CONFIG_PATH}: ` +
      platforms.map((p) => `${p.identifiers.length} ${p.platform}`).join(', ') +
      (DRY_RUN ? '  [dry run — nothing will be written]' : ''),
  );

  let inserted = 0;
  let updated = 0;
  let missing = 0;

  for (const { platform, identifiers, connector, missingHint } of platforms) {
    if (identifiers.length === 0) continue;

    if (!connector) {
      console.error(`\n  ${platform}: skipped — ${missingHint}`);
      missing += identifiers.length;
      continue;
    }

    const found = await connector.resolveChannels(identifiers);
    console.log(`\n  ${platform}: resolved ${found.size}/${identifiers.length}`);

    for (const identifier of identifiers) {
      const channel = found.get(identifier.toLowerCase());

      if (!channel) {
        console.log(`    ✗ ${identifier} — not found (typo, renamed, or removed)`);
        missing += 1;
        continue;
      }

      const exists = db
        .select({ id: channels.id })
        .from(channels)
        .where(
          and(
            eq(channels.platform, platform),
            eq(channels.platformChannelId, channel.platformChannelId),
          ),
        )
        .get();

      if (exists) updated += 1;
      else inserted += 1;

      console.log(
        `    ✓ ${channel.displayName.padEnd(24)} ${channel.platformChannelId.padEnd(26)} ` +
          `${exists ? 'update' : 'insert'}`,
      );

      if (DRY_RUN) continue;

      db.insert(channels)
        .values({
          platform,
          platformChannelId: channel.platformChannelId,
          login: channel.login,
          displayName: channel.displayName,
          avatarUrl: channel.avatarUrl,
          enabled: true,
        })
        .onConflictDoUpdate({
          target: [channels.platform, channels.platformChannelId],
          // Deliberately does not touch `enabled`: a channel disabled by hand
          // stays disabled across syncs.
          set: {
            login: channel.login,
            displayName: channel.displayName,
            avatarUrl: channel.avatarUrl,
          },
        })
        .run();
    }
  }

  console.log(
    `\n${DRY_RUN ? 'would apply' : 'applied'}: ${inserted} new, ${updated} existing, ` +
      `${missing} unresolved` +
      (quota.spent() > 0 ? `  (youtube quota used: ${quota.spent()} units)` : ''),
  );
}

main().catch((error) => {
  console.error('sync failed:', error);
  process.exit(1);
});
