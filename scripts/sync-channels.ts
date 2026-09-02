/**
 * Reconciles config/channels.yml into the subjects and channels tables.
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
import type { Platform } from '@/drizzle/schema';
import type { ResolvedChannel } from '@/lib/connectors/types';

loadEnv();

const DRY_RUN = process.argv.includes('--dry-run');
const CONFIG_PATH = 'config/channels.yml';
const EXAMPLE_PATH = 'config/channels.example.yml';

interface SubjectConfig {
  name: string;
  twitch?: string[];
  youtube?: string[];
}

interface ChannelsConfig {
  subjects?: SubjectConfig[];
}

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

function parseConfig(raw: string): SubjectConfig[] {
  const config = parse(raw) as ChannelsConfig | null;

  if (!config?.subjects) {
    // The format changed from flat twitch:/youtube: lists to subjects.
    const legacy = config as { twitch?: unknown; youtube?: unknown } | null;
    if (legacy?.twitch || legacy?.youtube) {
      console.error(
        `${CONFIG_PATH} uses the old flat format. Each row of the guide is now a\n` +
          `subject pooling several channels. Wrap your lists like this:\n\n` +
          `  subjects:\n    - name: Speedrunning\n      twitch:\n        - GamesDoneQuick\n` +
          `      youtube:\n        - "@SimpleFlips"\n\n` +
          `See ${EXAMPLE_PATH}.\n`,
      );
      process.exit(1);
    }
    console.error(`${CONFIG_PATH} has no subjects. See ${EXAMPLE_PATH}.`);
    process.exit(1);
  }

  for (const [i, subject] of config.subjects.entries()) {
    if (!subject?.name) {
      console.error(`${CONFIG_PATH}: subject #${i + 1} has no name.`);
      process.exit(1);
    }
  }

  return config.subjects;
}

async function main(): Promise<void> {
  // Imported lazily so loadEnv() runs before lib/db resolves DATABASE_PATH.
  const { db } = await import('@/lib/db');
  const { channels, subjects, subjectChannels } = await import('@/drizzle/schema');
  const { TwitchConnector } = await import('@/lib/connectors/twitch');
  const { YouTubeConnector } = await import('@/lib/connectors/youtube');
  const { MemoryQuotaLedger } = await import('@/lib/ingest/quota');
  const { and, eq, notInArray } = await import('drizzle-orm');
  const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');

  migrate(db, { migrationsFolder: './drizzle/migrations' });

  const configured = parseConfig(readConfig());

  // A memory ledger: a sync is a one-off and should not eat into the worker's
  // persisted daily budget.
  const quota = new MemoryQuotaLedger();
  const twitch = TwitchConnector.fromEnv();
  const youtube = YouTubeConnector.fromEnv(quota);

  // Resolve every identifier once, even where several subjects share a channel.
  const wanted: Record<Platform, Set<string>> = { twitch: new Set(), youtube: new Set() };
  for (const subject of configured) {
    for (const login of subject.twitch ?? []) wanted.twitch.add(login);
    for (const handle of subject.youtube ?? []) wanted.youtube.add(handle);
  }

  console.log(
    `${CONFIG_PATH}: ${configured.length} subjects, ` +
      `${wanted.twitch.size} twitch + ${wanted.youtube.size} youtube channels` +
      (DRY_RUN ? '  [dry run — nothing will be written]' : ''),
  );

  const resolved: Record<Platform, Map<string, ResolvedChannel>> = {
    twitch: new Map(),
    youtube: new Map(),
  };
  let missing = 0;

  for (const [platform, connector, hint] of [
    ['twitch', twitch, 'TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET not set'],
    ['youtube', youtube, 'YOUTUBE_API_KEY not set'],
  ] as const) {
    const identifiers = [...wanted[platform]];
    if (identifiers.length === 0) continue;

    if (!connector) {
      console.error(`\n  ${platform}: skipped — ${hint}`);
      missing += identifiers.length;
      continue;
    }

    resolved[platform] = await connector.resolveChannels(identifiers);
    console.log(`\n  ${platform}: resolved ${resolved[platform].size}/${identifiers.length}`);

    for (const id of identifiers) {
      if (!resolved[platform].has(id.toLowerCase())) {
        console.log(`    ✗ ${id} — not found (typo, renamed, or removed)`);
        missing += 1;
      }
    }
  }

  /** Upsert a channel and return its row id. */
  const upsertChannel = (platform: Platform, channel: ResolvedChannel): number => {
    const existing = db
      .select({ id: channels.id })
      .from(channels)
      .where(
        and(eq(channels.platform, platform), eq(channels.platformChannelId, channel.platformChannelId)),
      )
      .get();

    if (DRY_RUN) return existing?.id ?? -1;

    const [row] = db
      .insert(channels)
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
      .returning({ id: channels.id })
      .all();

    return row.id;
  };

  const keptSubjectIds: number[] = [];

  for (const [position, subject] of configured.entries()) {
    const members: Array<{ platform: Platform; channel: ResolvedChannel }> = [];
    for (const login of subject.twitch ?? []) {
      const c = resolved.twitch.get(login.toLowerCase());
      if (c) members.push({ platform: 'twitch', channel: c });
    }
    for (const handle of subject.youtube ?? []) {
      const c = resolved.youtube.get(handle.toLowerCase());
      if (c) members.push({ platform: 'youtube', channel: c });
    }

    console.log(`\n  ${subject.name}  (${members.length} channels)`);
    for (const m of members) {
      console.log(`    ✓ ${m.platform.padEnd(8)} ${m.channel.displayName}`);
    }

    if (DRY_RUN) continue;

    const [subjectRow] = db
      .insert(subjects)
      .values({ name: subject.name, position })
      .onConflictDoUpdate({ target: subjects.name, set: { position } })
      .returning({ id: subjects.id })
      .all();

    keptSubjectIds.push(subjectRow.id);

    const channelIds = members.map((m) => upsertChannel(m.platform, m.channel));

    // Membership mirrors the config exactly, so removing a channel from a
    // subject in the file removes it from that row here.
    if (channelIds.length > 0) {
      db.delete(subjectChannels)
        .where(
          and(
            eq(subjectChannels.subjectId, subjectRow.id),
            notInArray(subjectChannels.channelId, channelIds),
          ),
        )
        .run();

      for (const channelId of channelIds) {
        db.insert(subjectChannels)
          .values({ subjectId: subjectRow.id, channelId })
          .onConflictDoNothing()
          .run();
      }
    } else {
      db.delete(subjectChannels).where(eq(subjectChannels.subjectId, subjectRow.id)).run();
    }
  }

  // Subjects dropped from the config stop being rows. Channels are left alone:
  // their programs stay, and re-adding the subject picks them straight back up.
  if (!DRY_RUN) {
    const removed =
      keptSubjectIds.length > 0
        ? db.delete(subjects).where(notInArray(subjects.id, keptSubjectIds)).run()
        : db.delete(subjects).run();
    if (removed.changes > 0) console.log(`\n  removed ${removed.changes} subject(s) no longer in config`);
  }

  const orphans = DRY_RUN
    ? []
    : db
        .select({ id: channels.id, displayName: channels.displayName })
        .from(channels)
        .where(
          notInArray(
            channels.id,
            db.select({ id: subjectChannels.channelId }).from(subjectChannels),
          ),
        )
        .all();

  console.log(
    `\n${DRY_RUN ? 'would sync' : 'synced'}: ${configured.length} subjects, ` +
      `${resolved.twitch.size + resolved.youtube.size} channels, ${missing} unresolved` +
      (quota.spent() > 0 ? `  (youtube quota used: ${quota.spent()} units)` : ''),
  );

  if (orphans.length > 0) {
    console.log(
      `\n${orphans.length} channel(s) belong to no subject and are no longer polled:\n` +
        orphans.map((o) => `  ${o.displayName}`).join('\n') +
        `\nTheir programs are kept. Add them to a subject to bring them back.`,
    );
  }
}

main().catch((error) => {
  console.error('sync failed:', error);
  process.exit(1);
});
