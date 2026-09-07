ALTER TABLE `channel_sync_state` ADD `series_synced_at` integer;--> statement-breakpoint
ALTER TABLE `programs` ADD `series_id` text;--> statement-breakpoint
ALTER TABLE `programs` ADD `series_title` text;