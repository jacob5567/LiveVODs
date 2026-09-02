CREATE TABLE `subject_channels` (
	`subject_id` integer NOT NULL,
	`channel_id` integer NOT NULL,
	PRIMARY KEY(`subject_id`, `channel_id`),
	FOREIGN KEY (`subject_id`) REFERENCES `subjects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `subjects` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `subjects_name_idx` ON `subjects` (`name`);--> statement-breakpoint
ALTER TABLE `programs` ADD `is_upload` integer DEFAULT false NOT NULL;