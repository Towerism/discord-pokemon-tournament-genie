CREATE TABLE `attendance_connection` (
	`id` integer PRIMARY KEY NOT NULL,
	`base_url` text NOT NULL,
	`token_hint` text NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "attendance_connection_single_row" CHECK("attendance_connection"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE `attendance_snapshot` (
	`day_id` integer PRIMARY KEY NOT NULL,
	`snapshot_id` text NOT NULL,
	`payload` text NOT NULL,
	`plan_revision` integer NOT NULL,
	`day_state` text NOT NULL,
	`fetched_at` integer NOT NULL,
	`fetched_by` text NOT NULL,
	FOREIGN KEY (`day_id`) REFERENCES `event_day`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "attendance_snapshot_day_state" CHECK("attendance_snapshot"."day_state" in ('draft', 'open'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `attendance_snapshot_snapshot_id_unique` ON `attendance_snapshot` (`snapshot_id`);--> statement-breakpoint
-- `sealed_secret` is rebuilt for its new CHECK. No table refers to it, so the drop cascades nowhere.
CREATE TABLE `__new_sealed_secret` (
	`name` text PRIMARY KEY NOT NULL,
	`ciphertext` blob NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "sealed_secret_name" CHECK("__new_sealed_secret"."name" in ('discord_bot_token', 'discord_client_secret', 'attendance_token'))
);
--> statement-breakpoint
INSERT INTO `__new_sealed_secret`("name", "ciphertext", "updated_at") SELECT "name", "ciphertext", "updated_at" FROM `sealed_secret`;--> statement-breakpoint
DROP TABLE `sealed_secret`;--> statement-breakpoint
ALTER TABLE `__new_sealed_secret` RENAME TO `sealed_secret`;--> statement-breakpoint
-- Hand-edited: drizzle-kit rebuilt `event_day`, `day_staff` and `event_staff` for their new CHECKs. The migrator
-- runs inside a transaction, where PRAGMA foreign_keys=OFF does nothing, so dropping `event_day` would cascade-delete
-- every event and its staff. The columns are added in place with column CHECKs instead (same constraint names), so
-- nothing is rebuilt (tested in server/db/migrations.test.ts, "keeps M2 days, events and staff").
ALTER TABLE `event_day` ADD `source` text DEFAULT 'manual' NOT NULL CONSTRAINT "event_day_source" CHECK(`source` in ('manual', 'attendance'));--> statement-breakpoint
ALTER TABLE `event_day` ADD `attendance_refreshed_at` integer;--> statement-breakpoint
ALTER TABLE `event` ADD `attendance_tournament_id` text;--> statement-breakpoint
ALTER TABLE `event` ADD `attendance_organizer_player_id` text;--> statement-breakpoint
ALTER TABLE `event` ADD `attendance_organizer_name` text;--> statement-breakpoint
CREATE UNIQUE INDEX `event_day_tournament` ON `event` (`day_id`,`attendance_tournament_id`) WHERE "event"."attendance_tournament_id" is not null;--> statement-breakpoint
ALTER TABLE `day_staff` ADD `imported` integer DEFAULT false NOT NULL CONSTRAINT "day_staff_imported" CHECK(`imported` in (0, 1));--> statement-breakpoint
ALTER TABLE `event_staff` ADD `imported` integer DEFAULT false NOT NULL CONSTRAINT "event_staff_imported" CHECK(`imported` in (0, 1));
