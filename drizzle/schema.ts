import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

export const PLATFORMS = ['twitch', 'youtube'] as const;
export type Platform = (typeof PLATFORMS)[number];

/**
 * A channel in the lineup. Rows are seeded from config/channels.yml; nothing
 * here is user-generated, since the app has no login.
 */
export const channels = sqliteTable(
  'channels',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    platform: text('platform', { enum: PLATFORMS }).notNull(),
    /** Twitch broadcaster id / YouTube channel id (UC...). Stable across renames. */
    platformChannelId: text('platform_channel_id').notNull(),
    /** Twitch login / YouTube handle. Used to build URLs and embeds. */
    login: text('login').notNull(),
    displayName: text('display_name').notNull(),
    avatarUrl: text('avatar_url'),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [uniqueIndex('channels_platform_id_idx').on(t.platform, t.platformChannelId)],
);

export const PROGRAM_STATES = ['scheduled', 'live', 'aired', 'missed'] as const;
export type ProgramState = (typeof PROGRAM_STATES)[number];

/**
 * One bar on the guide grid.
 *
 * Every row has both a start and an end so it can be laid out on a time axis,
 * but `endsAtProvisional` marks the rows whose end is a guess because the
 * broadcast is still running. See lib/ingest/reconcile.ts for the state machine.
 */
export const programs = sqliteTable(
  'programs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    channelId: integer('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    /**
     * Identity of this broadcast on the platform: a Twitch schedule segment id
     * before it airs, rebound to the Twitch stream id once it goes live, or a
     * YouTube video id. Unique per channel, which is what makes ingest idempotent
     * when poll and push both deliver the same event.
     */
    platformRef: text('platform_ref').notNull(),
    title: text('title').notNull(),
    category: text('category'),
    startsAt: integer('starts_at', { mode: 'timestamp_ms' }).notNull(),
    endsAt: integer('ends_at', { mode: 'timestamp_ms' }).notNull(),
    endsAtProvisional: integer('ends_at_provisional', { mode: 'boolean' })
      .notNull()
      .default(false),
    state: text('state', { enum: PROGRAM_STATES }).notNull(),
    canonicalUrl: text('canonical_url').notNull(),
    thumbnailUrl: text('thumbnail_url'),
    /** Playable id for an aired program: Twitch video id or YouTube video id. */
    vodRef: text('vod_ref'),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    uniqueIndex('programs_channel_ref_idx').on(t.channelId, t.platformRef),
    // The guide always queries "everything overlapping [from, to]".
    index('programs_window_idx').on(t.startsAt, t.endsAt),
    index('programs_state_idx').on(t.state),
  ],
);

/** Per-channel bookkeeping so the poller knows what is stale. */
export const channelSyncState = sqliteTable('channel_sync_state', {
  channelId: integer('channel_id')
    .primaryKey()
    .references(() => channels.id, { onDelete: 'cascade' }),
  lastLiveCheckAt: integer('last_live_check_at', { mode: 'timestamp_ms' }),
  lastScheduleSyncAt: integer('last_schedule_sync_at', { mode: 'timestamp_ms' }),
  lastVodSyncAt: integer('last_vod_sync_at', { mode: 'timestamp_ms' }),
  /** YouTube uploads playlist id — derived once, then cached forever (saves a unit per poll). */
  youtubeUploadsPlaylistId: text('youtube_uploads_playlist_id'),
  websubExpiresAt: integer('websub_expires_at', { mode: 'timestamp_ms' }),
  etag: text('etag'),
});

/**
 * Daily API spend, keyed by the platform's own reset day. YouTube allows 10,000
 * units/day resetting at midnight America/Los_Angeles, and blowing through it
 * takes the whole app offline until the reset — so the connector checks here
 * before every call.
 */
export const apiBudget = sqliteTable(
  'api_budget',
  {
    platform: text('platform', { enum: PLATFORMS }).notNull(),
    /** YYYY-MM-DD in the platform's reset timezone. */
    day: text('day').notNull(),
    unitsUsed: integer('units_used').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.platform, t.day] })],
);

export type ChannelRow = typeof channels.$inferSelect;
export type NewChannelRow = typeof channels.$inferInsert;
export type ProgramDbRow = typeof programs.$inferSelect;
export type NewProgramDbRow = typeof programs.$inferInsert;
