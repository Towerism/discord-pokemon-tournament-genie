CREATE TABLE `app_setting` (
	`id` integer PRIMARY KEY NOT NULL,
	`current_season` text NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "app_setting_single_row" CHECK("app_setting"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE `penalty` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` integer NOT NULL,
	`number` integer NOT NULL,
	`idempotency_key` text NOT NULL,
	`round` integer NOT NULL,
	`competitor_player_id` text NOT NULL,
	`category_id` integer NOT NULL,
	`severity` text NOT NULL,
	`penalty_type_id` integer NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`judge_staff_id` integer NOT NULL,
	`judge_player_id` text NOT NULL,
	`recorded_by` text NOT NULL,
	`recorded_at` integer NOT NULL,
	`state` text DEFAULT 'active' NOT NULL,
	`void_reason` text,
	`revision` integer NOT NULL,
	`discord_channel_id` text,
	`discord_message_id` text,
	`card_state` text NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `event`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`category_id`) REFERENCES `penalty_category`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`penalty_type_id`) REFERENCES `penalty_type`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`judge_staff_id`) REFERENCES `staff_member`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "penalty_round" CHECK("penalty"."round" between 1 and 99),
	CONSTRAINT "penalty_severity" CHECK("penalty"."severity" in ('Minor', 'Major', 'Severe')),
	CONSTRAINT "penalty_state" CHECK("penalty"."state" in ('active', 'voided')),
	CONSTRAINT "penalty_card_state" CHECK("penalty"."card_state" in ('pending', 'posted', 'failed', 'missing', 'none'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `penalty_idempotency_key_unique` ON `penalty` (`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `penalty_event_number` ON `penalty` (`event_id`,`number`);--> statement-breakpoint
CREATE INDEX `penalty_event_state` ON `penalty` (`event_id`,`state`);--> statement-breakpoint
CREATE TABLE `penalty_category` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`season` text NOT NULL,
	`label` text NOT NULL,
	`games` text NOT NULL,
	`rank` integer NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "penalty_category_active" CHECK("penalty_category"."active" in (0, 1))
);
--> statement-breakpoint
CREATE INDEX `penalty_category_season` ON `penalty_category` (`season`);--> statement-breakpoint
CREATE TABLE `penalty_revision` (
	`penalty_id` integer NOT NULL,
	`revision` integer NOT NULL,
	`action` text NOT NULL,
	`snapshot` text NOT NULL,
	`edited_by` text NOT NULL,
	`edited_at` integer NOT NULL,
	PRIMARY KEY(`penalty_id`, `revision`),
	FOREIGN KEY (`penalty_id`) REFERENCES `penalty`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "penalty_revision_action" CHECK("penalty_revision"."action" in ('recorded', 'edited', 'voided'))
);
--> statement-breakpoint
CREATE TABLE `penalty_type` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`season` text NOT NULL,
	`label` text NOT NULL,
	`games` text NOT NULL,
	`rank` integer NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "penalty_type_active" CHECK("penalty_type"."active" in (0, 1))
);
--> statement-breakpoint
CREATE INDEX `penalty_type_season` ON `penalty_type` (`season`);--> statement-breakpoint
ALTER TABLE `event_day` ADD `season` text DEFAULT '2026-27' NOT NULL;--> statement-breakpoint
-- Hand-written: a label is unique within its season whatever its case (drizzle-kit can't express COLLATE NOCASE).
CREATE UNIQUE INDEX `penalty_category_season_label` ON `penalty_category` (`season`, `label` COLLATE NOCASE);--> statement-breakpoint
CREATE UNIQUE INDEX `penalty_type_season_label` ON `penalty_type` (`season`, `label` COLLATE NOCASE);--> statement-breakpoint
-- Hand-written seed (§6.7): the judges' clipboard penalty sheet (2024-05) is season 2026-27, the current season.
INSERT INTO `app_setting` (`id`, `current_season`, `updated_at`) VALUES (1, '2026-27', CAST(strftime('%s', 'now') AS integer) * 1000);--> statement-breakpoint
INSERT INTO `penalty_category` (`season`, `label`, `games`, `rank`, `created_at`) VALUES
	('2026-27', 'Game Play', '["tcg","vgc","go","other"]', 0, CAST(strftime('%s', 'now') AS integer) * 1000),
	('2026-27', 'Deck/Team', '["tcg","vgc","go","other"]', 1, CAST(strftime('%s', 'now') AS integer) * 1000),
	('2026-27', 'Pace of Play', '["tcg","vgc","go","other"]', 2, CAST(strftime('%s', 'now') AS integer) * 1000),
	('2026-27', 'Procedural', '["tcg","vgc","go","other"]', 3, CAST(strftime('%s', 'now') AS integer) * 1000),
	('2026-27', 'Unsporting', '["tcg","vgc","go","other"]', 4, CAST(strftime('%s', 'now') AS integer) * 1000),
	('2026-27', 'Cheating', '["tcg","vgc","go","other"]', 5, CAST(strftime('%s', 'now') AS integer) * 1000);--> statement-breakpoint
INSERT INTO `penalty_type` (`season`, `label`, `games`, `rank`, `created_at`) VALUES
	('2026-27', 'Warning', '["tcg","vgc","go","other"]', 0, CAST(strftime('%s', 'now') AS integer) * 1000),
	('2026-27', 'DPC', '["tcg"]', 1, CAST(strftime('%s', 'now') AS integer) * 1000),
	('2026-27', 'QPC', '["tcg"]', 2, CAST(strftime('%s', 'now') AS integer) * 1000),
	('2026-27', 'GL', '["tcg","vgc","go","other"]', 3, CAST(strftime('%s', 'now') AS integer) * 1000),
	('2026-27', 'DQ', '["tcg","vgc","go","other"]', 4, CAST(strftime('%s', 'now') AS integer) * 1000);