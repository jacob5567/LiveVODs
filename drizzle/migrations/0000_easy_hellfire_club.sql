CREATE TABLE `api_budget` (
	`platform` text NOT NULL,
	`day` text NOT NULL,
	`units_used` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`platform`, `day`)
);
--> statement-breakpoint
CREATE TABLE `channel_sync_state` (
	`channel_id` integer PRIMARY KEY NOT NULL,
	`last_live_check_at` integer,
	`last_schedule_sync_at` integer,
	`last_vod_sync_at` integer,
	`youtube_uploads_playlist_id` text,
	`websub_expires_at` integer,
	`etag` text,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `channels` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`platform` text NOT NULL,
	`platform_channel_id` text NOT NULL,
	`login` text NOT NULL,
	`display_name` text NOT NULL,
	`avatar_url` text,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `channels_platform_id_idx` ON `channels` (`platform`,`platform_channel_id`);--> statement-breakpoint
CREATE TABLE `programs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`channel_id` integer NOT NULL,
	`platform_ref` text NOT NULL,
	`title` text NOT NULL,
	`category` text,
	`starts_at` integer NOT NULL,
	`ends_at` integer NOT NULL,
	`ends_at_provisional` integer DEFAULT false NOT NULL,
	`state` text NOT NULL,
	`canonical_url` text NOT NULL,
	`thumbnail_url` text,
	`vod_ref` text,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `programs_channel_ref_idx` ON `programs` (`channel_id`,`platform_ref`);--> statement-breakpoint
CREATE INDEX `programs_window_idx` ON `programs` (`starts_at`,`ends_at`);--> statement-breakpoint
CREATE INDEX `programs_state_idx` ON `programs` (`state`);