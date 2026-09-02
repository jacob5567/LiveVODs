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

interface ChannelsConfig {
  twitch?: string[];
  youtube?: string[];
}

async function main(): Promise<void> {
  // Imported lazily so loadEnv() runs before lib/db resolves DATABASE_PATH.
  const { db } = await import('@/lib/db');
  const { channels } = await import('@/drizzle/schema');
  const { TwitchConnector } = await import('@/lib/connectors/twitch');
  const { and, eq } = await import('drizzle-orm');

  const config = parse(readFileSync(CONFIG_PATH, 'utf8')) as ChannelsConfig | null;
  const twitchLogins = config?.twitch ?? [];
  const youtubeHandles = config?.youtube ?? [];

  console.log(
    `${CONFIG_PATH}: ${twitchLogins.length} twitch, ${youtubeHandles.length} youtube` +
      (DRY_RUN ? '  [dry run — nothing will be written]' : ''),
  );

  let resolved = 0;
  let missing = 0;
  let inserted = 0;
  let updated = 0;

  if (twitchLogins.length > 0) {
    const twitch = TwitchConnector.fromEnv();

    if (!twitch) {
      console.error('\n  twitch: skipped — TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET not set');
      missing += twitchLogins.length;
    } else {
      const found = await twitch.resolveChannels(twitchLogins);
      console.log(`\n  twitch: resolved ${found.size}/${twitchLogins.length}`);

      for (const login of twitchLogins) {
        const channel = found.get(login.toLowerCase());

        if (!channel) {
          console.log(`    ✗ ${login} — no such channel (typo, renamed, or banned)`);
          missing += 1;
          continue;
        }

        resolved += 1;
        const existing = db
          .select({ id: channels.id, login: channels.login })
          .from(channels)
          .where(
            and(
              eq(channels.platform, 'twitch'),
              eq(channels.platformChannelId, channel.platformChannelId),
            ),
          )
          .get();

        const action = existing ? 'update' : 'insert';
        if (action === 'insert') inserted += 1;
        else updated += 1;

        console.log(
          `    ✓ ${channel.displayName.padEnd(22)} id=${channel.platformChannelId.padEnd(12)} ${action}`,
        );

        if (DRY_RUN) continue;

        db.insert(channels)
          .values({
            platform: 'twitch',
            platformChannelId: channel.platformChannelId,
            login: channel.login,
            displayName: channel.displayName,
            avatarUrl: channel.avatarUrl,
            enabled: true,
          })
          .onConflictDoUpdate({
            target: [channels.platform, channels.platformChannelId],
            set: {
              login: channel.login,
              displayName: channel.displayName,
              avatarUrl: channel.avatarUrl,
            },
          })
          .run();
      }
    }
  }

  if (youtubeHandles.length > 0) {
    // The YouTube connector arrives in milestone 6.
    console.log(`\n  youtube: ${youtubeHandles.length} entries skipped — connector not built yet`);
  }

  console.log(
    `\n${DRY_RUN ? 'would apply' : 'applied'}: ${inserted} new, ${updated} existing, ` +
      `${resolved} resolved, ${missing} unresolved`,
  );
}

main().catch((error) => {
  console.error('sync failed:', error);
  process.exit(1);
});
