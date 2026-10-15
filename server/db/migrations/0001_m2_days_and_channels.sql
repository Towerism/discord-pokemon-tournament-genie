CREATE TABLE `blueprint` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`category_name_pattern` text NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "blueprint_default_flag" CHECK("blueprint"."is_default" in (0, 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `blueprint_name_unique` ON `blueprint` (`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `blueprint_one_default` ON `blueprint` (`is_default`) WHERE "blueprint"."is_default" = 1;--> statement-breakpoint
CREATE TABLE `blueprint_channel` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`blueprint_id` integer NOT NULL,
	`key` text NOT NULL,
	`scope` text NOT NULL,
	`kind` text NOT NULL,
	`name_pattern` text NOT NULL,
	`audience` text NOT NULL,
	`purpose` text NOT NULL,
	`topic` text,
	`position` integer NOT NULL,
	FOREIGN KEY (`blueprint_id`) REFERENCES `blueprint`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "blueprint_channel_scope" CHECK("blueprint_channel"."scope" in ('day', 'per_event')),
	CONSTRAINT "blueprint_channel_kind" CHECK("blueprint_channel"."kind" in ('text', 'voice')),
	CONSTRAINT "blueprint_channel_audience" CHECK("blueprint_channel"."audience" in ('all_staff', 'event_staff', 'head_judges')),
	CONSTRAINT "blueprint_channel_purpose" CHECK("blueprint_channel"."purpose" in ('general', 'floor', 'penalties'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `blueprint_channel_key` ON `blueprint_channel` (`blueprint_id`,`key`);--> statement-breakpoint
CREATE TABLE `day_staff` (
	`day_id` integer NOT NULL,
	`staff_member_id` integer NOT NULL,
	PRIMARY KEY(`day_id`, `staff_member_id`),
	FOREIGN KEY (`day_id`) REFERENCES `event_day`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`staff_member_id`) REFERENCES `staff_member`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE `day_template` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`blueprint_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`blueprint_id`) REFERENCES `blueprint`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `day_template_name_unique` ON `day_template` (`name`);--> statement-breakpoint
CREATE TABLE `day_template_event` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`template_id` integer NOT NULL,
	`name` text NOT NULL,
	`game` text NOT NULL,
	`start_time` text NOT NULL,
	`position` integer NOT NULL,
	FOREIGN KEY (`template_id`) REFERENCES `day_template`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "day_template_event_game" CHECK("day_template_event"."game" in ('tcg', 'vgc', 'go', 'other'))
);
--> statement-breakpoint
CREATE TABLE `event` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`day_id` integer NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`game` text NOT NULL,
	`game_confirmed` integer DEFAULT true NOT NULL,
	`starts_at` integer NOT NULL,
	`tournament_id` text,
	`position` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`day_id`) REFERENCES `event_day`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "event_game" CHECK("event"."game" in ('tcg', 'vgc', 'go', 'other')),
	CONSTRAINT "event_game_confirmed" CHECK("event"."game_confirmed" in (0, 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `event_day_slug` ON `event` (`day_id`,`slug`);--> statement-breakpoint
CREATE TABLE `event_day` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`guild_id` text NOT NULL,
	`date` text NOT NULL,
	`title` text NOT NULL,
	`blueprint_id` integer NOT NULL,
	`state` text DEFAULT 'draft' NOT NULL,
	`category_id` text,
	`plan_revision` integer DEFAULT 1 NOT NULL,
	`applied_revision` integer,
	`revoke_pending_revision` integer,
	`revoke_pending_at` integer,
	`opened_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`blueprint_id`) REFERENCES `blueprint`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "event_day_state" CHECK("event_day"."state" in ('draft', 'open', 'closing', 'closed', 'purged'))
);
--> statement-breakpoint
CREATE INDEX `event_day_state` ON `event_day` (`state`);--> statement-breakpoint
CREATE INDEX `event_day_date` ON `event_day` (`date`);--> statement-breakpoint
CREATE TABLE `event_staff` (
	`event_id` integer NOT NULL,
	`staff_member_id` integer NOT NULL,
	`role` text NOT NULL,
	PRIMARY KEY(`event_id`, `staff_member_id`),
	FOREIGN KEY (`event_id`) REFERENCES `event`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`staff_member_id`) REFERENCES `staff_member`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "event_staff_role" CHECK("event_staff"."role" in ('headjudge', 'judge', 'scorekeeper', 'administration', 'translator'))
);
--> statement-breakpoint
CREATE TABLE `orphan_channel` (
	`discord_channel_id` text PRIMARY KEY NOT NULL,
	`day_id` integer NOT NULL,
	`guild_id` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`found_at` integer NOT NULL,
	FOREIGN KEY (`day_id`) REFERENCES `event_day`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "orphan_channel_kind" CHECK("orphan_channel"."kind" in ('channel', 'category'))
);
--> statement-breakpoint
CREATE INDEX `orphan_channel_day` ON `orphan_channel` (`day_id`);--> statement-breakpoint
CREATE TABLE `provisioned_channel` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`day_id` integer NOT NULL,
	`guild_id` text NOT NULL,
	`event_id` integer,
	`blueprint_channel_key` text NOT NULL,
	`discord_channel_id` text NOT NULL,
	`applied_overwrites_hash` text NOT NULL,
	`state` text NOT NULL,
	`message_id` text,
	`message_pinned` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`day_id`) REFERENCES `event_day`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`event_id`) REFERENCES `event`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "provisioned_channel_state" CHECK("provisioned_channel"."state" in ('present', 'missing', 'deleted'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `provisioned_channel_discord_channel_id_unique` ON `provisioned_channel` (`discord_channel_id`);--> statement-breakpoint
CREATE INDEX `provisioned_channel_day` ON `provisioned_channel` (`day_id`);--> statement-breakpoint
CREATE TABLE `staff_member` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`display_name` text NOT NULL,
	`player_id` text,
	`discord_user_id` text,
	`claimed_discord_user_id` text,
	`claimed_at` integer,
	`created_by_claim` integer DEFAULT false NOT NULL,
	`link_state` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "staff_member_link_state" CHECK("staff_member"."link_state" in ('unlinked', 'claimed', 'linked')),
	CONSTRAINT "staff_member_link_consistent" CHECK(("staff_member"."link_state" = 'linked' and "staff_member"."discord_user_id" is not null and "staff_member"."claimed_discord_user_id" is null)
       or ("staff_member"."link_state" = 'claimed' and "staff_member"."discord_user_id" is null and "staff_member"."claimed_discord_user_id" is not null)
       or ("staff_member"."link_state" = 'unlinked' and "staff_member"."discord_user_id" is null and "staff_member"."claimed_discord_user_id" is null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `staff_member_player_id_unique` ON `staff_member` (`player_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `staff_member_discord_user_id_unique` ON `staff_member` (`discord_user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `staff_member_claimed_discord_user_id_unique` ON `staff_member` (`claimed_discord_user_id`);--> statement-breakpoint
-- Hand-edited: the migrator runs inside a transaction, where PRAGMA foreign_keys=OFF does nothing, so dropping
-- `job` would cascade-delete every `job_event` row. They are copied aside and put back after the rebuild
-- (tested in server/db/migrations.test.ts).
CREATE TABLE `__job_event_backup` AS SELECT * FROM `job_event`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_job` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`state` text NOT NULL,
	`day_id` integer,
	`payload` text,
	`due_at` integer,
	`attempts` integer DEFAULT 0 NOT NULL,
	`error` text,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	FOREIGN KEY (`day_id`) REFERENCES `event_day`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "job_kind" CHECK("__new_job"."kind" in ('provision', 'sync', 'lock', 'export', 'reexport', 'attachments_retry', 'purge', 'retention_sweep', 'attendance_import')),
	CONSTRAINT "job_state" CHECK("__new_job"."state" in ('queued', 'running', 'succeeded', 'failed', 'interrupted'))
);
--> statement-breakpoint
INSERT INTO `__new_job`("id", "kind", "state", "day_id", "payload", "due_at", "attempts", "error", "created_at", "started_at", "finished_at") SELECT "id", "kind", "state", "day_id", "payload", "due_at", "attempts", "error", "created_at", "started_at", "finished_at" FROM `job`;--> statement-breakpoint
DROP TABLE `job`;--> statement-breakpoint
ALTER TABLE `__new_job` RENAME TO `job`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `job_state_due` ON `job` (`state`,`due_at`);--> statement-breakpoint
CREATE INDEX `job_day_state` ON `job` (`day_id`,`state`);--> statement-breakpoint
INSERT INTO `job_event` SELECT * FROM `__job_event_backup` WHERE `id` NOT IN (SELECT `id` FROM `job_event`);--> statement-breakpoint
DROP TABLE `__job_event_backup`;--> statement-breakpoint
-- Hand-written: one present channel per day, event and key. An expression index drizzle-kit can't express; covered
-- by server/db/migrations.test.ts ("allows one present channel per day, event and key").
CREATE UNIQUE INDEX `provisioned_channel_present_key` ON `provisioned_channel` (`day_id`, COALESCE(`event_id`, 0), `blueprint_channel_key`) WHERE `state` = 'present';--> statement-breakpoint
-- Hand-written: the default blueprint of §6.2 (shared/blueprints DEFAULT_BLUEPRINT).
INSERT INTO `blueprint` (`id`, `name`, `category_name_pattern`, `is_default`, `created_at`, `updated_at`) VALUES (1, 'Standard day', '🏆 {weekday} {date} · {title}', 1, 0, 0);--> statement-breakpoint
INSERT INTO `blueprint_channel` (`blueprint_id`, `key`, `scope`, `kind`, `name_pattern`, `audience`, `purpose`, `topic`, `position`) VALUES
  (1, 'day-staff', 'day', 'text', 'day-staff', 'all_staff', 'general', NULL, 0),
  (1, 'head-judges', 'day', 'text', 'head-judges', 'head_judges', 'general', NULL, 1),
  (1, 'floor', 'per_event', 'text', '{slug}-floor', 'event_staff', 'floor', NULL, 2),
  (1, 'penalties', 'per_event', 'text', '{slug}-penalties', 'event_staff', 'penalties', NULL, 3);